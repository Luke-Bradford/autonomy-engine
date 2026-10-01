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

/**
 * #1436 — a kind as the forms name it, in the plural: "SQLite connections",
 * "Database table datasets". Plural so no article ever precedes a name, which
 * read "a Excel workbook dataset" for every vowel-initial kind. `kind` stays the
 * stored identifier everywhere else; an unknown one is shown as itself.
 */
export function kindPlural(kind: string, noun: 'connection' | 'dataset'): string {
  const labels: Readonly<Record<string, string>> =
    noun === 'connection' ? CONNECTION_KIND_LABELS : DATASET_KIND_LABELS;
  return `${labels[kind] ?? kind} ${noun}s`;
}
