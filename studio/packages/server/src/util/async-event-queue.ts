/**
 * A minimal async push/pull queue that turns callback-delivered items into an
 * `AsyncIterable`. Consumers pull with `for await`; producers `push` as data
 * arrives and `close` once they are done — buffered items still drain first.
 *
 * Lifted out of `workers/process-supervisor.ts` (its line-framed output) when
 * the copy activity's progress ticks (#1299) needed the same thing, rather than
 * hand-rolling a third producer/consumer channel beside the two #1300 records.
 * Those two — `run/driver.ts` `pump()` and `run/executor.ts` `performDispatch` —
 * are NOT folded onto this, deliberately: each is a single-consumer loop that
 * interleaves other work between items (the driver's command queue and push
 * backpressure, the executor's hold-back of the terminal event), which the
 * iterator protocol cannot express.
 */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly waiting: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.buffered.push(item);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      waiter?.({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffered.length > 0) {
          // Non-null assertion is safe: length check above guarantees an
          // element is present.
          const value = this.buffered.shift()!;
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise((resolve) => {
          this.waiting.push(resolve);
        });
      },
    };
  }
}
