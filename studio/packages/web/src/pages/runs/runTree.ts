/**
 * #1484 OR35 M1 — "Include child runs": the runs grid draws each run a loaded run
 * called UNDER it, indented, instead of as a row of its own. Pure, so the order is
 * tested here and the grid only renders it.
 */

/** What nesting reads of a run — `RunSummary` satisfies it. */
export interface NestableRun {
  id: string;
  parentRunId: string | null;
  startedAt: number;
}

export interface NestedRunRow<T extends NestableRun> {
  run: T;
  /** 0 for a row drawn at the top level. */
  depth: number;
  /** How many of this run's children are loaded (shown when expanded). */
  shown: number;
  /** False when the operator collapsed this run; its children are then not in the list. */
  expanded: boolean;
}

/**
 * The rows to draw, in order.
 *
 * - A ROOT is a run with no parent, or whose parent is not loaded (a page
 *   boundary, a deleted parent, a filter that matched the child alone). Roots
 *   keep the order the list came in — the server's sort.
 * - A child follows its parent, its siblings in the order they were CALLED
 *   (started, then id), which is the order a reader follows a pipeline in. That
 *   holds whatever the grid is sorted by: a child is placed by its parent.
 * - A collapsed run hides its whole subtree.
 * - Each run is drawn once. A cycle (not creatable through the app) is drawn flat
 *   rather than dropped or followed forever.
 */
export function nestRuns<T extends NestableRun>(
  runs: readonly T[],
  collapsed: ReadonlySet<string>,
): NestedRunRow<T>[] {
  const loaded = new Set(runs.map((run) => run.id));
  const childrenOf = new Map<string, T[]>();
  for (const run of runs) {
    if (run.parentRunId === null || !loaded.has(run.parentRunId)) continue;
    const siblings = childrenOf.get(run.parentRunId);
    if (siblings) siblings.push(run);
    else childrenOf.set(run.parentRunId, [run]);
  }
  for (const siblings of childrenOf.values()) {
    siblings.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  const rows: NestedRunRow<T>[] = [];
  const placed = new Set<string>();
  const place = (run: T, depth: number, visible: boolean): void => {
    if (placed.has(run.id)) return;
    placed.add(run.id);
    const children = childrenOf.get(run.id) ?? [];
    const expanded = !collapsed.has(run.id);
    if (visible) rows.push({ run, depth, shown: children.length, expanded });
    for (const child of children) place(child, depth + 1, visible && expanded);
  };
  for (const run of runs) {
    if (run.parentRunId === null || !loaded.has(run.parentRunId)) place(run, 0, true);
  }
  // Only a cycle leaves a run unplaced: every member has a loaded parent.
  for (const run of runs) place(run, 0, true);
  return rows;
}
