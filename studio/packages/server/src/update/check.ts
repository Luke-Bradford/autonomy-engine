import { BuildInfoSchema, type BuildInfo, type UpdateStatus } from '@autonomy-studio/shared';
import { DEV_VERSION } from '../build-info.js';

/** Where the published manifest lives. Overridable for tests and forks. */
export const LATEST_MANIFEST_URL =
  process.env.STUDIO_LATEST_MANIFEST_URL ??
  'https://github.com/Luke-Bradford/autonomy-engine/releases/latest/download/manifest.json';

type FetchImpl = (url: string) => Promise<Response>;

/**
 * Compare the running build against the published one.
 *
 * Runs SERVER-SIDE, not in the browser: it avoids a cross-origin request from the
 * app, and it is where a token would go if the release ever becomes private —
 * neither of which would be true if the page fetched GitHub directly.
 */
export async function checkForUpdate(
  current: BuildInfo,
  fetchImpl: FetchImpl = (url) => fetch(url),
): Promise<UpdateStatus> {
  const unknown: UpdateStatus = { current, latest: null, updateAvailable: false, notes: null };
  // A dev build has no meaningful version to compare, and its placeholder differs
  // from every release — without this it would show the banner forever.
  if (current.version === DEV_VERSION) return unknown;

  let latest: BuildInfo;
  try {
    const res = await fetchImpl(LATEST_MANIFEST_URL);
    if (!res.ok) return unknown;
    const parsed = BuildInfoSchema.safeParse(await res.json());
    if (!parsed.success) return unknown;
    latest = parsed.data;
  } catch {
    return unknown;
  }

  return {
    current,
    latest,
    updateAvailable: latest.version !== current.version,
    notes: null,
  };
}
