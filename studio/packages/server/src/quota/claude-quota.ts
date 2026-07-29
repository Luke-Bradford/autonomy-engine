import { execFile } from 'node:child_process';
import {
  ClaudeAccountQuotaSchema,
  type ClaudeAccountQuota,
  type AccountQuotaWindow,
} from '@autonomy-studio/shared';

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
 *    This one is a genuine TRADEOFF, not a pure win, and it should not be read
 *    as one. The sampler is *why* `drive.sh` preferred the dashboard over
 *    calling the provider directly: the dashboard answered from a warm cache,
 *    while the upstream endpoint rate-limits and 429s when polled (its comment
 *    records observing this, and it was re-measured on 2026-07-29 — a burst
 *    earns 429s that outlast a minute and clear by ~2). Lazy means a cache miss
 *    puts a live upstream call on the request path, so a blip that the
 *    prototype would have absorbed now surfaces as UNREADABLE and spends one of
 *    the guard's bounded blind fires. Accepted here because the consumer polls
 *    a couple of times per fire and fires are hours apart, so the TTL almost
 *    always covers a poll pair, and because a background sampler would put the
 *    credential store back on the boot path for every install. If C2 measures
 *    real UNREADABLE rates, an `unref`'d refresh gated on the same env flag is
 *    the escape hatch — that is a deliberate open door, not an oversight.
 *
 * The TTL is not zero-staleness, and the argument above should not be read as
 * claiming it is: a cached SUCCESS is served for up to 60s, which is the same
 * kind of window as the grace, just two orders of magnitude smaller. What makes
 * it acceptable is the bound plus the direction — 7-day utilization only rises
 * within a window, so a cached reading is always <= the true current one, and
 * the error is at most one minute of spend against an 80% threshold on a
 * seven-day window. The grace window's 900s of the same error was not.
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
 * Bounds on the two I/O calls, and they must sum to less than the CONSUMER'S
 * budget: `loop/drive.sh` calls this with `curl --max-time 8`, and a curl
 * timeout reads as UNREADABLE, i.e. it spends one of the guard's bounded blind
 * fires. 2s + 3s leaves ~3s of margin for everything else in the request.
 *
 * The Keychain read is bounded at all because a prompt or a hung `security`
 * would otherwise stall a Fastify request handler indefinitely — the prototype
 * ran this on its own sampler thread and could afford to be relaxed about it; a
 * request-path read cannot. 2s is already generous for a local keychain read.
 */
const KEYCHAIN_TIMEOUT_MS = 2_000;
const HTTP_TIMEOUT_MS = 3_000;

/** How long a reading (success OR failure) is reused before re-attempting. */
const DEFAULT_TTL_MS = 60_000;

/**
 * A timestamp carrying an EXPLICIT UTC offset (`Z`, `+00:00`, `-0500`).
 *
 * Required because `Date.parse` is both looser and differently-behaved than the
 * prototype's `datetime.fromisoformat`: an offset-less date-TIME is parsed as
 * LOCAL time per ECMA-262, where the prototype assumed UTC — a silent skew of
 * up to 14 hours depending on the host's zone. `Date.parse` also accepts things
 * the prototype rejected (`'Aug 5 2026'`, a bare `'2026-08-05'`), which would
 * weaken "malformed → null" into "malformed → a plausible wrong number". The
 * provider always sends an offset, so requiring one costs nothing and keeps the
 * rejection behaviour honest.
 */
const EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * ISO-8601 → epoch **SECONDS**, or `null` if unparseable.
 *
 * Seconds, not milliseconds: `Date.parse` returns ms and the consumer treats
 * the field as seconds, so returning ms would be wrong by a factor of 1000
 * while still looking like a plausible number.
 */
