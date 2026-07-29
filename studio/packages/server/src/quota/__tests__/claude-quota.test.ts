import { describe, it, expect, vi } from 'vitest';
import { AccountQuotaWindowSchema } from '@autonomy-studio/shared';
import {
  createClaudeQuotaReader,
  mapWindow,
  buildQuota,
  readKeychainToken,
  fetchUsage,
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
  const reader = createClaudeQuotaReader({
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
      source: 'live',
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
    const reader = createClaudeQuotaReader({
      tokenReader: async () => 'tok',
      fetcher: async () => {
        throw new Error('ECONNRESET');
      },
      now: () => 0,
    });
    await expect(reader.read()).resolves.toBeNull();
  });

  it('returns null when the token read throws', async () => {
    const reader = createClaudeQuotaReader({
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
    const reader = createClaudeQuotaReader({
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
    const reader = createClaudeQuotaReader({
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
  });

  it('collapses concurrent reads into a single provider call', async () => {
    let calls = 0;
    const reader = createClaudeQuotaReader({
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
    // Must stay under the consumer's `curl --max-time 8` budget alongside the
    // 3s HTTP bound, or a slow read spends a bounded blind fire.
    expect(seen.timeoutMs).toBeLessThanOrEqual(3_000);
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

  it('returns null on a non-200 and drains the body', async () => {
    let cancelled = false;
    const res = {
      status: 429,
      json: async () => ({}),
      body: {
        cancel: async () => {
          cancelled = true;
        },
      },
    } as unknown as Response;
    // 429 is the ROUTINE branch here — the provider rate-limits this endpoint.
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
    // own state. `buildQuota` is `.strict()` all the way down, so an extra key
    // is dropped rather than passed through — that is what this pins.
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
