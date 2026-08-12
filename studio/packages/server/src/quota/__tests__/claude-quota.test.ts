import { describe, it, expect, vi } from 'vitest';
import { AccountQuotaWindowSchema } from '@autonomy-studio/shared';
import {
  createClaudeAccountQuotaReader,
  mapWindow,
  buildQuota,
  readKeychainToken,
  fetchUsage,
  RATE_LIMITED,
  UNREADABLE_ACCOUNT_QUOTA_READER,
  type ClaudeAccountQuotaReader,
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

/**
 * The reading alone. Since #825 `read()` resolves to `{ value, unavailable }`
 * so the reason and the reading it explains are always the SAME sample; these
 * tests are about the reading, so they unwrap it here rather than at 28 call
 * sites. The pairing itself is asserted in its own describe block below.
 */
const readValue = async (r: ClaudeAccountQuotaReader) => (await r.read()).value;

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
  ])('never GUESSES a zone for a timestamp with %s', (_label, ts) => {
    // `Date.parse` reads an offset-less date-TIME as LOCAL time (ECMA-262),
    // where the prototype assumed UTC — a silent skew of up to 14 hours by
    // host zone. It also accepts forms the prototype rejected outright, which
    // would turn "malformed → null" into "malformed → a plausible wrong
    // number". So the INSTANT is refused — but that refusal is now confined to
    // the field it is about (#1023): the utilization beside it was never in
    // doubt, and discarding it would be the veto this ticket removed.
    expect(mapWindow({ utilization: 7, resets_at: ts })).toEqual({
      utilization: 0.07,
      resets_at: null,
    });
  });

  it.each([
    ['an absent key', {}],
    ['an explicit null', { resets_at: null }],
    ['an unparseable string', { resets_at: 'not-a-date' }],
    // The same provider family sends codex's reset as epoch SECONDS
    // (`mapCodexWindow`), so a bare number reaching this reader is a plausible
    // contract drift rather than a hypothetical. It is not an ISO string and is
    // not guessed at — but it is also not grounds to discard the utilization.
    ['a bare epoch number', { resets_at: 1_785_100_200 }],
    ['a wrongly-typed object', { resets_at: { at: '2026-08-05T02:00:00Z' } }],
  ])('reports an unknown reset instant as null and KEEPS the window: %s', (_label, reset) => {
    expect(mapWindow({ utilization: 7, ...reset })).toEqual({
      utilization: 0.07,
      resets_at: null,
    });
  });
});

describe('buildQuota — the 7-day window IS the reading; the 5-hour one is optional', () => {
  it('builds both windows from a full payload', () => {
    expect(buildQuota(LIVE_PAYLOAD)).toEqual({
      five_hour: { utilization: 0.08, resets_at: expect.any(Number) },
      seven_day: { utilization: 0.07, resets_at: expect.any(Number) },
    });
  });

  /**
   * #1023 — the measured defect. The provider stops reporting `five_hour` when
   * there is no active session, and the all-or-nothing rule inherited from the
   * prototype turned that into UNREADABLE for the WHOLE reading — including the
   * 7-day figure the spend guard is the entire consumer of.
   */
  it.each([
    ['an absent five_hour', { seven_day: LIVE_PAYLOAD.seven_day }],
    ['an explicitly null five_hour', { ...LIVE_PAYLOAD, five_hour: null }],
    ['a malformed five_hour', { ...LIVE_PAYLOAD, five_hour: { utilization: 'x' } }],
    ['a five_hour that is not an object', { ...LIVE_PAYLOAD, five_hour: 'nope' }],
  ])('still reports the 7-day window when there is %s', (_label, input) => {
    expect(buildQuota(input)).toEqual({
      seven_day: { utilization: 0.07, resets_at: expect.any(Number) },
    });
  });

  it('OMITS the five_hour key rather than sending it as null', () => {
    // `.optional()`, not `.nullable()`: on this surface a `null` means "present
    // and unreadable" (that is what `account.claude: null` says), so sending one
    // for a window the provider simply did not report would claim a failed read
    // that never happened. An absent key is the honest encoding, and it is the
    // one `CodexAccountQuotaSchema` already uses for the same fact.
    expect(buildQuota({ seven_day: LIVE_PAYLOAD.seven_day })).not.toHaveProperty('five_hour');
  });

  it.each([
    ['a missing seven_day', { five_hour: LIVE_PAYLOAD.five_hour }],
    ['a malformed seven_day', { ...LIVE_PAYLOAD, seven_day: { utilization: 'x' } }],
    ['a null seven_day', { ...LIVE_PAYLOAD, seven_day: null }],
    ['a non-object', null],
  ])('degrades %s to null — a reading with no 7-day window is not a reading', (_label, input) => {
    expect(buildQuota(input)).toBeNull();
  });

  it('ignores top-level keys it does not know', () => {
    // The live payload carries a dozen sibling keys (other window kinds, a
    // spend block, a limits array). `buildQuota` reads two of them and applies
    // no payload-level `.strict()`, so a provider ADDING a key must never be a
    // contract break. Nothing pinned that before #1023.
    expect(
      buildQuota({
        ...LIVE_PAYLOAD,
        seven_day_opus: null,
        speckled_hen: { utilization: 0.0, resets_at: null },
        limits: [{ kind: 'session', percent: 9 }],
        spend: { percent: 0, enabled: false },
      }),
    ).toEqual({
      five_hour: { utilization: 0.08, resets_at: expect.any(Number) },
      seven_day: { utilization: 0.07, resets_at: expect.any(Number) },
    });
  });
});

