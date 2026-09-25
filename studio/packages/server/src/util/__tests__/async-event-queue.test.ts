import { describe, expect, it } from 'vitest';
import { AsyncEventQueue } from '../async-event-queue.js';

async function drain<T>(queue: AsyncEventQueue<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of queue) out.push(item);
  return out;
}

describe('AsyncEventQueue', () => {
  it('drains items pushed BEFORE close, in order, then ends', async () => {
    const queue = new AsyncEventQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.close();
    expect(await drain(queue)).toEqual([1, 2]);
  });

  it('hands a push straight to a consumer already waiting', async () => {
    const queue = new AsyncEventQueue<string>();
    const it = queue[Symbol.asyncIterator]();
    const pending = it.next();
    queue.push('a');
    expect(await pending).toEqual({ value: 'a', done: false });
  });

  it('ends a consumer that is waiting when the queue closes', async () => {
    const queue = new AsyncEventQueue<string>();
    const pending = queue[Symbol.asyncIterator]().next();
    queue.close();
    expect((await pending).done).toBe(true);
  });

  it('drops a push after close, and a second close is a no-op', async () => {
    const queue = new AsyncEventQueue<number>();
    queue.push(1);
    queue.close();
    queue.push(2);
    queue.close();
    expect(await drain(queue)).toEqual([1]);
  });
});
