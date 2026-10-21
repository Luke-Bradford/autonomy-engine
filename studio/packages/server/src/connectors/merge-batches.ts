/**
 * #1600 OR41 C6f-3 — a partitioned read's fan-in: one pending pull per source,
 * batches yielded as they arrive, so the pump reads N partitions as one stream.
 *
 * Ending is the part that matters, because each source holds a database
 * session. On the first failure, or when the consumer stops early, `stop` is
 * called (it aborts every source at its next batch boundary), then each pull
 * still in flight is awaited and every source not yet ended is returned, so every
 * source's `finally` has run before this generator ends. A sibling's own error
 * after the stop (its cancel) never replaces the first failure.
 */
export async function* mergeBatches<T>(
  sources: readonly AsyncIterable<T>[],
  stop: () => void,
): AsyncGenerator<T> {
  type Pulled = { readonly i: number } & (
    | { readonly ok: true; readonly result: IteratorResult<T> }
    | { readonly ok: false; readonly err: unknown }
  );
  const iterators = sources.map((s) => s[Symbol.asyncIterator]());
  const pull = (i: number): Promise<Pulled> =>
    iterators[i]!.next().then(
      (result) => ({ i, ok: true as const, result }),
      (err: unknown) => ({ i, ok: false as const, err }),
    );
  const pending = new Map<number, Promise<Pulled>>(iterators.map((_, i) => [i, pull(i)]));
  // A source that ended or threw has run its own `finally`; every other one
  // (pulling, or paused at the batch just yielded) still has to be returned.
  const finished = new Set<number>();
  try {
    while (pending.size > 0) {
      const pulled = await Promise.race(pending.values());
      pending.delete(pulled.i);
      if (!pulled.ok) {
        finished.add(pulled.i);
        throw pulled.err;
      }
      if (pulled.result.done === true) {
        finished.add(pulled.i);
        continue;
      }
      yield pulled.result.value;
      pending.set(pulled.i, pull(pulled.i));
    }
  } finally {
    if (finished.size < iterators.length) {
      stop();
      for (const p of await Promise.all(pending.values())) {
        if (!p.ok || p.result.done === true) finished.add(p.i);
      }
      await Promise.allSettled(
        iterators.filter((_, i) => !finished.has(i)).map((it) => it.return?.()),
      );
    }
  }
}
