import { execFile } from 'node:child_process';
import type { ClaudeQuota, QuotaWindow } from '@autonomy-studio/shared';

/**
 * #440 (C1) — reads the account's Claude subscription utilization.
 *
 * A TypeScript port of the prototype engine's `lib/claude_usage.py`, which is
 * the battle-tested reference for this: same injection seams, same fail-safe
 * semantics, same "the credential never escapes" properties. Ported rather than
 * kept because the engine is being parked (#410) and the build loop's spend
 * guard reads this figure — see `schemas/quota.ts` for why that matters.
 *
 * ## Two deliberate divergences from the prototype
 *
 * 1. **No grace window.** The prototype served a last-good value for up to 900s
 *    after a failed sample, badged with an `age_s`, so its UI panel would not
 *    flap between live and log-scan sources (#271). That is a PRESENTATION
 *    concern. This surface's consumer is a machine spend guard which reads the
 *    number and acts, so a stale-but-fresh-looking LOW reading would PERMIT a
 *    fire that should have been refused — fail-open, the one polarity every
 *    guard invariant in this repo forbids. The consumer already keeps its own
 *    cache of the last readable value and trusts it in ONE direction only (it
 *    may refuse a fire, never permit one), so the conservative memory exists
 *    where it is safe. Here, a failed read is simply UNREADABLE.
 * 2. **No background sampler.** The prototype polled on a sampler thread. This
 *    reader is lazy: it does no I/O at all until someone asks. A studio install
 *    that never calls `GET /api/quota` never touches the credential store.
 *
 * ## What is NOT a divergence: the TTL throttle
 *
 * The TTL bounds BOTH outcomes, exactly as the prototype's does. Throttling a
 * FAILED read is not stale-serving — it returns UNREADABLE without re-attempting
 * — and dropping it would turn a provider outage into a subprocess-and-socket
 * storm, since the guard polls this more than once per fire.
 */

/** The provider's usage endpoint. Reports `utilization` as a PERCENT. */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const USAGE_BETA = 'oauth-2025-04-20';

/** The macOS Keychain item the Claude Code CLI stores its OAuth blob under. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * Bounds on the two I/O calls. The Keychain read is bounded because a prompt or
 * a hung `security` would otherwise stall a Fastify request handler
 * indefinitely — the prototype ran this on its own sampler thread and could
 * afford to be relaxed about it; a request-path read cannot.
 */
const KEYCHAIN_TIMEOUT_MS = 4_000;
const HTTP_TIMEOUT_MS = 3_000;

/** How long a reading (success OR failure) is reused before re-attempting. */
const DEFAULT_TTL_MS = 60_000;

/**
 * ISO-8601 → epoch **SECONDS**, or `null` if unparseable.
 *
 * Seconds, not milliseconds: `Date.parse` returns ms and the consumer treats
 * the field as seconds, so returning ms would be wrong by a factor of 1000
 * while still looking like a plausible number.
 */
function isoToEpochSeconds(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

/**
 * One provider window → the wire shape, or `null` if malformed.
 *
 * Every rejection path returns `null` rather than substituting a default: an
 * unparsable window is an ABSENCE of a reading, and manufacturing a benign
 * value for it is the exact fail-open this surface exists to prevent.
 */
export function mapWindow(input: unknown): QuotaWindow | null {
  if (typeof input !== 'object' || input === null) return null;
  const w = input as Record<string, unknown>;
  const util = w.utilization;
  // `typeof true === 'boolean'` already excludes booleans, but NaN is a number
  // and would otherwise sail through into arithmetic downstream.
  if (typeof util !== 'number' || Number.isNaN(util) || util < 0) return null;
  const resetsAt = isoToEpochSeconds(w.resets_at);
  if (resetsAt === null) return null;
  const mapped: QuotaWindow = { utilization: util / 100, resets_at: resetsAt };
  return w.overage ? { ...mapped, overage: true } : mapped;
}

/**
 * Provider payload → a complete reading, or `null`.
 *
 * ALL-OR-NOTHING (inherited from the prototype's `_build`): both windows must
 * map, or the whole reading is UNREADABLE. Half a reading is not evidence, and
 * a partial object would let a caller read a window that was never validated.
 */
export function buildQuota(payload: unknown): ClaudeQuota | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const fiveHour = mapWindow(p.five_hour);
  const sevenDay = mapWindow(p.seven_day);
  if (fiveHour === null || sevenDay === null) return null;
  return { five_hour: fiveHour, seven_day: sevenDay, source: 'live' };
}

