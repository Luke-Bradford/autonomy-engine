import type { ActivityRun } from '@autonomy-studio/shared';

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
export function iterationText(it: ActivityRun['iteration']): string {
  if (it === null) return '';
  const n = it.count === null ? `${it.index + 1}` : `${it.index + 1} of ${it.count}`;
  return it.item === null ? n : `${n} · ${it.item}`;
}
