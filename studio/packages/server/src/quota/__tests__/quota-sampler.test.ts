import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createClaudeAccountQuotaReader,
  RATE_LIMITED,
  DEFAULT_QUOTA_SAMPLE_INTERVAL_MS,
  type ClaudeAccountQuotaReader,
} from '../claude-quota.js';
import { startClaudeQuotaSampler } from '../quota-sampler.js';

/**
 * #765 — the background sampler that keeps `GET /api/quota` WARM.
 *
 * The sampler itself is four lines of timer; everything that could go wrong
 * here is a property of how it composes with the reader, so that is what these
 * assert:
 *
 *   - it adds NO provider volume beyond the reader's own TTL, and it does not
 *     defeat the 429 backoff (the two ways an unwanted poller shows up as a
 *     rate-limited account rather than as a bug);
 *   - it never holds the process open (`unref`), and it stops on `stop()`;
 *   - a reader that breaks its "never throws" contract cannot take the process
 *     down with an unhandled rejection.
 *
 * There is deliberately NO test that the sampler serves a stale value, because
 * it never serves anything: it calls `read()` and discards the result. The
 * no-grace / no-last-good property lives entirely in the reader and is pinned
 * by `claude-quota.test.ts`.
 */

const LIVE_PAYLOAD = {
  five_hour: { utilization: 8.0, resets_at: '2026-07-29T19:10:00.789612+00:00' },
  seven_day: { utilization: 7.0, resets_at: '2026-08-05T02:00:00.789638+00:00' },
};

const TTL_MS = 60_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Drives BOTH clocks by the same step.
 *
 * The reader's TTL reads `opts.now`, not `Date.now()` — and this package's
 * vitest config does not fake `Date` — so advancing only the timer clock would
 * leave every sample looking simultaneous and the TTL would never expire.
 * `advanceTimersByTimeAsync` (not the sync form) is load-bearing: `read()`
 * de-dupes concurrent calls through an `inFlight` promise, so under the sync
 * form the first tick's promise would never settle and every later tick would
 * return it — one provider call total, and a backoff assertion that passes just
 * as happily with the backoff deleted.
 */
