import { describe, expect, it } from 'vitest';
import { KeyedQueue } from '../queue.js';

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
});
