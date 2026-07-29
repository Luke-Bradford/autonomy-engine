import { describe, it, expect, vi } from 'vitest';
import { AccountQuotaWindowSchema } from '@autonomy-studio/shared';
import {
  createClaudeAccountQuotaReader,
  mapWindow,
  buildQuota,
  readKeychainToken,
  fetchUsage,
  RATE_LIMITED,
} from '../claude-quota.js';

/**
 * #440 (C1) — the spend guard's reading.
 *
 * These tests exist because the failure modes here are silent by nature: a
 * quota surface that reports the WRONG NUMBER, or reports `0` when it means
 * "I don't know", disarms the guard while still looking healthy. Every
 * assertion below is about that class of failure, not about happy-path shape.
 */

/** A payload in the exact shape the provider returns (utilization as a PERCENT). */
const LIVE_PAYLOAD = {
  five_hour: { utilization: 8.0, resets_at: '2026-07-29T19:10:00.789612+00:00' },
  seven_day: { utilization: 7.0, resets_at: '2026-08-05T02:00:00.789638+00:00' },
};

function readerWith(payload: unknown, opts: { token?: string | null } = {}) {
  const fetcher = vi.fn(async () => payload);
  const tokenReader = vi.fn(async () => (opts.token === undefined ? 'tok' : opts.token));
  let clock = 1_000_000;
  const reader = createClaudeAccountQuotaReader({
    tokenReader,
    fetcher,
    now: () => clock,
    ttlMs: 60_000,
  });
  return { reader, fetcher, tokenReader, advance: (ms: number) => (clock += ms) };
}

describe('mapWindow — percent → fraction, ISO → epoch seconds', () => {
  it('converts the provider percent to a 0-1 fraction', () => {
    expect(mapWindow({ utilization: 7.0, resets_at: '2026-08-05T02:00:00+00:00' })).toMatchObject({
      utilization: 0.07,
    });
  });

  it('emits resets_at in epoch SECONDS, not milliseconds', () => {
    const mapped = mapWindow({ utilization: 7.0, resets_at: '2026-08-05T02:00:00+00:00' });
    // The ms/seconds trap: Date.parse returns ms. A seconds value for a 2026
    // date is ~1.7e9; the millisecond value is ~1.7e12.
    expect(mapped?.resets_at).toBe(Math.floor(Date.parse('2026-08-05T02:00:00+00:00') / 1000));
    expect(mapped?.resets_at).toBeLessThan(1e11);
  });

  it('accepts a trailing-Z timestamp', () => {
    expect(mapWindow({ utilization: 1, resets_at: '2026-08-05T02:00:00Z' })?.resets_at).toBe(
      Math.floor(Date.parse('2026-08-05T02:00:00Z') / 1000),
    );
  });

  it('carries overage only when it is true', () => {
    const on = mapWindow({ utilization: 1, resets_at: '2026-08-05T02:00:00Z', overage: true });
    const off = mapWindow({ utilization: 1, resets_at: '2026-08-05T02:00:00Z', overage: false });
    expect(on).toHaveProperty('overage', true);
    expect(off).not.toHaveProperty('overage');
  });

  it.each([
    ['the string "false"', 'false'],
    ['the string "no"', 'no'],
    ['the number 1', 1],
    ['an object', {}],
  ])('does not turn %s into overage: true', (_label, value) => {
    // A TRUTHINESS test here (which is what the prototype used) would convert
    // any of these into a schema `literal(true)` — the one place in this module
    // that would MANUFACTURE a fact rather than reject an input it does not
    // recognise. Every other path degrades to null instead of guessing.
    const got = mapWindow({ utilization: 1, resets_at: '2026-08-05T02:00:00Z', overage: value });
    expect(got).not.toHaveProperty('overage');
  });

  it.each([
    ['a non-object', 'nope'],
    ['a missing utilization', { resets_at: '2026-08-05T02:00:00Z' }],
    ['a boolean utilization', { utilization: true, resets_at: '2026-08-05T02:00:00Z' }],
    ['a string utilization', { utilization: '7', resets_at: '2026-08-05T02:00:00Z' }],
    ['a negative utilization', { utilization: -1, resets_at: '2026-08-05T02:00:00Z' }],
    ['a NaN utilization', { utilization: Number.NaN, resets_at: '2026-08-05T02:00:00Z' }],
    ['a missing resets_at', { utilization: 7 }],
    ['an unparseable resets_at', { utilization: 7, resets_at: 'not-a-date' }],
    // Reachable from the wire, not theoretical: JSON overflows an out-of-range
    // numeric literal to Infinity, which would then fail the schema and turn a
    // reading the reader accepted into a 400 for the whole TTL.
    ['an infinite utilization', { utilization: Infinity, resets_at: '2026-08-05T02:00:00Z' }],
    [
      'an overflowing JSON literal',
      JSON.parse('{"utilization": 1e999, "resets_at": "2026-08-05T02:00:00Z"}'),
    ],
  ])('degrades %s to null rather than guessing', (_label, input) => {
    expect(mapWindow(input)).toBeNull();
  });

  it.each([
    ['no offset at all', '2026-08-05T02:00:00'],
    ['a date with no time', '2026-08-05'],
    ['a loose human date', 'Aug 5 2026'],
  ])('rejects a timestamp with %s rather than guessing a zone', (_label, ts) => {
    // `Date.parse` reads an offset-less date-TIME as LOCAL time (ECMA-262),
    // where the prototype assumed UTC — a silent skew of up to 14 hours by
    // host zone. It also accepts forms the prototype rejected outright, which
    // would turn "malformed → null" into "malformed → a plausible wrong
    // number". Requiring an explicit offset keeps the rejection honest.
    expect(mapWindow({ utilization: 7, resets_at: ts })).toBeNull();
  });
});

