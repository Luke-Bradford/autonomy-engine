import { describe, it, expect, vi } from 'vitest';
import { createClaudeQuotaReader, mapWindow, buildQuota } from '../claude-quota.js';

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
  ])('degrades %s to null rather than guessing', (_label, input) => {
    expect(mapWindow(input)).toBeNull();
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

describe('the credential never escapes', () => {
  it('does not put the token in the returned reading', async () => {
    const { reader } = readerWith(LIVE_PAYLOAD);
    const got = await reader.read();
    expect(JSON.stringify(got)).not.toContain('tok');
  });
});