/**
 * #1023's actual subject, stated as a property rather than as a list of bugs.
 *
 * The build loop runs TWO readers against this one endpoint: this one, and
 * `loop/claude_usage.py`, which reads `seven_day.utilization` and nothing else.
 * For three days they disagreed on the same bytes in the same second — the
 * python one returned a percentage, this one returned `unrecognized_payload` —
 * because this one vetoed the whole reading over fields the guard never reads.
 *
 * The fix is not "handle the field that happened to be at fault". It is that
 * this reader's accept-set now CONTAINS the python one's, so that disagreement
 * is unreachable. Each case below is a payload the python reader accepts (its
 * own suite pins the first two by name), and every one of them must produce a
 * reading here.
 */
describe('#1023 — a payload the guard’s other reader accepts is never UNREADABLE here', () => {
  it.each([
    ['no five_hour at all', { seven_day: { utilization: 48.0, resets_at: null } }],
    ['an unparseable resets_at', { seven_day: { utilization: 48.0, resets_at: 'not-a-date' } }],
    ['no resets_at at all', { seven_day: { utilization: 48.0 } }],
    ['a null five_hour', { five_hour: null, seven_day: { utilization: 48.0 } }],
    ['an inactive five_hour', { five_hour: { utilization: 0.0, resets_at: null }, seven_day: { utilization: 48.0 } }],
    ['a zero reading', { seven_day: { utilization: 0 } }],
    ['an overage reading', { seven_day: { utilization: 143.7 } }],
  ])('reads the 7-day window when the payload has %s', (_label, payload) => {
    expect(buildQuota(payload)?.seven_day.utilization).toBe(
      (payload.seven_day as { utilization: number }).utilization / 100,
    );
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
    // #1023 widened the accept-set; this table is the thing that stops it
    // widening past the schema, so the new members belong in it.
    ['an unreported reset', { utilization: 7 }],
    ['an explicitly null reset', { utilization: 7, resets_at: null }],
    ['an unparseable reset', { utilization: 7, resets_at: 'not-a-date' }],
  ])('accepts %s in BOTH the reader and the schema', (_label, input) => {
    const mapped = mapWindow(input);
    expect(mapped).not.toBeNull();
    expect(AccountQuotaWindowSchema.safeParse(mapped).success).toBe(true);
  });
});

