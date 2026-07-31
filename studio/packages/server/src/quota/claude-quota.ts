import { execFile } from 'node:child_process';
import {
  ClaudeAccountQuotaSchema,
  type ClaudeAccountQuota,
  type AccountQuotaUnavailableReason,
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
 *    This was recorded as a TRADEOFF, with an `unref`'d sampler named as "the
 *    escape hatch if C2 measures real UNREADABLE rates". C2 measured them, and
 *    the escape hatch is now **REJECTED on evidence** (#765) — the note is kept
 *    rather than deleted because the reasoning is the useful part.
 *
 *    What was measured against the live endpoint, 2026-07-29:
 *
 *      - it is NOT permanently rate-limited — a single cold poll returns 200
 *        with a full payload, so "lazy reads always fail" was never true;
 *      - the limit is tight and ACCOUNT-level: polls at 15s intervals gave
 *        200, 200, 200, 429, 429, 429, and a 6-request burst gave 6 × 429;
 *      - and it is STICKY: eleven consecutive polls at 60s were all 429, so
 *        polling on a fixed TTL does not recover it — the polling is what keeps
 *        the bucket empty.
 *
 *    A sampler is therefore the wrong direction TWICE OVER. It would not reduce
 *    provider volume — the TTL below already bounds that to one call per window
 *    no matter how many callers read, so the surface is *already* free to be
 *    polled — while it WOULD add a continuous ~1/min draw on a budget that is
 *    measurably near its ceiling (the prototype dashboard is already sampling
 *    the same account at 60s), i.e. it would make readings scarcer, not more
 *    available. And it would put the credential store back on every install's
 *    boot path for that privilege.
 *
 *    What the measurement DOES justify is the opposite move: back OFF when the
 *    provider says to. See `RATE_LIMITED` and the throttle window below.
 *
 * The TTL is not zero-staleness: a cached SUCCESS is served for up to 60s,
 * which is the same kind of window as the grace, two orders of magnitude
 * smaller. What makes it acceptable is the bound plus the DIRECTION — 7-day
 * utilization only rises within a window, so a cached reading is always <= the
 * true current one, and the error is at most one minute of spend against an
 * 80% threshold on a seven-day window. The grace window's 900s was not.
 *
 * ## What is NOT a divergence: the TTL throttle
 *
 * The TTL bounds BOTH outcomes, exactly as the prototype's does. Throttling a
 * FAILED read is not stale-serving — it returns UNREADABLE without re-attempting
 * — and dropping it would turn a provider outage into a subprocess-and-socket
 * storm, since the guard polls this more than once per fire.
 *
 * ## The rate-limit backoff (#765) — a WIDER throttle, still not a grace
 *
 * On an HTTP 429 the throttle window doubles (to a bounded ceiling) instead of
 * staying at the TTL, because the measured limit is sticky: a flat 60s retry
 * against it is part of the outage rather than a probe of it.
 *
 * This is the same kind of thing as the TTL — a bound on how often we ASK — and
 * emphatically NOT a grace window, which is a bound on how long we ANSWER with
 * an old value. The distinction is load-bearing, so it is enforced structurally
 * rather than by care: the window is only ever widened by a rate-limited sample,
 * and every sample overwrites the cache with its own result, so a widened window
 * always coexists with an EMPTY cache. A successful reading's life is bounded by
 * `ttlMs` and nothing else, exactly as before. The invariant is restated at
 * `throttleMs` and pinned by a test.
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
 * The ceiling on the rate-limit backoff, as a multiple of the TTL (8 × 60s = 8m).
 *
 * Bounded rather than unbounded because a permanently rate-limited account must
 * still be PROBED: a window that grew forever would wedge the surface shut and
 * make "the limit cleared an hour ago" indistinguishable from "still limited".
 */
const DEFAULT_MAX_THROTTLE_FACTOR = 8;

/**
 * What `fetchUsage` returns on an HTTP 429, so the reader can tell "the provider
 * is telling us to slow down" apart from "something broke". A frozen sentinel
 * rather than a change to the fetcher's return TYPE, deliberately: `fetcher` is
 * a public test seam typed `Promise<unknown>`, and widening it to a
 * discriminated union would churn every injection site for no gain.
 *
 * It is safe to miss. `buildQuota(RATE_LIMITED)` is `null` (no `five_hour`), so
 * a reader that failed to recognise it would lose the backoff and behave
 * exactly as it did before this existed — never invent a reading.
 */
export const RATE_LIMITED = Object.freeze({ __quota: 'rate_limited' } as const);

/** What the reader reports about the provider's availability. Never a secret. */
export type QuotaReaderLogEvent =
  { event: 'rate_limited'; throttleMs: number } | { event: 'rate_limit_cleared' };

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
  // `=== true`, not truthiness. The prototype used a truthy test, but this is
  // the one place in the module that would MANUFACTURE a value rather than
  // reject one: a wire `"false"`, `"no"` or `1` is truthy and would become a
  // schema `literal(true)`. Everything else here degrades to null on anything
  // it does not recognise; this should too.
  return w.overage === true ? { ...mapped, overage: true } : mapped;
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
  // The SCHEMA is the single definition of a valid reading, and this is the ONE
  // place it is enforced at runtime — the route trusts what it gets from here.
  // It matters because these are untrusted provider bytes and because
  // `mapWindow`'s hand-written predicate and `AccountQuotaWindowSchema` are two
  // definitions of the same thing that could drift. Rejecting a divergence here
  // makes it an honest UNREADABLE, and means a future tightening of the schema
  // can only ever make readings null — never make the endpoint fail.
  const parsed = ClaudeAccountQuotaSchema.safeParse({
    five_hour: fiveHour,
    seven_day: sevenDay,
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
 * GETs the usage endpoint. THREE outcomes, not two: the parsed JSON on 200, the
 * `RATE_LIMITED` sentinel on a 429, and `null` on anything else. The declared
 * `Promise<unknown>` hides that (it is `unknown` so the `fetcher` seam stays
 * cheap to inject), so a caller treating a non-null result as a payload without
 * checking the sentinel silently loses the backoff — which is survivable by
 * design, since `buildQuota(RATE_LIMITED)` is `null`, but is not the intent.
 *
 * Follows the house fetch pattern (`connectors/llm-shared.ts`'s `llmProbeGet`):
 * `AbortController` + a cleared timer. It deliberately returns NO error detail —
 * unlike `llmProbeGet`, which redacts secrets out of the message it surfaces,
 * this path simply never produces a message, so there is no vector to redact.
 */
export async function fetchUsage(token: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  // A DELIBERATE departure from the house pattern above, which leaves its abort
  // timers ref'd: an in-flight quota read must never be the thing keeping the
  // event loop alive at shutdown. The `finally` clears the timer on every path
  // anyway, so this only covers the window before that runs.
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
      // 429 is reported DISTINCTLY (#765): the limit is sticky, so it is the one
      // failure whose correct response is to poll less, not to retry on the TTL.
      //
      // No `Retry-After` parse. Not because the header is absent — it is present
      // and measurably `0` on this endpoint — but because honouring it would be
      // BEHAVIOUR-NEUTRAL: the house parser (`connectors/llm-shared.ts`'s
      // `parseRetryAfter`) routes anything `< 1` through `clampRetryAfter` to
      // `undefined`, i.e. "no usable hint", which is exactly what is done here by
      // not parsing. If the provider ever starts sending a real delta, that
      // helper is the thing to reach for — see the note on borrowing patterns
      // rather than the module from `connectors/`.
      return res.status === 429 ? RATE_LIMITED : null;
    }
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface ClaudeAccountQuotaReaderOptions {
  /** Test seam. Defaults to the macOS Keychain read. */
  tokenReader?: () => Promise<string | null>;
  /** Test seam. Defaults to the live provider GET. */
  fetcher?: (token: string) => Promise<unknown>;
  /** Test seam for the TTL clock. Epoch ms. */
  now?: () => number;
  /** How long a reading is reused, both outcomes. Defaults to 60s. */
  ttlMs?: number;
  /**
   * Ceiling on the rate-limit backoff window. Defaults to 8 × `ttlMs`, and is
   * floored at `ttlMs` so a misconfigured ceiling can only ever disable the
   * backoff, never shorten the base throttle into a polling storm.
   */
  maxThrottleMs?: number;
  /**
   * Optional observability sink for provider-availability TRANSITIONS. Without
   * it an UNREADABLE reading is undiagnosable from outside — a missing
   * credential, a provider outage and a rate-limited account all look the same.
   */
  log?: (event: QuotaReaderLogEvent) => void;
}

/**
 * The reader used when the surface is switched off. Exported so the disabled
 * branch and the test-app default are ONE definition rather than two identical
 * literals drifting apart (CLAUDE.md: export once, import everywhere).
 */
export const UNREADABLE_ACCOUNT_QUOTA_READER: ClaudeAccountQuotaReader = {
  read: async () => ({ value: null, unavailable: 'disabled' }),
};

/**
 * A reading and, when there ISN'T one, why (#825).
 *
 * The two travel together deliberately. An `unavailableReason()` getter read
 * separately from `read()` could pair a cached reading with a LATER sample's
 * cause — a number carrying a failure's explanation, which is precisely the
 * confusion this exists to remove. Returning the pair makes
 * `value !== null ⟺ unavailable === null` structural rather than a convention
 * every caller has to honour.
 */
export interface AccountQuotaReading {
  /** The reading, or `null` when it could not be obtained. */
  value: ClaudeAccountQuota | null;
  /** Why there is no reading; `null` whenever there IS one. Advisory only. */
  unavailable: AccountQuotaUnavailableReason | null;
}

export interface ClaudeAccountQuotaReader {
  /** The current reading plus its unavailability cause. Never throws. */
  read(): Promise<AccountQuotaReading>;
}

/**
 * One sample's result.
 *
 * Rate-limiting is not carried as a separate flag: it is the one failure that
 * must widen the throttle window rather than only stamp the cache, and
 * `unavailable === 'rate_limited'` already says so exactly. A boolean beside the
 * reason would be a second encoding of one fact, free to disagree with it.
 *
 * Module-scoped rather than local to the reader for consistency with
 * `QuotaReaderLogEvent`. Note this is types-only either way — an `interface`
 * erases at compile time, so nesting it cost nothing per construction.
 */
type SampleOutcome = AccountQuotaReading;

/**
 * Builds the reader. One per app instance so two apps in one process never
 * share a cache (matching how every other per-app service is scoped).
 */
export function createClaudeAccountQuotaReader(
  opts: ClaudeAccountQuotaReaderOptions = {},
): ClaudeAccountQuotaReader {
  const tokenReader = opts.tokenReader ?? readKeychainToken;
  const fetcher = opts.fetcher ?? fetchUsage;
  const now = opts.now ?? (() => Date.now());
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const maxThrottleMs = Math.max(ttlMs, opts.maxThrottleMs ?? ttlMs * DEFAULT_MAX_THROTTLE_FACTOR);
  const log = opts.log;

  let cachedAt: number | null = null;
  /**
   * The whole last sample — reading AND cause — stamped as ONE value, so a
   * cache hit can never hand out a reading from one sample with a cause from
   * another (#825). `null` means no sample has completed yet; that state is
   * represented rather than stood in for by a fabricated placeholder reason.
   */
  let cached: AccountQuotaReading | null = null;
  /**
   * The CURRENT throttle window. Equal to `ttlMs` normally; widened
   * geometrically while the provider is rate-limiting (#765).
   *
   * INVARIANT, and the whole reason this is safe: `cached?.value != null` implies
   * `throttleMs === ttlMs`. The window is raised only by a rate-limited sample,
   * every sample stamps `cached` with its own result (a rate-limited one being
   * `null`), and the window is lowered by every successful one. So a widened
   * window always coexists with an EMPTY cache and can therefore never be the
   * thing extending a reading's life beyond the minute the TTL is justified by.
   */
  let throttleMs = ttlMs;
  /**
   * Whether the provider is currently rate-limiting us, tracked EXPLICITLY
   * rather than inferred from `throttleMs !== ttlMs`. The inference is wrong
   * whenever the cap equals the TTL (a caller disabling the backoff): the window
   * never moves, so every sample would look like a fresh transition and the log
   * would repeat per read while the recovery line never fired at all.
   */
  let rateLimited = false;
  /** De-dupes concurrent reads so a burst is one subprocess + one request. */
  let inFlight: Promise<AccountQuotaReading> | null = null;

  /**
   * BRANCH ORDER IS THE ATTRIBUTION (#825). Each `return` names the cause the
   * step it guards actually rules out, so reordering them would not just
   * reshuffle labels — a rate-limited sample reached after the `raw === null`
   * test would report `provider_error`, and the C3 evidence would say "studio
   * is broken" about a contended account. The value path is unchanged.
   */
  async function sample(): Promise<SampleOutcome> {
    try {
      const token = await tokenReader();
      // Covers a host with no credential store at all, indistinguishably —
      // `readKeychainToken` returns null off darwin without looking.
      if (!token) return { value: null, unavailable: 'no_credential' };
      const raw = await fetcher(token);
      if (raw === RATE_LIMITED) return { value: null, unavailable: 'rate_limited' };
      // `fetchUsage` collapses every non-429 failure to null, so this is
      // "the call did not come back", distinct from the shape check below.
      if (raw === null) return { value: null, unavailable: 'provider_error' };
      const value = buildQuota(raw);
      // The provider IS serving us and we cannot use what it said: a contract
      // break to chase, not a bucket to wait out.
      return value === null
        ? { value: null, unavailable: 'unrecognized_payload' }
        : { value, unavailable: null };
    } catch {
      // Fail-safe: ANY unexpected error is UNREADABLE, never a raise (which
      // would 500 the guard's poll) and never a substituted value.
      return { value: null, unavailable: 'reader_error' };
    }
  }

  /**
   * Emits to the caller's sink, absorbing anything it throws.
   *
   * `applyOutcome` runs in the `.then` — OUTSIDE `sample()`'s catch-all — so
   * without this a throwing sink escapes into `inFlight` and breaks the `read()`
   * contract two ways at once: a reading that was successfully obtained is
   * discarded and reported as UNREADABLE (spending one of the guard's bounded
   * blind fires for a provider call that actually worked), and on the
   * rate-limited branch the throw lands BEFORE the window is widened, silently
   * disabling the very backoff this change exists to add. An observability sink
   * must never be able to alter the behaviour it observes.
   *
   * BOTH failure shapes are absorbed, because `log` being typed `=> void` does
   * not actually stop a caller passing an `async` sink: TypeScript permits a
   * value-returning function where `void` is expected, so `async () => { throw }`
   * type-checks fine and its rejection would sail straight past a synchronous
   * `catch` and become an unhandled rejection — which Node terminates the process
   * on by default. That is a strictly worse outcome than the throw this function
   * exists to swallow, so the returned value is checked for thenability and its
   * rejection attached to. The `typeof … === 'function'` probe is inside the
   * `try` deliberately: reading `.then` can itself throw on a hostile getter.
   */
  function report(event: QuotaReaderLogEvent): void {
    try {
      const returned: unknown = log?.(event);
      if (typeof (returned as PromiseLike<void> | undefined)?.then === 'function') {
        void (returned as PromiseLike<void>).then(undefined, () => {});
      }
    } catch {
      // Deliberately silent: the only sink available to complain to is the one
      // that just threw.
    }
  }

  /**
   * Folds a sample's outcome into the throttle window.
   *
   * Widened on a 429. Reset ONLY on a real success — NOT on any non-429 failure
   * — because the backoff exists to stop us keeping a bucket empty, and only
   * evidence that the provider is serving again is evidence it has refilled. A
   * transport error while limited says nothing either way, so it leaves the
   * window where it is rather than resetting it and resuming the polling that
   * caused the problem.
   *
   * One accepted cost of that rule: a host that is rate-limited and then loses
   * its credential entirely reports `rate_limited` and never reports
   * `rate_limit_cleared`, so the warn reads as a stale rate-limit long after the
   * real cause changed. Diagnostic only — every read in that state is UNREADABLE
   * either way, and the cap bounds the retry latency at `maxThrottleMs`.
   */
  function applyOutcome(outcome: SampleOutcome): void {
    if (outcome.unavailable === 'rate_limited') {
      const next = Math.min(throttleMs * 2, maxThrottleMs);
      // Report the window we ACTUALLY adopted, not `throttleMs * 2` — those
      // differ once the cap binds, and a log line that overstates the backoff is
      // worse than none when the whole point is diagnosing a blind guard.
      if (!rateLimited) {
        rateLimited = true;
        report({ event: 'rate_limited', throttleMs: next });
      }
      throttleMs = next;
      return;
    }
    if (outcome.value === null) return;
    if (rateLimited) {
      rateLimited = false;
      report({ event: 'rate_limit_cleared' });
    }
    throttleMs = ttlMs;
  }

  return {
    async read() {
      const at = now();
      // `at >= cachedAt` is load-bearing, not defensive noise. `now` is WALL
      // clock, not monotonic, so an NTP step-back, a VM suspend/resume or a
      // manual clock change makes `at - cachedAt` NEGATIVE — which is still
      // `< ttlMs`, so the cache would be served until wall time caught up.
      // That is unbounded staleness in the FAIL-OPEN direction (a low reading
      // outliving the window it was taken in), and it would falsify the "at
      // most one minute" bound this TTL is justified by. A backwards step now
      // simply misses the cache and re-samples.
      if (cached !== null && cachedAt !== null && at >= cachedAt && at - cachedAt < throttleMs) {
        return cached;
      }
      if (inFlight) return inFlight;
      inFlight = sample()
        .then((outcome) => {
          // Both outcomes stamp the cache: a failure is throttled just like a
          // success, but it REPLACES the previous value rather than letting it
          // survive — no last-good is ever served after a failed read. The
          // CAUSE is stamped in the same assignment as the value it explains,
          // which is what makes the pair a single sample rather than two facts
          // that can drift (#825).
          cachedAt = at;
          cached = outcome;
          applyOutcome(outcome);
          return outcome;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
