import type { PipelineVersionsLoad } from './pipeline/usePipelineVersions';

/**
 * #1569 OR37 slice 8 — the pipelines grid's Duplicate / Clone from version
 * drawer, as typed (`DuplicatePipelineDrawer`); kept apart from the component
 * for fast refresh.
 */

/** The open Duplicate form. */
export interface DuplicatePipelineForm {
  kind: 'duplicate';
  /** The row it was opened from. The drawer is handed that row as the list
   * holds it NOW, so a rename or a move made meanwhile is what the copy carries. */
  pipelineId: string;
  /** `null` until typed in: the shown name is then `copyName` of the chosen
   * version, so picking another version renames an untouched copy. */
  name: string | null;
  /** `'latest'`, read when the copy is made, or one version by its number. */
  from: 'latest' | number;
  /** Opened as "Clone from version…": named so, and the version takes focus. */
  pickVersion: boolean;
}

/** The form's unsaved-changes signature: only a typed name counts. A version
 * picked and not used is one click to pick again. */
export function duplicatePipelineSignature(form: DuplicatePipelineForm): string {
  return form.name ?? '';
}

export const versionOf = (from: DuplicatePipelineForm['from']): number | undefined =>
  from === 'latest' ? undefined : from;

/**
 * The picker's options: Latest, then every older version, newest first. The
 * head is offered once, as Latest. Until the list answers, only what is
 * already chosen can be shown.
 */
export function versionOptions(
  load: PipelineVersionsLoad,
  from: DuplicatePipelineForm['from'],
): { value: string; label: string }[] {
  if (load.status !== 'ready') {
    return [
      { value: 'latest', label: 'Latest' },
      ...(from === 'latest' ? [] : [{ value: String(from), label: `v${String(from)}` }]),
    ];
  }
  const [head, ...older] = load.versions;
  if (head === undefined) return [{ value: 'latest', label: 'None saved' }];
  return [
    { value: 'latest', label: `Latest (v${String(head.version)})` },
    ...older.map((v) => ({ value: String(v.version), label: `v${String(v.version)}` })),
  ];
}
