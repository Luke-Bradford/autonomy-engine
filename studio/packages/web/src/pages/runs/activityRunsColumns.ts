import type { ActivityRun, ActivityRunGroup, ContainerKind } from '@autonomy-studio/shared';

/** The column headers, in order — the one list the header row and a test read. */
export const ACTIVITY_RUN_COLUMNS = [
  'Activity',
  'Type',
  'Status',
  'Start',
  'End',
  'Duration',
  'Attempt',
  'Iteration',
  'Branch',
  'Rows read',
  'Rows written',
  'Bytes',
  'Child run',
  'Error',
] as const;

/**
 * #1600 OR41 C0d — the user-property columns that follow the fixed ones: each
 * distinct name any row of the run carries, in first-seen order, then any only
 * a container's group line carries (#1673). Read from every row and group, not
 * the filtered view, so a column does not come and go as filters change.
 */
export function userPropertyColumns(
  rows: readonly ActivityRun[],
  groups: readonly ActivityRunGroup[] = [],
): string[] {
  const names = new Set<string>();
  for (const owner of [...rows, ...groups])
    for (const p of owner.userProperties ?? []) names.add(p.name);
  return [...names];
}

/** An iteration named by its container's kind: `Item 2 of 2 · orders_b.csv`,
 * or `Round 3`. */
export function iterationLabel(
  kind: ContainerKind | undefined,
  it: NonNullable<ActivityRun['iteration']>,
): string {
  return `${kind === 'loop' ? 'Round' : 'Item'} ${iterationText(it)}`;
}

/** `2 of 5 · orders.csv`, 1-based; a loop has no count. */
export function iterationText(it: ActivityRun['iteration']): string {
  if (it === null) return '';
  const n = it.count === null ? `${it.index + 1}` : `${it.index + 1} of ${it.count}`;
  return it.item === null ? n : `${n} · ${it.item}`;
}
