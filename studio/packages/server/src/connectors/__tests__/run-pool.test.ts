import { describe, expect, it } from 'vitest';
import { runPool } from '../run-pool.js';

/** #1782 — the shared-cursor pool Delete and Copy · Files as-is both run. */
const tick = () => new Promise<void>((r) => setImmediate(r));

describe('runPool', () => {
  it('runs every item once, at most `width` at a time', async () => {
    let live = 0;
    let peak = 0;
    const seen: number[] = [];
    const failure = await runPool([1, 2, 3, 4, 5], 2, async (n) => {
      live += 1;
      peak = Math.max(peak, live);
      await tick();
      seen.push(n);
      live -= 1;
    });
    expect(failure).toBeUndefined();
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it('at 1 runs the items in order, one after another', async () => {
    const seen: number[] = [];
    await runPool([1, 2, 3], 1, async (n) => {
      await tick();
      seen.push(n);
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('the first failure stops new work, lets the work under way finish, and is returned with its item', async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const boom = new Error('boom');
    const failure = await runPool([1, 2, 3, 4], 2, async (n) => {
      started.push(n);
      if (n === 1) throw boom;
      await tick();
      await tick();
      finished.push(n);
      if (n === 2) throw new Error('later');
    });
    expect(failure).toEqual({ err: boom, item: 1 });
    // 1 failed first, so only 2 (already under way) ran; 3 and 4 never started.
    expect(started).toEqual([1, 2]);
    expect(finished).toEqual([2]);
  });

  it('`stop` ends the taking without a failure', async () => {
    const seen: number[] = [];
    let stopped = false;
    const failure = await runPool(
      [1, 2, 3],
      1,
      async (n) => {
        seen.push(n);
        stopped = true;
      },
      () => stopped,
    );
    expect(failure).toBeUndefined();
    expect(seen).toEqual([1]);
  });

  it('no items is no work', async () => {
    expect(await runPool([], 0, () => Promise.reject(new Error('never')))).toBeUndefined();
  });
});