function isoToEpochSeconds(value: unknown): number | null {
  if (typeof value !== 'string' || !EXPLICIT_OFFSET.test(value)) return null;
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
export function mapWindow(input: unknown): AccountQuotaWindow | null {
  if (typeof input !== 'object' || input === null) return null;
  const w = input as Record<string, unknown>;
  const util = w.utilization;
  // `typeof true === 'boolean'` already excludes booleans, but NaN and Infinity
  // are both numbers and would otherwise sail through into arithmetic
  // downstream. Infinity is reachable from the wire, not just theoretically:
  // JSON overflows an out-of-range literal to it (`JSON.parse('{"a":1e999}').a`
  // is `Infinity`), and it would then fail `ClaudeAccountQuotaSchema` — turning a
  // reading the reader considered valid into a 400 for the whole TTL.
  if (typeof util !== 'number' || !Number.isFinite(util) || util < 0) return null;
  const resetsAt = isoToEpochSeconds(w.resets_at);
  if (resetsAt === null) return null;
  const mapped: AccountQuotaWindow = { utilization: util / 100, resets_at: resetsAt };
  return w.overage ? { ...mapped, overage: true } : mapped;
}

/**
 * Provider payload → a complete reading, or `null`.
 *
 * ALL-OR-NOTHING (inherited from the prototype's `_build`): both windows must
 * map, or the whole reading is UNREADABLE. Half a reading is not evidence, and
 * a partial object would let a caller read a window that was never validated.
 */
export function buildQuota(payload: unknown): ClaudeAccountQuota | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const fiveHour = mapWindow(p.five_hour);
  const sevenDay = mapWindow(p.seven_day);
  if (fiveHour === null || sevenDay === null) return null;
  // The SCHEMA is the single definition of a valid reading, and the reader
  // validates its own output against it. Without this, `mapWindow`'s predicate
  // and `AccountQuotaWindowSchema` are two hand-maintained definitions of the same
  // thing that can drift: anything the reader accepts but the schema rejects
  // becomes a 400 at the route's `parse`, i.e. a reading the reader thought was
  // fine turning into an error response for the whole TTL. Rejecting it HERE
  // makes it an honest UNREADABLE instead, and means a future tightening of the
  // schema can only ever make readings null — never make the endpoint throw.
  const parsed = ClaudeAccountQuotaSchema.safeParse({
    five_hour: fiveHour,
    seven_day: sevenDay,
    source: 'live',
  });
  return parsed.success ? parsed.data : null;
}

/** Test seam: runs the credential-store command, resolving its stdout or `null`. */
export type KeychainRunner = (service: string, timeoutMs: number) => Promise<string | null>;

/** The real credential-store read. The token comes back on STDOUT, never argv. */
const defaultKeychainRunner: KeychainRunner = (service, timeoutMs) =>
  new Promise<string | null>((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', service, '-w'],
      { timeout: timeoutMs, encoding: 'utf8' },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });

/**
 * Reads the OAuth access token from the macOS Keychain, or `null`.
 *
 * The token is passed to `execFile` NEVER as an argument (it is read from
 * stdout), is never logged, and never appears in a returned value or error —
 * every failure here collapses to `null` with no detail, because the detail is
 * the one thing that could carry it. Non-darwin hosts return `null` without
 * spawning anything.
 */
export async function readKeychainToken(
  runner: KeychainRunner = defaultKeychainRunner,
  platform: string = process.platform,
): Promise<string | null> {
  if (platform !== 'darwin') return null;
  let raw: string | null;
  try {
    raw = await runner(KEYCHAIN_SERVICE, KEYCHAIN_TIMEOUT_MS);
  } catch {
    return null;
  }
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
export async function fetchUsage(token: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  // Matches every other timer in the server: an in-flight quota read must never
  // be the thing keeping the event loop alive at shutdown.
  timer.unref();
  try {
    const res = await fetchImpl(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': USAGE_BETA,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (res.status !== 200) {
      // Drain the body so keep-alive does not hold the socket. The 429 path is
      // ROUTINE here, not exceptional: the provider rate-limits this endpoint
      // and penalises bursts, so this branch is taken often enough to matter.
      await res.body?.cancel();
      return null;
    }
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

/**
 * The reader used when the surface is switched off. Exported so the disabled
 * branch and the test-app default are ONE definition rather than two identical
 * literals drifting apart (CLAUDE.md: export once, import everywhere).
 */
export const UNREADABLE_QUOTA_READER: ClaudeQuotaReader = { read: async () => null };

export interface ClaudeQuotaReader {
  /** The current reading, or `null` when it cannot be obtained. Never throws. */
  read(): Promise<ClaudeAccountQuota | null>;
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
  let cached: ClaudeAccountQuota | null = null;
  /** De-dupes concurrent reads so a burst is one subprocess + one request. */
  let inFlight: Promise<ClaudeAccountQuota | null> | null = null;

  async function sample(): Promise<ClaudeAccountQuota | null> {
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
