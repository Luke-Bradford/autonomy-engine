/** A message about the last thing that happened (a save, a paste). */
export interface TransientNotice {
  key: string;
  text: string | null;
  /** `status` for a message a keyboard act raised that changes nothing visible. */
  role?: 'status';
}

/**
 * The transient keys newest first. A key moves to the front when its text
 * CHANGES to a non-null value; a key whose text clears keeps its place, and the
 * caller drops it from view by its null text. Keys never seen before are
 * appended in the caller's order, so the first render has a defined order.
 */
export function newestFirst(
  prevOrder: readonly string[],
  prevTexts: Readonly<Record<string, string | null>>,
  next: readonly TransientNotice[],
): string[] {
  const changed = next
    .filter((n) => n.text !== null && n.text !== prevTexts[n.key])
    .map((n) => n.key);
  const rest = [...prevOrder, ...next.map((n) => n.key)].filter(
    (k, i, all) => !changed.includes(k) && all.indexOf(k) === i,
  );
  return [...changed, ...rest];
}
