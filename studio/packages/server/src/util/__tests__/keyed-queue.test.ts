import { describe, expect, it } from 'vitest';
import { KeyedQueue } from '../keyed-queue.js';

describe('KeyedQueue', () => {
  it('serializes tasks under the same key in submission order', async () => {
    const queue = new KeyedQueue();
    const order: number[] = [];
    const slow = queue.run('a', async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
    });
    const fast = queue.run('a', async () => {
      order.push(2);
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual([1, 2]);
  });

  it('runs different keys concurrently', async () => {
    const queue = new KeyedQueue();
    let aStarted = false;
    let bObservedAStarted = false;
    const a = queue.run('a', async () => {
      aStarted = true;
      await new Promise((r) => setTimeout(r, 30));
    });
    const b = queue.run('b', async () => {
      // Runs while 'a' is still sleeping — a different key never queues behind it.
      bObservedAStarted = aStarted;
    });
    await Promise.all([a, b]);
    expect(bObservedAStarted).toBe(true);
  });

  it('a rejection propagates to its caller but does not poison the chain', async () => {
    const queue = new KeyedQueue();
    const failing = queue.run('a', async () => {
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');
    await expect(queue.run('a', async () => 'after')).resolves.toBe('after');
  });

  describe('acquire (#1423)', () => {
    it('holds the slot until release, so a second acquire waits for it', async () => {
      const queue = new KeyedQueue();
      const order: string[] = [];
      const releaseA = await queue.acquire('k');
      const b = queue.acquire('k').then((release) => {
        order.push('b acquired');
        release();
      });
      await new Promise((r) => setTimeout(r, 20));
      order.push('a releasing');
      releaseA();
      await b;
      expect(order).toEqual(['a releasing', 'b acquired']);
    });

    it('an abort while WAITING rejects at once, and the next waiter still queues behind the holder', async () => {
      const queue = new KeyedQueue();
      const releaseA = await queue.acquire('k');
      const controller = new AbortController();
      const b = queue.acquire('k', controller.signal);
      let cAcquired = false;
      const c = queue.acquire('k').then((release) => {
        cAcquired = true;
        release();
      });
      controller.abort(new Error('cancelled'));
      await expect(b).rejects.toThrow('cancelled');
      // b's abandoned slot must not let c run alongside the holder.
      await new Promise((r) => setTimeout(r, 20));
      expect(cAcquired).toBe(false);
      releaseA();
      await c;
      expect(cAcquired).toBe(true);
    });

    it('an already-aborted signal rejects without taking the slot', async () => {
      const queue = new KeyedQueue();
      const controller = new AbortController();
      controller.abort(new Error('gone'));
      await expect(queue.acquire('k', controller.signal)).rejects.toThrow('gone');
      const release = await queue.acquire('k');
      release();
    });

    it('an abort AFTER the slot is granted does nothing to the holder', async () => {
      const queue = new KeyedQueue();
      const controller = new AbortController();
      const release = await queue.acquire('k', controller.signal);
      controller.abort(new Error('late'));
      let next = false;
      const after = queue.acquire('k').then((r) => {
        next = true;
        r();
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(next).toBe(false);
      release();
      // Idempotent: a second release must not hand over a later holder's slot.
      release();
      await after;
      expect(next).toBe(true);
    });
  });
});
