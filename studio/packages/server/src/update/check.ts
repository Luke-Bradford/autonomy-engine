import { BuildInfoSchema, type BuildInfo, type UpdateStatus } from '@autonomy-studio/shared';
import { DEV_VERSION } from '../build-info.js';

/** Where the published manifest lives. Overridable for tests and forks. */
export const LATEST_MANIFEST_URL =
  process.env.STUDIO_LATEST_MANIFEST_URL ??
  'https://github.com/Luke-Bradford/autonomy-engine/releases/latest/download/manifest.json';

type FetchImpl = (url: string, init?: { signal: AbortSignal }) => Promise<Response>;

/**
 * This endpoint is polled by the chrome of every page, so a blackholed
 * github.com must not hold the request open for undici's 300s default —
 * bounded the same way `github-host.ts`'s `request()` bounds its calls, via an
 * `AbortController` timeout threaded into `fetch` as `signal`. 10s is generous
 * for a small static-file GET (the manifest is a few bytes of JSON) while
 * still being far shorter than a page load should ever wait on a purely
 * informational check.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Compare the running build against the published one.
 *
 * Runs SERVER-SIDE, not in the browser: it avoids a cross-origin request from the
 * app, and it is where a token would go if the release ever becomes private —
 * neither of which would be true if the page fetched GitHub directly.
 */
export async function checkForUpdate(
  current: BuildInfo,
  fetchImpl: FetchImpl = (url, init) => fetch(url, init),
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<UpdateStatus> {
  const unknown: UpdateStatus = { current, latest: null, updateAvailable: false, notes: null };
  // A dev build has no meaningful version to compare, and its placeholder differs
  // from every release — without this it would show the banner forever.
  if (current.version === DEV_VERSION) return unknown;

  let latest: BuildInfo;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // A hang lands here the same way a network error does: `fetch` rejects
    // once the timeout aborts the signal, so both fall into the existing
    // "could not check" path — never a wrong answer.
    const res = await fetchImpl(LATEST_MANIFEST_URL, { signal: controller.signal });
    if (!res.ok) return unknown;
    const parsed = BuildInfoSchema.safeParse(await res.json());
    if (!parsed.success) return unknown;
    latest = parsed.data;
  } catch {
    return unknown;
  } finally {
    clearTimeout(timer);
  }

  return {
    current,
    latest,
    updateAvailable: latest.version !== current.version,
    notes: null,
  };
}
