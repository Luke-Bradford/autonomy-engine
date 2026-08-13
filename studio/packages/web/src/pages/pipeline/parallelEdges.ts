import type { Edge } from '@autonomy-studio/shared';

/**
 * How far apart two edges joining the SAME pair of activities are bowed, in flow
 * units at the curve's midpoint.
 *
 * Small enough that a fan of three still reads as one relationship, large enough
 * that each line is separately clickable — `selectEdge` picks an edge by its
 * midpoint, and two midpoints closer than a pointer's accuracy are one target.
 */
export const PARALLEL_EDGE_SPREAD = 26;

/**
 * The bow to apply to each edge, keyed by edge id — #992/#997's other half.
 *
 * Two edges between the same pair of activities used to be distinguishable
 * because they LEFT from different points: `failure` sat one port below
 * `success` on the source's column, so the two curves diverged at the source and
 * the eye could follow either. Collapsing the ports to one point at rest (#997)
 * removed exactly that difference, and identical endpoints produce identical
 * béziers — so `A -failure-> B` and `A -skipped-> B` now paint on top of each
 * other and the canvas shows ONE line where the document has two.
 *
 * That is an information defect rather than a cosmetic one: nothing on screen
 * says the second edge exists, and clicking the pair selects whichever React
 * Flow rendered last.
 *
 * So each edge in a group gets an offset, symmetric about zero and stable in
 * DOCUMENT ORDER — `[0]` for a lone edge, `[-d, +d]` for two, `[-d, 0, +d]` for
 * three. Document order rather than, say, outcome order, because the set of
 * outcomes between two nodes is open (a `switch` contributes arbitrary branch
 * labels) and a rule keyed on the outcome would have to invent a ranking for
 * strings it has never seen.
 *
 * DIRECTION IS PART OF THE KEY. `A→B` and `B→A` are drawn as separate curves
 * already (they leave from opposite sides), so grouping them together would
 * spread two lines that never overlapped and leave a genuine pair unspread.
 */
export function parallelEdgeOffsets(edges: readonly Edge[]): ReadonlyMap<string, number> {
  const groups = new Map<string, Edge[]>();
  for (const e of edges) {
    const key = `${e.from} ${e.to}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [e]);
    else group.push(e);
  }

  const offsets = new Map<string, number>();
  for (const group of groups.values()) {
    /* A lone edge is left EXACTLY where it was. The overwhelmingly common case
       must not move a pixel because of a rule written for the rare one — and a
       formula that returned ±0.5 spread for a single edge would shift every
       curve on every existing canvas. */
    if (group.length === 1) {
      offsets.set(group[0]!.id, 0);
      continue;
    }
    const middle = (group.length - 1) / 2;
    group.forEach((e, index) => {
      offsets.set(e.id, (index - middle) * PARALLEL_EDGE_SPREAD);
    });
  }
  return offsets;
}