function clockPair(start = 1_000_000) {
  let clock = start;
  return {
    now: () => clock,
    tick: async (ms: number) => {
      clock += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
}

describe('startClaudeQuotaSampler — cadence', () => {
  it('primes immediately, before any interval has elapsed', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => ({ value: null, unavailable: 'no_credential' }) as const);
    const sampler = startClaudeQuotaSampler({ read }, { intervalMs: 30_000 });
    // No timer advance at all: the warm cache exists from boot, not from the
    // first tick a minute later. A KeepAlive restart otherwise reintroduces the
    // live request-path poll for the consumer's very next read.
    expect(read).toHaveBeenCalledTimes(1);
    sampler.stop();
  });

  it('reads once per interval thereafter', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => ({ value: null, unavailable: 'no_credential' }) as const);
    const sampler = startClaudeQuotaSampler({ read }, { intervalMs: 30_000 });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(read).toHaveBeenCalledTimes(4); // prime + 3 ticks
    sampler.stop();
  });

  it('stops on stop(), and stop() is idempotent', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => ({ value: null, unavailable: 'no_credential' }) as const);
    const sampler = startClaudeQuotaSampler({ read }, { intervalMs: 30_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(read).toHaveBeenCalledTimes(2);
    sampler.stop();
    sampler.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('startClaudeQuotaSampler — provider volume', () => {
  it('adds NO provider calls beyond the reader TTL: 20 ticks over 10 minutes is 11 fetches', async () => {
    vi.useFakeTimers();
    const { now, tick } = clockPair();
    const fetcher = vi.fn(async () => LIVE_PAYLOAD);
    const reader = createClaudeAccountQuotaReader({
      tokenReader: async () => 'tok',
      fetcher,
      now,
      ttlMs: TTL_MS,
    });
    const sampler = startClaudeQuotaSampler(reader, { intervalMs: TTL_MS / 2 });
    for (let i = 0; i < 20; i += 1) await tick(TTL_MS / 2);
    // 21 sample attempts (prime + 20 ticks); the ten that land INSIDE the TTL
    // are pure cache hits and touch nothing. This is the whole claim the flag
    // rests on — the sampler changes WHEN the one-per-TTL call happens, not how
    // many there are.
    expect(fetcher).toHaveBeenCalledTimes(11); // t=0,60,120,…,600
    sampler.stop();
  });

  it('does not defeat the 429 backoff: 40 ticks under a sticky rate limit is 4 fetches', async () => {
    vi.useFakeTimers();
    const { now, tick } = clockPair();
    const fetcher = vi.fn(async () => RATE_LIMITED);
    const reader = createClaudeAccountQuotaReader({
      tokenReader: async () => 'tok',
      fetcher,
      now,
      ttlMs: TTL_MS,
    });
    const sampler = startClaudeQuotaSampler(reader, { intervalMs: TTL_MS / 2 });
    for (let i = 0; i < 40; i += 1) await tick(TTL_MS / 2);
    // The geometric backoff (60s → 120 → 240 → 480, capped) means the fetches
    // land at t=0, 120s, 360s, 840s — FOUR calls in twenty minutes, against
    // forty ticks and the twenty a flat TTL would have produced. Without the
    // backoff this is 20; with a sampler that bypassed the reader's cache it
    // would be 41.
    expect(fetcher).toHaveBeenCalledTimes(4);
    sampler.stop();
  });
});

describe('startClaudeQuotaSampler — lifecycle safety', () => {
  it('unrefs its interval, so a pending tick never holds the process open', () => {
    // REAL timers on purpose: `@sinonjs/fake-timers` implements `unref()` as a
    // no-op, so asserting against a fake handle would pass with the `unref()`
    // call deleted. The interval is long enough that it never fires.
    const spy = vi.spyOn(globalThis, 'setInterval');
    const sampler = startClaudeQuotaSampler(
      { read: async () => ({ value: null, unavailable: 'no_credential' }) },
      { intervalMs: 600_000 },
    );
    const handle = spy.mock.results[0]?.value as ReturnType<typeof setInterval>;
    expect(handle.hasRef()).toBe(false);
    sampler.stop();
  });

  it('absorbs a reader that breaks its never-throws contract, and keeps sampling', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const read = vi.fn(async () => {
      throw new Error('reader broke its contract');
    });
    // `read` is typed as never-rejecting, so a rejecting one is by definition a
    // contract break — but `claudeAccountQuotaReader` is an injectable seam, so
    // this is reachable from outside this package. An unhandled rejection ends
    // the process by default in Node, which would be a strictly worse outcome
    // than the UNREADABLE reading the guard already knows how to handle.
    const sampler = startClaudeQuotaSampler({ read } as unknown as ClaudeAccountQuotaReader, {
      intervalMs: 30_000,
      onError,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(3);
    sampler.stop();
  });

  it('absorbs a throwing onError sink rather than letting it stop the sampler', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => {
      throw new Error('boom');
    });
    const sampler = startClaudeQuotaSampler({ read } as unknown as ClaudeAccountQuotaReader, {
      intervalMs: 30_000,
      onError: () => {
        throw new Error('the sink is broken too');
      },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(3);
    sampler.stop();
  });

  it('refuses a non-positive interval rather than arming a spin loop', () => {
    expect(() =>
      startClaudeQuotaSampler(
        { read: async () => ({ value: null, unavailable: 'no_credential' }) },
        { intervalMs: 0 },
      ),
    ).toThrow(/interval/i);
    expect(() =>
      startClaudeQuotaSampler(
        { read: async () => ({ value: null, unavailable: 'no_credential' }) },
        { intervalMs: Number.NaN },
      ),
    ).toThrow(/interval/i);
  });
});

/**
 * #1292 — a fake of the account-level limiter the live endpoint was MEASURED to
 * have, so the default cadence is tested against the thing it has to live with.
 *
 * A token bucket fitted to studio's own service log (2026-09-25, ~7,500 cycles
 * of the flap): the dominant cycle was 429 at 0s, 200 at 120s, 200 at 180s, 429
 * at 240s. Two polls answered inside 180s of an empty bucket, so it refills at
 * least one token per 90s; a third was refused at 240s, so it refills fewer than
 * three per 240s, i.e. slower than one per 80s. This uses the PESSIMISTIC end
 * (90s). Capacity 3 is the #765 burst measurement: 200, 200, 200, then 429 at
 * 15s spacing.
 *
 * The model is only worth trusting if it reproduces the flap it was fitted to.
 * The first test below checks exactly that before any claim rests on it.
 */
function measuredLimiter(now: () => number, { refillMs = 90_000, capacity = 3 } = {}) {
  let tokens = capacity;
  let last = now();
  let refused = 0;
  const fetcher = vi.fn(async () => {
    const at = now();
    tokens = Math.min(capacity, tokens + (at - last) / refillMs);
    last = at;
    if (tokens < 1) {
      refused += 1;
      return RATE_LIMITED;
    }
    tokens -= 1;
    return LIVE_PAYLOAD;
  });
  return { fetcher, refused: () => refused };
}

describe('startClaudeQuotaSampler — the default cadence against the measured limiter (#1292)', () => {
  const SIX_HOURS_MS = 6 * 60 * 60_000;

  function armed(intervalMs: number | undefined) {
    const { now, tick } = clockPair();
    const limiter = measuredLimiter(now);
    const events: string[] = [];
    const reader = createClaudeAccountQuotaReader({
      tokenReader: async () => 'tok',
      fetcher: limiter.fetcher,
      now,
      log: (e) => events.push(e.event),
    });
    const sampler = startClaudeQuotaSampler(
      reader,
      intervalMs === undefined ? {} : { intervalMs },
    );
    return { reader, sampler, tick, limiter, events };
  }

  it('the model reproduces the production flap at the OLD half-TTL cadence', async () => {
    vi.useFakeTimers();
    const { sampler, tick, limiter, events } = armed(TTL_MS / 2);
    for (let t = 0; t < SIX_HOURS_MS; t += TTL_MS / 2) await tick(TTL_MS / 2);
    sampler.stop();
    // Not a handful: a standing cycle, entered and left over and over, which is
    // what the service log showed for hours.
    expect(limiter.refused()).toBeGreaterThan(50);
    expect(events.filter((e) => e === 'rate_limited').length).toBeGreaterThan(50);
    expect(events.filter((e) => e === 'rate_limit_cleared').length).toBeGreaterThan(50);
  });

  it('never trips the limiter at the DEFAULT cadence: six hours, zero 429s', async () => {
    vi.useFakeTimers();
    const { sampler, tick, limiter, events } = armed(undefined);
    for (let t = 0; t < SIX_HOURS_MS; t += 10_000) await tick(10_000);
    sampler.stop();
    expect(limiter.fetcher).toHaveBeenCalled();
    expect(limiter.refused()).toBe(0);
    expect(events).not.toContain('rate_limited');
  });

  it("answers every one of the guard's reads with a value at the DEFAULT cadence", async () => {
    vi.useFakeTimers();
    const { reader, sampler, tick } = armed(undefined);
    // The guard's shape in the service log: sparse reads, typically ~13 min
    // apart, each gate a short burst. Offset so reads land at every phase of
    // the sampler's cycle rather than only on its ticks.
    //
    // Advanced in 10s steps, never one long `tick`: `tick` moves the reader's
    // clock the whole distance BEFORE the timers inside it fire, so every
    // sampler tick in a long step would read one instant, hit its own cache,
    // and never reach the limiter — a test that passes at any cadence.
    const STEP_MS = 10_000;
    const unreadable: number[] = [];
    let elapsed = 0;
    const idle = async (ms: number) => {
      for (let t = 0; t < ms; t += STEP_MS) await tick(STEP_MS);
      elapsed += ms;
    };
    for (let gate = 0; gate < 30; gate += 1) {
      await idle(13 * 60_000 + 10_000 * (gate % 7));
      for (let burst = 0; burst < 3; burst += 1) {
        const reading = await reader.read();
        if (reading.value === null) unreadable.push(elapsed);
        await idle(20_000);
      }
    }
    sampler.stop();
    expect(unreadable).toEqual([]);
  });
});