describe('buildQuota — all-or-nothing', () => {
  it('builds both windows from a full payload', () => {
    expect(buildQuota(LIVE_PAYLOAD)).toEqual({
      five_hour: { utilization: 0.08, resets_at: expect.any(Number) },
      seven_day: { utilization: 0.07, resets_at: expect.any(Number) },
    });
  });

  it.each([
    ['a missing seven_day', { five_hour: LIVE_PAYLOAD.five_hour }],
    ['a missing five_hour', { seven_day: LIVE_PAYLOAD.seven_day }],
    ['a malformed window', { ...LIVE_PAYLOAD, seven_day: { utilization: 'x' } }],
    ['a non-object', null],
  ])('degrades %s to null — half a reading is not evidence', (_label, input) => {
    expect(buildQuota(input)).toBeNull();
  });
});

describe('the reader and the schema agree on what a valid window is', () => {
  /**
   * `buildQuota` validates its own output against `ClaudeAccountQuotaSchema` so that a
   * reading the READER accepts can never fail the ROUTE's parse — which would
   * turn it into a 400 for the whole TTL instead of an honest reading.
   *
   * That defence is unreachable while the two definitions agree, so asserting it
   * directly is impossible without breaking one of them. What IS testable is the
   * invariant it exists to protect: `mapWindow`'s accept-set must be a SUBSET of
   * the schema's. This test goes red the moment someone tightens one side
   * without the other — which is the actual failure mode.
   */
  it.each([
    ['a typical reading', { utilization: 7, resets_at: '2026-08-05T02:00:00+00:00' }],
    ['zero', { utilization: 0, resets_at: '2026-08-05T02:00:00Z' }],
    ['a full window', { utilization: 100, resets_at: '2026-08-05T02:00:00Z' }],
    ['an overage reading above 100%', { utilization: 143.7, resets_at: '2026-08-05T02:00:00Z' }],
    ['an overage flag', { utilization: 99, resets_at: '2026-08-05T02:00:00Z', overage: true }],
    ['a fractional percent', { utilization: 0.5, resets_at: '2026-08-05T02:00:00Z' }],
    ['a tiny percent', { utilization: 1e-9, resets_at: '2026-08-05T02:00:00Z' }],
    ['a negative offset', { utilization: 7, resets_at: '2026-08-05T02:00:00-05:00' }],
    ['a pre-epoch reset', { utilization: 7, resets_at: '1969-01-01T00:00:00Z' }],
  ])('accepts %s in BOTH the reader and the schema', (_label, input) => {
    const mapped = mapWindow(input);
    expect(mapped).not.toBeNull();
    expect(AccountQuotaWindowSchema.safeParse(mapped).success).toBe(true);
  });
});

