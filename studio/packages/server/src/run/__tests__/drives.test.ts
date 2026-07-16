import { describe, expect, it } from 'vitest';
import { createRunDrives } from '../drives.js';

/**
 * The per-run drive registry — the primitive `executor.ts`'s "within a single run
 * the driver's `pump` is sequential" invariant now rests on. Every property here
 * is one the retry path depends on; none is p-limit trivia.
 */
describe('createRunDrives', () => {
  it('serializes drives for the SAME run — the second never overlaps the first', async () => {
    const drives = createRunDrives();
    const order: string[] = [];

    const a = drives.serialize('run-1', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 15));
      order.push('a-end');
      return 'A';
    });
    const b = drives.serialize('run-1', async () => {
      order.push('b-start');
      await new Promise((r) => setTimeout(r, 1));
      order.push('b-end');
      return 'B';
    });

    expect(await Promise.all([a, b])).toEqual(['A', 'B']);
    // The whole point: NOT a-start,b-start,… — b waits for a to finish.
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('runs drives for DIFFERENT runs concurrently — the lock is per run, not global', async () => {
    const drives = createRunDrives();
    const order: string[] = [];

    const a = drives.serialize('run-1', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 15));
      order.push('a-end');
    });
    const b = drives.serialize('run-2', async () => {
      order.push('b-start');
      await new Promise((r) => setTimeout(r, 1));
      order.push('b-end');
    });

    await Promise.all([a, b]);
    // run-2 overtakes run-1: a global lock would serialize these too, and every
    // run in the system would then queue behind one slow LLM call.
    expect(order).toEqual(['a-start', 'b-start', 'b-end', 'a-end']);
  });

  it('isolates a rejection to its own caller and does NOT poison the chain', async () => {
    const drives = createRunDrives();
    const order: string[] = [];

    const boom = drives.serialize('run-1', async () => {
      order.push('boom');
      throw new Error('drive failed');
    });
    const after = drives.serialize('run-1', async () => {
      order.push('after');
      return 'ok';
    });

    await expect(boom).rejects.toThrow('drive failed');
    // A poisoned chain is the fail-open here: one thrown drive would silently
    // wedge every later retry for that run — a hang, exactly what B1 was.
    expect(await after).toBe('ok');
    expect(order).toEqual(['boom', 'after']);
  });

  it('registers the drive SYNCHRONOUSLY, so whenIdle() cannot resolve early', async () => {
    const drives = createRunDrives();
    let ran = false;

    // LOAD-BEARING, and the reason this is pinned: the alarm clock does NOT await
    // `afterCommit` (`alarms.ts` — "deliberately NOT awaited"), so `whenIdle()` is
    // the only handle a test has after `tick()` returns. If `serialize` registered
    // its drive one microtask late, `whenIdle()` would resolve BEFORE the drive
    // started and the B1 regression test would pass vacuously.
    const p = drives.serialize('run-1', async () => {
      await new Promise((r) => setTimeout(r, 5));
      ran = true;
    });
    expect(drives.idle()).toBe(false);

    await drives.whenIdle();
    expect(ran).toBe(true);
    await p;
  });

  it('whenIdle() awaits a drive SPAWNED by another drive', async () => {
    const drives = createRunDrives();
    const order: string[] = [];

    await drives.serialize('run-1', async () => {
      order.push('outer');
      // A drive that arms + fires a follow-on drive for a DIFFERENT run (a child
      // pipeline, a fan-out) must still be awaited by whenIdle().
      void drives.serialize('run-2', async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push('inner');
      });
    });

    await drives.whenIdle();
    expect(order).toEqual(['outer', 'inner']);
  });

  it('does not leak a per-run entry once its chain drains', async () => {
    const drives = createRunDrives();
    await drives.serialize('run-1', async () => undefined);
    await drives.serialize('run-2', async () => undefined);
    await drives.whenIdle();
    // A long-lived server drives millions of runs; a Map that only ever grows is
    // a leak, and `idle()`/`whenIdle()` would degrade with it.
    expect(drives.size()).toBe(0);
  });

  it('KEEPS the entry while a second drive is queued behind the first', async () => {
    // The contended case, and the one the cleanup's re-check exists for: the
    // first drive settling must NOT drop a limiter that a queued drive is still
    // waiting on. Dropping it would hand the queued caller — and everyone after
    // it — a BRAND NEW lock, i.e. two concurrent drives for one run holding
    // different mutexes. That is the exact bug this module prevents, reintroduced
    // by its own garbage collection.
    const drives = createRunDrives();
    const order: string[] = [];

    const first = drives.serialize('run-1', async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('first');
    });
    const second = drives.serialize('run-1', async () => {
      order.push('second');
    });
    expect(drives.size()).toBe(1);

    await first;
    // `first` has settled but `second` has not — the entry must survive, and it
    // must be the SAME limiter, or the two drives were never serialized at all.
    expect(drives.size()).toBe(1);

    await second;
    await drives.whenIdle();
    expect(drives.size()).toBe(0);
    expect(order).toEqual(['first', 'second']);
  });
});