describe('the reading is UNREADABLE, never 0, when it cannot be obtained', () => {
  it('returns null (not a zero reading) when there is no token', async () => {
    const { reader, fetcher } = readerWith(LIVE_PAYLOAD, { token: null });
    const got = await readValue(reader);
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
    await expect(readValue(reader)).resolves.toBeNull();
  });

  it('returns null when the token read throws', async () => {
    const reader = createClaudeAccountQuotaReader({
      tokenReader: async () => {
        throw new Error('keychain timeout');
      },
      fetcher: async () => LIVE_PAYLOAD,
      now: () => 0,
    });
    await expect(readValue(reader)).resolves.toBeNull();
  });

  it('never reports a zero utilization as a substitute for unknown', async () => {
    const { reader } = readerWith(null);
    const got = await readValue(reader);
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
    const first = await readValue(reader);
    advance(30_000);
    const second = await readValue(reader);
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
    expect(await readValue(reader)).toBeNull();
    clock += 30_000;
    expect(await readValue(reader)).toBeNull();
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
    expect(await readValue(reader)).not.toBeNull();
    payload = null;
    clock += 60_001;
    // A stale low reading served as if current would PERMIT a fire the guard
    // should have refused. Unknown is the honest, fail-safe answer.
    expect(await readValue(reader)).toBeNull();
    // THE ASSERTION THAT ACTUALLY BITES. On a TTL miss `read()` returns the
    // FRESH sample, so a grace window is invisible on the failing read itself —
    // it only shows up on the NEXT read, inside the new TTL. Without this line
    // the test passes with `if (value !== null) cached = value` (i.e. with the
    // prototype's grace window fully reinstated), which is exactly the
    // 2026-07-26 shape: 10% cached, provider dies, guard later reads 10% and
    // fires into a window that is really at 98%.
    clock += 1;
    expect(await readValue(reader)).toBeNull();
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
    expect((await readValue(reader))?.seven_day.utilization).toBe(0.1);
    utilization = 98;
    clock -= 3_600_000; // the clock steps back an hour
    expect((await readValue(reader))?.seven_day.utilization).toBe(0.98);
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
    expect(await readValue(reader)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1); // window is now 120s, not 60s

    advance(60_000); // the OLD flat TTL — must NOT re-poll a limit we just hit
    expect(await readValue(reader)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);

    advance(60_000); // t=120s: the doubled window has elapsed
    expect(await readValue(reader)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2); // window is now 240s

    advance(120_000); // t=240s, but the window started at t=120s
    expect(await readValue(reader)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);

    advance(120_000); // t=360s = 240s after the last sample
    expect(await readValue(reader)).toBeNull();
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
    expect(await readValue(reader)).not.toBeNull();
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
    expect(await readValue(reader)).not.toBeNull();

    serve(RATE_LIMITED);
    advance(60_000);
    expect(await readValue(reader)).toBeNull(); // window widens to 120s here

    // Deep inside the widened window. Under a grace, or under any rule that
    // kept the last-good value while the window grew, this returns the reading
    // taken 100s ago and the guard fires on it.
    advance(40_000);
    expect(await readValue(reader)).toBeNull();
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

    await expect(readValue(reader)).resolves.toBeNull();
    clock += 60_000; // past the flat TTL — only the widened window suppresses this
    await reader.read();
    expect(fetcher).toHaveBeenCalledTimes(1);

    clock += 60_000; // the 120s window has now elapsed
    outcome = LIVE_PAYLOAD;
    await expect(readValue(reader)).resolves.not.toBeNull(); // recovery log throws too
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

      await expect(readValue(reader)).resolves.toBeNull(); // 'rate_limited' fires
      clock += 120_000;
      outcome = LIVE_PAYLOAD;
      await expect(readValue(reader)).resolves.not.toBeNull(); // 'rate_limit_cleared'
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
    const got = await readValue(reader);
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
    const got = await readValue(reader);
    expect(got).not.toBeNull();
    expect(JSON.stringify(got)).not.toContain('tok');
  });
});

/**
 * #825 — WHY a reading is missing, paired with the missing reading itself.
 *
 * `read()` already distinguished these causes internally and then collapsed
 * them all to `null`. The C3 decision (park the old engine, #410) is made on a
 * run of `quota shadow: studio UNREADABLE` lines, which cannot tell "this
 * reader is broken" from "the shared account bucket was contended" — so the
 * cause has to survive out to the caller. It is ADVISORY: it rides alongside
 * the reading and can never be one.
 */