describe('the reading is UNREADABLE, never 0, when it cannot be obtained', () => {
  it('returns null (not a zero reading) when there is no token', async () => {
    const { reader, fetcher } = readerWith(LIVE_PAYLOAD, { token: null });
    const got = await reader.read();
    expect(got).toBeNull();
    // Never speculatively call the provider without a credential.
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns null when the provider read throws', async () => {
    const reader = createClaudeAccountQuotaReader({
      tokenReader: async () => 'tok',
      fetcher: async () => {
        throw new Error('ECONNRESET');
      },
      now: () => 0,
    });
    await expect(reader.read()).resolves.toBeNull();
  });

  it('returns null when the token read throws', async () => {
    const reader = createClaudeAccountQuotaReader({
      tokenReader: async () => {
        throw new Error('keychain timeout');
      },
      fetcher: async () => LIVE_PAYLOAD,
      now: () => 0,
    });
    await expect(reader.read()).resolves.toBeNull();
  });

  it('never reports a zero utilization as a substitute for unknown', async () => {
    const { reader } = readerWith(null);
    const got = await reader.read();
    expect(got).toBeNull();
    // The distinction the guard depends on: a real 0% reading is an OBJECT
    // with utilization 0; an unknown reading is null. They must not collapse.
    const real = buildQuota({
      five_hour: { utilization: 0, resets_at: '2026-08-05T02:00:00Z' },
      seven_day: { utilization: 0, resets_at: '2026-08-05T02:00:00Z' },
    });
    expect(real).not.toBeNull();
    expect(real?.seven_day.utilization).toBe(0);
  });
});