/**
 * Reads the OAuth access token from the macOS Keychain, or `null`.
 *
 * The token is passed to `execFile` NEVER as an argument (it is read from
 * stdout), is never logged, and never appears in a returned value or error —
 * every failure here collapses to `null` with no detail, because the detail is
 * the one thing that could carry it. Non-darwin hosts return `null` without
 * spawning anything.
 */
export async function readKeychainToken(): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  const raw = await new Promise<string | null>((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: KEYCHAIN_TIMEOUT_MS, encoding: 'utf8' },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
  if (raw === null) return null;
  try {
    const blob: unknown = JSON.parse(raw);
    if (typeof blob !== 'object' || blob === null) return null;
    const oauth = (blob as Record<string, unknown>).claudeAiOauth;
    if (typeof oauth !== 'object' || oauth === null) return null;
    const token = (oauth as Record<string, unknown>).accessToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * GETs the usage endpoint, returning the parsed JSON or `null`.
 *
 * Follows the house fetch pattern (`connectors/llm-shared.ts`'s `llmProbeGet`):
 * `AbortController` + a cleared timer. It deliberately returns NO error detail —
 * unlike `llmProbeGet`, which redacts secrets out of the message it surfaces,
 * this path simply never produces a message, so there is no vector to redact.
 */
export async function fetchUsage(token: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': USAGE_BETA,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (res.status !== 200) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface ClaudeQuotaReaderOptions {
  /** Test seam. Defaults to the macOS Keychain read. */
  tokenReader?: () => Promise<string | null>;
  /** Test seam. Defaults to the live provider GET. */
  fetcher?: (token: string) => Promise<unknown>;
  /** Test seam for the TTL clock. Epoch ms. */
  now?: () => number;
  /** How long a reading is reused, both outcomes. Defaults to 60s. */
  ttlMs?: number;
}

export interface ClaudeQuotaReader {
  /** The current reading, or `null` when it cannot be obtained. Never throws. */
  read(): Promise<ClaudeQuota | null>;
}

/**
 * Builds the reader. One per app instance so two apps in one process never
 * share a cache (matching how every other per-app service is scoped).
 */
export function createClaudeQuotaReader(opts: ClaudeQuotaReaderOptions = {}): ClaudeQuotaReader {
  const tokenReader = opts.tokenReader ?? readKeychainToken;
  const fetcher = opts.fetcher ?? fetchUsage;
  const now = opts.now ?? (() => Date.now());
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

  let cachedAt: number | null = null;
  let cached: ClaudeQuota | null = null;
  /** De-dupes concurrent reads so a burst is one subprocess + one request. */
  let inFlight: Promise<ClaudeQuota | null> | null = null;

  async function sample(): Promise<ClaudeQuota | null> {
    try {
      const token = await tokenReader();
      if (!token) return null;
      return buildQuota(await fetcher(token));
    } catch {
      // Fail-safe: ANY unexpected error is UNREADABLE, never a raise (which
      // would 500 the guard's poll) and never a substituted value.
      return null;
    }
  }

  return {
    async read() {
      const at = now();
      if (cachedAt !== null && at - cachedAt < ttlMs) return cached;
      if (inFlight) return inFlight;
      inFlight = sample()
        .then((value) => {
          // Both outcomes stamp the cache: a failure is throttled just like a
          // success, but it REPLACES the previous value rather than letting it
          // survive — no last-good is ever served after a failed read.
          cachedAt = at;
          cached = value;
          return value;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