describe('#825 — unavailable reason', () => {
  it('is null exactly when a reading was obtained', async () => {
    const { reader } = readerWith(LIVE_PAYLOAD);
    const got = await reader.read();
    expect(got.value).not.toBeNull();
    expect(got.unavailable).toBeNull();
  });

  it('reports no_credential when the credential store yields nothing', async () => {
    const { reader } = readerWith(LIVE_PAYLOAD, { token: null });
    // Also the non-darwin case: `readKeychainToken` returns null for a host
    // with no Keychain, indistinguishably, and this enum does not pretend
    // otherwise (see the schema's doc block).
    await expect(reader.read()).resolves.toEqual({ value: null, unavailable: 'no_credential' });
  });

  it('reports rate_limited on a 429 — the case the C3 evidence keeps hitting', async () => {
    const { reader } = readerWith(RATE_LIMITED);
    await expect(reader.read()).resolves.toEqual({ value: null, unavailable: 'rate_limited' });
  });

  it('reports provider_error when the provider call fails outright', async () => {
    // `fetchUsage` collapses every non-429 failure to null.
    const { reader } = readerWith(null);
    await expect(reader.read()).resolves.toEqual({ value: null, unavailable: 'provider_error' });
  });

  it('reports unrecognized_payload when the provider answers with the wrong shape', async () => {
    // The distinction that matters operationally: the provider IS serving us,
    // so this is a contract break to chase, not a bucket to wait out.
    const { reader } = readerWith({ five_hour: { utilization: 8.0 } });
    await expect(reader.read()).resolves.toEqual({
      value: null,
      unavailable: 'unrecognized_payload',
    });
  });

  it('reports reader_error when the reader itself throws', async () => {
    const reader = createClaudeAccountQuotaReader({
      tokenReader: async () => {
        throw new Error('keychain timeout');
      },
      now: () => 0,
    });
    await expect(reader.read()).resolves.toEqual({ value: null, unavailable: 'reader_error' });
  });

  it('the disabled reader says so, rather than blaming the provider', async () => {
    await expect(UNREADABLE_ACCOUNT_QUOTA_READER.read()).resolves.toEqual({
      value: null,
      unavailable: 'disabled',
    });
  });

  it('serves the CACHED sample its own reason, not a later one', async () => {
    // The reason must belong to the sample that produced the served value.
    // The regression this actually bites on: a cache hit that returns the
    // stamped value but recomputes (or forgets) the reason — here, serving the
    // cached `null` with `unavailable: null`, an unattributed UNREADABLE.
    let payload: unknown = RATE_LIMITED;
    let clock = 0;
    const reader = createClaudeAccountQuotaReader({
      tokenReader: async () => 'tok',
      fetcher: async () => payload,
      now: () => clock,
      ttlMs: 60_000,
      maxThrottleMs: 60_000,
    });
    await expect(reader.read()).resolves.toEqual({ value: null, unavailable: 'rate_limited' });
    payload = LIVE_PAYLOAD;
    clock += 30_000; // inside the window: the cached sample must answer, reason included
    await expect(reader.read()).resolves.toEqual({ value: null, unavailable: 'rate_limited' });
    clock += 30_001; // window elapsed: a fresh sample, and the reason clears with it
    const fresh = await reader.read();
    expect(fresh.value).not.toBeNull();
    expect(fresh.unavailable).toBeNull();
  });

  it('re-attributes when the cause changes under a widened window', async () => {
    // The stale-log problem stated at `applyOutcome`: after a rate-limit the
    // backoff log stays `rate_limited` even once the real cause has become a
    // missing credential. The PER-READ reason does not inherit that — it is
    // whatever the last sample actually found.
    let token: string | null = 'tok';
    let clock = 0;
    const reader = createClaudeAccountQuotaReader({
      tokenReader: async () => token,
      fetcher: async () => RATE_LIMITED,
      now: () => clock,
      ttlMs: 60_000,
    });
    await expect(reader.read()).resolves.toEqual({ value: null, unavailable: 'rate_limited' });
    token = null;
    clock += 120_001; // past the widened window
    await expect(reader.read()).resolves.toEqual({ value: null, unavailable: 'no_credential' });
  });

  it('never lets a reason accompany a reading', async () => {
    // The one thing this field must never do, over every PAYLOAD shape the
    // fetcher can return. (Not every reason: `no_credential`, `reader_error`
    // and `disabled` are reached by the cases above, not by varying a payload.)
    for (const payload of [LIVE_PAYLOAD, RATE_LIMITED, null, { five_hour: {} }, undefined]) {
      const { reader } = readerWith(payload);
      const got = await reader.read();
      expect(got.value === null).toBe(got.unavailable !== null);
    }
  });
});
