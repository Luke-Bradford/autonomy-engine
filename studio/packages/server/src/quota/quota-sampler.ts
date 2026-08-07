import {
  DEFAULT_QUOTA_SAMPLE_INTERVAL_MS,
  type ClaudeAccountQuotaReader,
} from './claude-quota.js';

/**
 * #765 — the background sampler that keeps the account-quota reading WARM.
 *
 * ## What this is, and (more importantly) what it is not
 *
 * It is a timer that calls `reader.read()` and throws the answer away. That is
 * the whole implementation, and it is deliberate: every policy that could get
 * this wrong already lives in the reader, so duplicating any of it here would
 * create a second definition free to drift from the first. Specifically —
 *
 *   - the TTL, so a tick landing inside the window is a pure cache hit and does
 *     no I/O at all;
 *   - the geometric 429 backoff, which the ticks therefore inherit for free: a
 *     widened throttle window silently converts most ticks into cache hits, so a
 *     rate-limited account is polled LESS, not once per tick;
 *   - the in-flight de-dupe, so a slow sample overlapping the next tick is one
 *     provider call rather than two;
 *   - and the no-grace / no-last-good property. This module serves nothing and
 *     caches nothing, so it cannot extend a reading's life by a millisecond.
 *     That matters because the consumer is a spend guard: a stale-but-low
 *     reading that PERMITS a fire is the one polarity forbidden here.
 *
 * ## Why it exists — and why it is OFF by default
 *
 * Without it every read is a request-path poll of an endpoint measured to be
 * tightly, stickily rate-limited, so the consumer (`loop/drive.sh`, on a
 * `curl --max-time 8` budget) pays that latency and often gets UNREADABLE.
 *
 * It is nevertheless dormant unless `CLAUDE_QUOTA_SAMPLER=1`, because #770's
 * invariant is that *exactly one process may poll `/api/oauth/usage` directly*
 * and that process is currently the prototype dashboard's sampler. This code
 * lands dormant (one poller), and C3 retires the dashboard and arms this in the
 * SAME step (still one poller). See `claude-quota.ts`'s divergence note for the
 * measurement, and for the honest accounting of what arming this costs.
 *
 * ## Naming
 *
 * `start*`, not the house `create*`, because starting IS the constructor here —
 * there is no configured-but-idle state worth representing. It matches
 * `startRetentionSweep` in `index.ts`, which has the identical shape (prime at
 * boot, then an `unref`'d interval whose handle the caller stops on close).
 */

/**
 * Resolves whether the sampler is armed: an explicit option, else the env var.
 *
 * A function rather than an inline expression at the one call site, because the
 * polarity here is a safety property and a pure function is the only way to test
 * it without mutating `process.env` — which is process-global and shared across
 * concurrently-running test files, so a test that set `CLAUDE_QUOTA_SAMPLER` to
 * an invalid value would fail an unrelated file's `buildApp`.
 *
 * `'1'` arms. `'0'`, empty and unset are dormant. ANYTHING ELSE THROWS, matching
 * this repo's fail-fast convention for env misconfiguration (port, retention) —
 * and note that this is the OPPOSITE of the neighbouring `CLAUDE_QUOTA_ENABLED`,
 * which tolerates any value and stays ENABLED. The two flags fail in opposite
 * directions on purpose: that one fails towards armed because a typo that
 * disarmed the spend guard is the worse outcome, and this one refuses to guess
 * at all because BOTH of its wrong answers are bad — a spurious arm breaches
 * #770's one-poller invariant, while a spurious dormant leaves the cutover with
 * zero pollers and nothing said about it.
 */
export function resolveQuotaSamplerEnabled(
  override: boolean | undefined,
  raw: string | undefined,
): boolean {
  if (override !== undefined) return override;
  if (raw === undefined || raw === '' || raw === '0') return false;
  if (raw === '1') return true;
  throw new Error(
    `Invalid CLAUDE_QUOTA_SAMPLER '${raw}' — must be '1' (arm the background quota sampler) or '0'/unset (dormant)`,
  );
}

export interface QuotaSampler {
  /** Stops further sampling. Idempotent; safe to call from a shutdown hook. */
  stop(): void;
}

export interface QuotaSamplerOptions {
  /** Cadence. Defaults to `DEFAULT_QUOTA_SAMPLE_INTERVAL_MS` (half the reader TTL). */
  intervalMs?: number;
  /**
   * Where a broken reader is reported. `read()` is typed as never-rejecting, so
   * anything arriving here is a contract break by an injected reader — but the
   * reader IS an injectable seam, so it is reachable, and an unhandled rejection
   * ends the process by default in Node. Absorbing it silently would instead
   * make a permanently blind guard undiagnosable, which is the failure #765 was
   * originally misdiagnosed as.
   */
  onError?: (err: unknown) => void;
}

export function startClaudeQuotaSampler(
  reader: ClaudeAccountQuotaReader,
  opts: QuotaSamplerOptions = {},
): QuotaSampler {
  const intervalMs = opts.intervalMs ?? DEFAULT_QUOTA_SAMPLE_INTERVAL_MS;
  // Refused rather than clamped: a zero or negative interval makes `setInterval`
  // fire continuously, which against THIS endpoint is a burst that the measured
  // account-level limiter answers with a wall of 429s. A silently-corrected
  // value would hide the misconfiguration that caused it.
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(
      `Invalid quota sampler intervalMs ${intervalMs} — must be a finite number > 0`,
    );
  }

  /**
   * Absorbs anything the sink itself throws. An observability sink must never be
   * able to alter the behaviour it observes — here, a throwing sink would escape
   * the promise chain and become the unhandled rejection this exists to prevent.
   * Mirrors `report()` in `claude-quota.ts` for the same reason.
   */
  const report = (err: unknown): void => {
    try {
      opts.onError?.(err);
    } catch {
      // Deliberately silent: the only sink available to complain to is the one
      // that just threw.
    }
  };

  const sample = (): void => {
    // No `stopped` guard, deliberately — an earlier draft had one and a mutation
    // test showed it could not fail: `clearInterval` already prevents every
    // future callback on a single-threaded loop, and it cannot un-issue the
    // prime read, which has already happened by the time any caller could call
    // `stop()`. A second mechanism that no test can distinguish from the first
    // is a branch that will never be exercised.
    try {
      // `Promise.resolve` rather than `reader.read().then(...)`: a reader that
      // breaks its contract by throwing SYNCHRONOUSLY would otherwise escape
      // before there is a promise to attach a handler to. The `try` covers that
      // too; both are here because the two failures have different shapes and
      // this is a seam other packages can implement.
      void Promise.resolve(reader.read()).then(undefined, report);
    } catch (err) {
      report(err);
    }
  };

  // Prime at start, so the cache is warm from boot rather than from the first
  // tick. Not awaited: a Keychain read plus a provider call must never sit in
  // front of the server accepting requests.
  sample();
  const timer = setInterval(sample, intervalMs);
  // A pending tick must never be the thing keeping the process alive at
  // shutdown — the same rule the reader's abort timer and the retention sweeps
  // follow.
  timer.unref();

  return {
    // Idempotent because `clearInterval` is: a second call on a cleared handle
    // is a documented no-op, so no flag is needed to make the contract true.
    stop: () => clearInterval(timer),
  };
}
