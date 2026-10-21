/**
 * #1782 — a shared-cursor worker pool: `width` workers take the next item in
 * turn. The first failure stops every worker taking another; the items already
 * under way finish, then the failure is returned with the item it came from.
 * Delete (Max concurrent deletes) and Copy · Files as-is (Degree of copy
 * parallelism) run their work through it. At a width of 1 it is a plain loop.
 *
 * `stop` ends the taking early WITHOUT a failure: Delete passes its abort,
 * which it reports itself. Without one, an abort must throw from `fn`'s own
 * check, as Copy's does, so that it is never a quiet end of work.
 */
export async function runPool<T>(
  items: readonly T[],
  width: number,
  fn: (item: T) => Promise<void>,
  stop: () => boolean = () => false,
): Promise<{ readonly err: unknown; readonly item: T } | undefined> {
  let next = 0;
  let failure: { readonly err: unknown; readonly item: T } | undefined;
  const worker = async () => {
    while (failure === undefined && !stop() && next < items.length) {
      const item = items[next]!;
      next += 1;
      try {
        await fn(item);
      } catch (err) {
        failure ??= { err, item };
      }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return failure;
}