describe('TTL — throttles BOTH outcomes, but never serves a stale value as fresh', () => {
  it('serves a cached success without re-reading the credential store', async () => {
    const { reader, fetcher, tokenReader, advance } = readerWith(LIVE_PAYLOAD);
    const first = await reader.read();
    advance(30_000);
    const second = await reader.read();
    expect(second).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(tokenReader).toHaveBeenCalledTimes(1);
  });

  it('re-reads once the TTL expires', async () => {
    const { reader, fetcher, advance } = readerWith(LIVE_PAYLOAD);
    await reader.read();
    advance(60_001);
    await reader.read();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('throttles a FAILING read too — an outage must not become a subprocess storm', async () => {
    let calls = 0;
    let clock = 0;
    const reader = createClaudeAccountQuotaReader({
      tokenReader: async () => {
        calls += 1;
        throw new Error('down');
      },
      fetcher: async () => LIVE_PAYLOAD,
      now: () => clock,
      ttlMs: 60_000,
    });
    expect(await reader.read()).toBeNull();
    clock += 30_000;
    expect(await reader.read()).toBeNull();
    expect(calls).toBe(1);
  });

  it('does NOT serve the last-good value once a read fails — no stale-as-fresh grace', async () => {
    let payload: unknown = LIVE_PAYLOAD;
    let clock = 0;
    const reader = createClaudeAccountQuotaReader({
      tokenReader: async () => 'tok',
      fetcher: async () => payload,
      now: () => clock,
      ttlMs: 60_000,
    });
    expect(await reader.read()).not.toBeNull();
    payload = null;
    clock += 60_001;
    // A stale low reading served as if current would PERMIT a fire the guard
    // should have refused. Unknown is the honest, fail-safe answer.
    expect(await reader.read()).toBeNull();
    // THE ASSERTION THAT ACTUALLY BITES. On a TTL miss `read()` returns the
    // FRESH sample, so a grace window is invisible on the failing read itself —
    // it only shows up on the NEXT read, inside the new TTL. Without this line
    // the test passes with `if (value !== null) cached = value` (i.e. with the
    // prototype's grace window fully reinstated), which is exactly the
    // 2026-07-26 shape: 10% cached, provider dies, guard later reads 10% and
    // fires into a window that is really at 98%.
    clock += 1;
    expect(await reader.read()).toBeNull();
  });

  it('re-samples on a BACKWARDS clock step instead of extending the TTL', async () => {
    // `now` is wall clock, not monotonic. Under `at - cachedAt < ttlMs` alone, a
    // negative delta is still "inside" the TTL, so an NTP step-back or a VM
    // resume pins a stale LOW reading for as long as the step — unbounded
    // staleness in the fail-open direction, and a direct falsification of the
    // "at most one minute" bound the TTL is justified by.
    let utilization = 10;
    let clock = 5_000_000;
    const reader = createClaudeAccountQuotaReader({
      tokenReader: async () => 'tok',
      fetcher: async () => ({
        five_hour: { utilization, resets_at: '2026-08-05T02:00:00Z' },
        seven_day: { utilization, resets_at: '2026-08-05T02:00:00Z' },
      }),
      now: () => clock,
      ttlMs: 60_000,
    });
    expect((await reader.read())?.seven_day.utilization).toBe(0.1);
    utilization = 98;
    clock -= 3_600_000; // the clock steps back an hour
    expect((await reader.read())?.seven_day.utilization).toBe(0.98);
  });

  it('treats the TTL boundary itself as expired', async () => {
    // Pins `<` rather than `<=` at exactly ttlMs, so the boundary is a decision
    // on the record instead of an accident of the comparison operator.
    const { reader, fetcher, advance } = readerWith(LIVE_PAYLOAD);
    await reader.read();
    advance(60_000);
    await reader.read();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent reads into a single provider call', async () => {
    let calls = 0;
    const reader = createClaudeAccountQuotaReader({
      tokenReader: async () => 'tok',
      fetcher: async () => {
        calls += 1;
        return LIVE_PAYLOAD;
      },
      now: () => 0,
    });
    const [a, b] = await Promise.all([reader.read(), reader.read()]);
    expect(a).toEqual(b);
    expect(calls).toBe(1);
  });
});

/**
 * #765 — the provider's usage endpoint enforces a tight, STICKY, account-level
 * rate limit, measured 2026-07-29 against the live endpoint:
 *
 *   - polls at 15s intervals: 200, 200, 200, then 429, 429, 429;
 *   - an immediate 6-request burst: 6 × 429;
 *   - and once tripped it STAYS tripped — eleven consecutive polls at 60s
 *     intervals were all 429, i.e. re-polling on a fixed TTL does not recover
 *     it, because the polling is itself what keeps the bucket empty.
 *
 * A flat 60s retry against a sticky limit is therefore part of the outage, not
 * a probe of it. These tests pin the geometric backoff that replaces it, and —
 * more importantly — pin that the longer window can NEVER be the thing keeping
 * a successful reading alive, which is the one way this could turn fail-open.
 */
describe('rate-limit backoff — a STICKY 429 must not be re-polled every TTL', () => {
  const rateLimitedReader = (opts: { maxThrottleMs?: number } = {}) => {
    let clock = 0;
    let outcome: unknown = RATE_LIMITED;
    const fetcher = vi.fn(async () => outcome);
    const reader = createClaudeAccountQuotaReader({
      tokenReader: async () => 'tok',
      fetcher,
      now: () => clock,
      ttlMs: 60_000,
      ...opts,
    });
    return {
      reader,
      fetcher,
      advance: (ms: number) => (clock += ms),
      serve: (next: unknown) => (outcome = next),
    };
  };

  it('doubles the retry window on each rate-limited sample', async () => {
    const { reader, fetcher, advance } = rateLimitedReader();
    expect(await reader.read()).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1); // window is now 120s, not 60s

    advance(60_000); // the OLD flat TTL — must NOT re-poll a limit we just hit
    expect(await reader.read()).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);

    advance(60_000); // t=120s: the doubled window has elapsed
    expect(await reader.read()).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2); // window is now 240s

    advance(120_000); // t=240s, but the window started at t=120s
    expect(await reader.read()).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);

    advance(120_000); // t=360s = 240s after the last sample
    expect(await reader.read()).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('caps the window so a permanent limit still gets probed', async () => {
    const { reader, fetcher, advance } = rateLimitedReader({ maxThrottleMs: 240_000 });
    await reader.read(); // 60s -> 120s
    advance(120_000);
    await reader.read(); // 120s -> 240s
    advance(240_000);
    await reader.read(); // 240s -> capped at 240s
    expect(fetcher).toHaveBeenCalledTimes(3);
    advance(239_999);
    await reader.read();
    expect(fetcher).toHaveBeenCalledTimes(3);
    advance(1);
    await reader.read();
    expect(fetcher).toHaveBeenCalledTimes(4); // still probing, never wedged shut
  });

  it('resets the window only on a real SUCCESS, not on any non-429 failure', async () => {
    const { reader, fetcher, advance, serve } = rateLimitedReader();
    await reader.read(); // rate-limited: window 60s -> 120s
    advance(120_000);
    serve(null); // a transport failure — NOT evidence the provider is serving
    await reader.read();
    expect(fetcher).toHaveBeenCalledTimes(2);

    // THE ASSERTION THAT BITES, and it has to sit strictly BETWEEN the two
    // windows: past the flat 60s TTL, inside the elevated 120s one. Advancing a
    // full 120s instead would sample under both rules and prove nothing.
    advance(90_000);
    await reader.read();
    expect(fetcher).toHaveBeenCalledTimes(2);

    advance(30_000); // now 120s past the last sample — the elevated window ends
    await reader.read();
    expect(fetcher).toHaveBeenCalledTimes(3);

    serve(LIVE_PAYLOAD); // now the provider really is serving again
    advance(120_000);
    expect(await reader.read()).not.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(4);
    advance(60_000); // and the window is back to the flat TTL
    await reader.read();
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  /**
   * THE FAIL-OPEN GUARD, and the reason the reset rule is "on success" rather
   * than "on any outcome". The backoff widens the window in which `read()`
   * answers from cache without re-sampling. If an elevated window could ever
   * coexist with a non-null `cached`, a LOW reading would outlive the minute
   * the TTL is justified by — the 2026-07-26 shape, and exactly what the
   * prototype's 900s grace does wrong.
   *
   * The invariant that forecloses it: the window is only ever raised by a
   * rate-limited sample, and EVERY sample stamps the cache with its own result,
   * so a raised window always coexists with `cached === null`.
   */
  it('never lets the widened window extend the life of a SUCCESSFUL reading', async () => {
    const { reader, advance, serve } = rateLimitedReader();
    serve(LIVE_PAYLOAD);
    expect(await reader.read()).not.toBeNull();

    serve(RATE_LIMITED);
    advance(60_000);
    expect(await reader.read()).toBeNull(); // window widens to 120s here

    // Deep inside the widened window. Under a grace, or under any rule that
    // kept the last-good value while the window grew, this returns the reading
    // taken 100s ago and the guard fires on it.
    advance(40_000);
    expect(await reader.read()).toBeNull();
  });

  it('reports entering and leaving the backoff ONCE each, not on every read', async () => {
    // Without this the endpoint is undiagnosable from outside: "studio says
    // null" looks identical whether the credential is missing, the provider is
    // down, or the account is rate-limited — which is precisely the ambiguity
    // that produced #765's original (wrong) diagnosis.
    const log = vi.fn();
    let clock = 0;
    let outcome: unknown = RATE_LIMITED;
    const reader = createClaudeAccountQuotaReader({
      tokenReader: async () => 'tok',
      fetcher: async () => outcome,
      now: () => clock,
      ttlMs: 60_000,
      log,
    });
    await reader.read();
    clock += 120_000;
    await reader.read(); // still limited — must not log again
    expect(log.mock.calls.map((c) => (c[0] as { event: string }).event)).toEqual(['rate_limited']);

    outcome = LIVE_PAYLOAD;
    clock += 240_000;
    await reader.read();
    expect(log.mock.calls.map((c) => (c[0] as { event: string }).event)).toEqual([
      'rate_limited',
      'rate_limit_cleared',
    ]);
  });

  it('reports the window it ACTUALLY adopted, even when the cap binds immediately', async () => {
    // `throttleMs * 2` and the adopted window diverge as soon as the cap binds,
    // and a log line that overstates the backoff is actively misleading when its
    // only job is explaining why the guard is blind.
    const log = vi.fn();
    const reader = createClaudeAccountQuotaReader({
      tokenReader: async () => 'tok',
      fetcher: async () => RATE_LIMITED,
      now: () => 0,
      ttlMs: 60_000,
      maxThrottleMs: 90_000, // caps below the doubled 120s
      log,
    });
    await reader.read();
    expect(log).toHaveBeenCalledWith({ event: 'rate_limited', throttleMs: 90_000 });
  });

  it('still reports the transition ONCE when the cap disables the backoff entirely', async () => {
    // `maxThrottleMs === ttlMs` pins the window, so "am I already backed off?"
    // cannot be inferred from the window having moved — it never moves. Inferring
    // it repeats the log on every read and never reports the recovery at all.
    const log = vi.fn();
    let clock = 0;
    let outcome: unknown = RATE_LIMITED;
    const reader = createClaudeAccountQuotaReader({
      tokenReader: async () => 'tok',
      fetcher: async () => outcome,
      now: () => clock,
      ttlMs: 60_000,
      maxThrottleMs: 60_000,
      log,
    });
    await reader.read();
    clock += 60_000;
    await reader.read();
    clock += 60_000;
    await reader.read();
    expect(log.mock.calls.map((c) => (c[0] as { event: string }).event)).toEqual(['rate_limited']);

    outcome = LIVE_PAYLOAD;
    clock += 60_000;
    await reader.read();
    expect(log.mock.calls.map((c) => (c[0] as { event: string }).event)).toEqual([
      'rate_limited',
      'rate_limit_cleared',
    ]);
  });

  it('a throwing log sink can neither lose a reading nor disable the backoff', async () => {
    // `applyOutcome` runs in the `.then`, OUTSIDE `sample()`'s catch-all, so an
    // unisolated sink escapes into `inFlight` and rejects `read()` — which the
    // route turns into UNREADABLE, spending a blind fire on a provider call that
    // actually SUCCEEDED. Worse, on the rate-limited branch the throw lands
    // before the window is widened, so a broken logger silently disables the
    // backoff. An observability sink must not alter what it observes.
    const log = vi.fn(() => {
      throw new Error('sink down');
    });
    let clock = 0;
    let outcome: unknown = RATE_LIMITED;
    const fetcher = vi.fn(async () => outcome);
    const reader = createClaudeAccountQuotaReader({
      tokenReader: async () => 'tok',
      fetcher,
      now: () => clock,
      ttlMs: 60_000,
      log,
    });

    await expect(reader.read()).resolves.toBeNull();
    clock += 60_000; // past the flat TTL — only the widened window suppresses this
    await reader.read();
    expect(fetcher).toHaveBeenCalledTimes(1);

    clock += 60_000; // the 120s window has now elapsed
    outcome = LIVE_PAYLOAD;
    await expect(reader.read()).resolves.not.toBeNull(); // recovery log throws too
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('absorbs an ASYNC log sink that rejects, without an unhandled rejection', async () => {
    // `log` is typed `(event) => void`, but that does not stop an `async` sink:
    // TypeScript permits a value-returning function where `void` is expected, so
    // `async () => { throw }` type-checks and its rejection escapes a purely
    // synchronous `catch`. Node terminates the process on an unhandled rejection
    // by default, so this shape is strictly WORSE than the sync throw above —
    // an observability sink taking the server down is the same guarantee
    // violated, harder. Verified by listening for the real process event rather
    // than by inspecting the reader, because "did it stay unhandled?" is a
    // property of the runtime, not of the return value.
    //
    // The sink here is a PLAIN async function and must stay one: wrapping it in
    // `vi.fn` makes this test vacuous, measured. Tinyspy records a spy's
    // settled result, which it can only do by attaching a handler to the
    // returned promise — so the spy itself handles the rejection and the guard
    // under test is never needed. A bare async function leaves it genuinely
    // unhandled. Hence the manual call counter.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      let logCalls = 0;
      const log = async () => {
        logCalls += 1;
        throw new Error('async sink down');
      };
      let clock = 0;
      let outcome: unknown = RATE_LIMITED;
      const reader = createClaudeAccountQuotaReader({
        tokenReader: async () => 'tok',
        fetcher: async () => outcome,
        now: () => clock,
        ttlMs: 60_000,
        // An async sink IS the hazard under test, so `no-misused-promises`
        // firing here is the point: it is the FIRST line of defence, and the
        // fact that it fires proves the shape is reachable rather than
        // theoretical. It is not the ONLY line, because it is a lint rule — it
        // cannot see a sink arriving through an `any`, a JS caller, or a
        // dynamically-built options object, and this module is exported for
        // embedders who need not run our eslint config. Hence the runtime guard.
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        log,
      });

      await expect(reader.read()).resolves.toBeNull(); // 'rate_limited' fires
      clock += 120_000;
      outcome = LIVE_PAYLOAD;
      await expect(reader.read()).resolves.not.toBeNull(); // 'rate_limit_cleared'
      expect(logCalls).toBe(2);

      // A macrotask: Node only reports an unhandled rejection once the microtask
      // queue has drained, so asserting before this would pass vacuously.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('floors the cap at the TTL, so a bad ceiling cannot SHORTEN the throttle', async () => {
    // Without the `Math.max(ttlMs, …)` floor, `maxThrottleMs: 1_000` makes a 429
    // *shrink* the window to 1s — the reader would then hammer a rate-limited
    // endpoint 60× faster than its own base TTL, which is the exact behaviour
    // this whole change exists to prevent, triggered by a misconfigured ceiling.
    const { reader, fetcher, advance } = rateLimitedReader({ maxThrottleMs: 1_000 });
    await reader.read();
    advance(59_999);
    await reader.read();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('degrades to UNREADABLE, never to a reading, if the sentinel is not recognised', async () => {
    // Defence in depth: even with the identity check gone, the sentinel must
    // not map to a quota. It survives `buildQuota` as `null`, so the worst a
    // missed check can do is lose the backoff — never invent a number.
    expect(buildQuota(RATE_LIMITED)).toBeNull();
  });
});

/**
 * The two functions that do the REAL work. Every test above injects a seam past
 * them, so without this block a typo in `claudeAiOauth`/`accessToken`, a wrong
 * beta header, or a broken non-200 branch would leave the feature returning
 * `null` forever on the operator's machine while the whole suite stayed green —
 * and the symptom ("quota unreadable") is indistinguishable from a normal
 * provider outage, so nothing would point at the bug.
 */
describe('readKeychainToken — the credential-store path', () => {
  const blob = (o: unknown) => async () => JSON.stringify(o);

  it('extracts the access token from the credential blob', async () => {
    const token = await readKeychainToken(
      blob({ claudeAiOauth: { accessToken: 'sk-abc' } }),
      'darwin',
    );
    expect(token).toBe('sk-abc');
  });

  it('passes the right service name and the bounded timeout', async () => {
    let seen: { service?: string; timeoutMs?: number } = {};
    await readKeychainToken(async (service, timeoutMs) => {
      seen = { service, timeoutMs };
      return JSON.stringify({ claudeAiOauth: { accessToken: 'x' } });
    }, 'darwin');
    expect(seen.service).toBe('Claude Code-credentials');
    expect(seen.timeoutMs).toBe(2_000);
  });

  it('leaves the two I/O bounds summing to less than the consumer budget', async () => {
    // The property that actually matters, and the one nothing else pinned:
    // `loop/drive.sh` calls this endpoint with `curl --max-time 8`, and a curl
    // timeout reads as UNREADABLE — i.e. it SPENDS one of the guard's bounded
    // blind fires. Raising either bound past the budget converts a slow read
    // into a blind fire, silently.
    let keychainMs = 0;
    await readKeychainToken(async (_s, timeoutMs) => {
      keychainMs = timeoutMs;
      return JSON.stringify({ claudeAiOauth: { accessToken: 'x' } });
    }, 'darwin');
    let httpMs = 0;
    await fetchUsage('t', ((_url: string, init: RequestInit) => {
      // The abort signal carries the HTTP bound; read it by racing the timer.
      const started = Date.now();
      return new Promise<never>((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener('abort', () => {
          httpMs = Date.now() - started;
          reject(new Error('aborted'));
        });
      });
    }) as unknown as typeof fetch);
    expect(httpMs).toBeGreaterThan(0);
    expect(keychainMs + httpMs).toBeLessThan(8_000);
  });

  it('never spawns anything off darwin', async () => {
    let called = false;
    const token = await readKeychainToken(async () => {
      called = true;
      return 'x';
    }, 'linux');
    expect(token).toBeNull();
    expect(called).toBe(false);
  });

  it.each([
    ['the command failed', async () => null],
    ['the blob is not JSON', async () => 'not json'],
    ['the blob is not an object', async () => '"a string"'],
    ['claudeAiOauth is missing', blob({ other: 1 })],
    ['claudeAiOauth is not an object', blob({ claudeAiOauth: 'nope' })],
    ['accessToken is missing', blob({ claudeAiOauth: {} })],
    ['accessToken is not a string', blob({ claudeAiOauth: { accessToken: 42 } })],
    ['accessToken is empty', blob({ claudeAiOauth: { accessToken: '' } })],
  ])('returns null when %s', async (_label, runner) => {
    await expect(readKeychainToken(runner as never, 'darwin')).resolves.toBeNull();
  });

  it('returns null rather than propagating a runner throw', async () => {
    await expect(
      readKeychainToken(async () => {
        throw new Error('keychain hung');
      }, 'darwin'),
    ).resolves.toBeNull();
  });
});

describe('fetchUsage — the provider path', () => {
  const okRes = (body: unknown) =>
    ({ status: 200, json: async () => body, body: null }) as unknown as Response;

  it('sends the OAuth bearer and the beta header, and returns the payload', async () => {
    let init: RequestInit | undefined;
    const payload = await fetchUsage('sk-abc', (async (_url: string, i: RequestInit) => {
      init = i;
      return okRes({ seven_day: { utilization: 7 } });
    }) as unknown as typeof fetch);
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-abc');
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(payload).toEqual({ seven_day: { utilization: 7 } });
  });

  const drainableRes = (status: number, onCancel: () => void) =>
    ({
      status,
      json: async () => ({}),
      body: { cancel: async () => onCancel() },
    }) as unknown as Response;

  it('reports a 429 as RATE_LIMITED — distinctly from every other failure', async () => {
    // 429 is the ROUTINE branch here — the provider rate-limits this endpoint —
    // and #765 measured that the limit is STICKY, so the reader has to be able
    // to tell "slow down" apart from "something broke" to back off correctly.
    let cancelled = false;
    const res = drainableRes(429, () => (cancelled = true));
    await expect(fetchUsage('t', (async () => res) as unknown as typeof fetch)).resolves.toBe(
      RATE_LIMITED,
    );
    expect(cancelled).toBe(true);
  });

  it('returns null on any OTHER non-200 and drains the body', async () => {
    let cancelled = false;
    const res = drainableRes(500, () => (cancelled = true));
    await expect(fetchUsage('t', (async () => res) as unknown as typeof fetch)).resolves.toBeNull();
    expect(cancelled).toBe(true);
  });

  it('returns null when the transport throws', async () => {
    const thrower = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    await expect(fetchUsage('t', thrower)).resolves.toBeNull();
  });

  it('returns null when the body is not JSON', async () => {
    const res = {
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    } as unknown as Response;
    await expect(fetchUsage('t', (async () => res) as unknown as typeof fetch)).resolves.toBeNull();
  });

  it('swallows a header-validation throw from a token containing CR/LF', async () => {
    // The one escape vector `connectors/redact.ts` documents: Node's header
    // validation raises a TypeError QUOTING THE HEADER VALUE, which would put
    // the credential into an error message. Using the REAL fetch here on
    // purpose — the throw comes from the runtime, not from a stub.
    await expect(fetchUsage('tok\r\nX-Evil: 1')).resolves.toBeNull();
  });
});

describe('the credential never escapes', () => {
  it('does not put the token in the returned reading', async () => {
    // `GET /api/quota` is UNAUTHENTICATED (it is a machine surface for a
    // localhost consumer), so anything the reading carries is readable by
    // anyone who can reach the port. The reader holds the OAuth token in
    // memory; this pins that it never travels out in the value.
    const { reader } = readerWith(LIVE_PAYLOAD);
    const got = await reader.read();
    expect(got).not.toBeNull();
    expect(JSON.stringify(got)).not.toContain('tok');
  });

  it('does not put the token in the reading when the provider echoes it back', async () => {
    // A hostile/buggy upstream is the case the assertion above cannot see: the
    // token reaching the reading via the PAYLOAD rather than via the reader's
    // own state. It cannot, because `mapWindow` and `buildQuota` WHITELIST-
    // construct fresh objects rather than spreading the input. (`.strict()` is
    // the second line of defence and behaves differently — it REJECTS an
    // unknown key, turning the whole reading into an honest `null`, rather than
    // dropping it.) Either way the token never reaches the wire; this pins it.
    const { reader } = readerWith({
      ...LIVE_PAYLOAD,
      leaked: 'tok',
      seven_day: { ...(LIVE_PAYLOAD as { seven_day: object }).seven_day, echoed_token: 'tok' },
    });
    const got = await reader.read();
    expect(got).not.toBeNull();
    expect(JSON.stringify(got)).not.toContain('tok');
  });
});
