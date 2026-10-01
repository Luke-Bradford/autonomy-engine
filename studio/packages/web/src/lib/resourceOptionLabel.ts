import {
  CONNECTION_KIND_LABELS,
  DATASET_KIND_LABELS,
  type ConnectionKind,
  type DatasetKind,
} from '@autonomy-studio/shared';

/**
 * #1396 — how a connection or dataset reads in a picker: its name, then its
 * kind's display name ("Orders (Delimited text (CSV))" rather than the stored
 * `delimited`). One format for every select that offers one.
 */
export function connectionOptionLabel(c: { name: string; kind: ConnectionKind }): string {
  return `${c.name} (${CONNECTION_KIND_LABELS[c.kind]})`;
}

export function datasetOptionLabel(d: { name: string; kind: DatasetKind }): string {
  return `${d.name} (${DATASET_KIND_LABELS[d.kind]})`;
}
