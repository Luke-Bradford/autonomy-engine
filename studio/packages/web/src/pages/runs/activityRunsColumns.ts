import type { ActivityRun, ContainerKind } from '@autonomy-studio/shared';

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

/** `2 of 5 · orders.csv`, 1-based; a loop has no count. */
/** An iteration named by its container's kind: `Item 2 of 2 · orders_b.csv`,
 * or `Round 3`. */
export function iterationLabel(
  kind: ContainerKind | undefined,
  it: NonNullable<ActivityRun['iteration']>,
): string {
  return `${kind === 'loop' ? 'Round' : 'Item'} ${iterationText(it)}`;
}

export function iterationText(it: ActivityRun['iteration']): string {
  if (it === null) return '';
  const n = it.count === null ? `${it.index + 1}` : `${it.index + 1} of ${it.count}`;
  return it.item === null ? n : `${n} · ${it.item}`;
}
