/**
 * #1211 — the THREE-STATE shape both of this page's "what would this edit
 * break?" advisories are built on, and the bounded name list they both render.
 *
 * Extracted from `strandedDatasets.ts` (#1174), which introduced it as
 * `StrandCheck` for the dataset advisory alone. A second consumer arrived — the
 * dependent-TRIGGER advisory — and a trigger module importing a type called
 * `StrandCheck` from a module called `strandedDatasets` would be a name that
 * lies about what it is for. The rule was never dataset-specific; only its first
 * caller was.
 *
 * THE THIRD STATE IS THE POINT. A list that was never read and a list that was
 * read and found empty are DIFFERENT facts, and collapsing them renders
 * "nothing would be affected" on the strength of a fetch that failed —
 * prevention-log #18, the healthy verdict must be EARNED rather than be the
 * fallback, and #473's lesson in miniature (an absent fact manufactured as a
 * benign default). Every consumer is total over these three.
 *
 * Generic over what a COMPLETED read carries, because the two consumers do not
 * carry the same thing: the dataset advisory needs a list of names, and the
 * trigger advisory needs that plus the triggers whose dependency is only
 * knowable at dispatch (`dynamicNames`) — which it must know about precisely so
 * that an empty `names` cannot be rendered as "nothing would be disabled". The
 * `loading` and `unavailable` arms are identical for both and are stated once.
 */
export type DependencyCheck<Known = { names: readonly string[] }> =
  /** The read is in flight. Nothing can be said yet, and nothing is claimed. */
  | { state: 'loading' }
  /** The read failed. `detail` is the failure's own message. */
  | { state: 'unavailable'; detail: string }
  /** The read completed. An empty list is a real, earned "none". */
  | ({ state: 'known' } & Known);

/** How many names a surface spells out before it starts counting. */
export const NAME_LIST_LIMIT = 5;

/**
 * `a, b and 3 more` — bounded, because no surface here has room for an
 * unbounded list. `.contract-advisory` has no `max-width` and a `window.confirm`
 * is a fixed dialog, so a workspace with forty datasets on one store would push
 * the actionable half of the sentence off both.
 */
export function formatNameList(names: readonly string[], limit = NAME_LIST_LIMIT): string {
  const shown = names.slice(0, limit);
  const extra = names.length - shown.length;
  const listed = shown.join(', ');
  return extra > 0 ? `${listed} and ${extra} more` : listed;
}
