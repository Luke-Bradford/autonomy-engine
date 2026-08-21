import { describe, expect, it } from 'vitest';
import { until } from './poll-until.js';

/**
 * #1207 — the shared poll helper's own contract.
 *
 * Worth pinning rather than left to its three callers, because the extraction
 * did NOT merely merge three copies: throw-tolerance became opt-in (it was
 * unconditional in one copy and absent in the other two, so a default either way
 * would silently change a caller), and the timeout now carries the last error.
 * Both are behaviour no call site asserts.
 */

describe('until', () => {
  it('returns as soon as the predicate holds', async () => {
    let polls = 0;
    await until(
      () => {
        polls += 1;
        return polls === 3;
      },
      'the third poll',
      { tickMs: 1 },
    );
    expect(polls).toBe(3);
  });

  it('is bounded by ITERATIONS and names what it was waiting for', async () => {
    let polls = 0;
    await expect(
      until(
        () => {
          polls += 1;
          return false;
        },
        'a thing that never happens',
        { iterations: 4, tickMs: 1 },
      ),
    ).rejects.toThrow('timed out waiting for: a thing that never happens');
    expect(polls).toBe(4);
  });

  it('lets a throwing predicate FAIL FAST by default', async () => {
    // The regression the opt-in exists to prevent: in two of the three original
    // copies a broken predicate surfaced immediately with its own stack, and
    // making tolerance the default would have buried that under a timeout 200
    // polls later.
    let polls = 0;
    await expect(
      until(
        () => {
          polls += 1;
          throw new Error('predicate is broken');
        },
        'never reached',
        { iterations: 50, tickMs: 1 },
      ),
    ).rejects.toThrow('predicate is broken');
    expect(polls).toBe(1);
  });

  it('keeps polling a throwing predicate when asked, and can still succeed', async () => {
    let polls = 0;
    await until(
      () => {
        polls += 1;
        if (polls < 3) throw new Error('cannot tell yet');
        return true;
      },
      'the predicate to become answerable',
      { tickMs: 1, tolerateThrow: true },
    );
    expect(polls).toBe(3);
  });

  it('carries the last tolerated error out as the timeout CAUSE', async () => {
    // Without this, a permanently-broken predicate and a merely slow one report
    // identically — which is what all three original copies did.
    const err = await until(
      () => {
        throw new Error('column does not exist');
      },
      'a predicate that can never answer',
      { iterations: 3, tickMs: 1, tolerateThrow: true },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('a predicate that can never answer');
    expect((err as Error).cause).toBeInstanceOf(Error);
    expect(((err as Error).cause as Error).message).toBe('column does not exist');
  });
});
