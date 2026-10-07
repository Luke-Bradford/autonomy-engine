/**
 * #1569 OR37 slice 7 — the pipelines grid's Trigger now drawer, as typed
 * (`PipelineRunDrawer`); kept apart from the component for fast refresh.
 */

/** The open Trigger now form. */
export interface PipelineRunForm {
  kind: 'run';
  pipelineId: string;
  name: string;
  /** The typed param values, by name. */
  rows: Record<string, string>;
  /** What `rows` was seeded with (the params' defaults), so only an edit counts
   * as typed input for the page's unsaved-changes guard. */
  defaults: Record<string, string>;
}

/** The form's unsaved-changes signature: constant until a value is edited. */
export function pipelineRunSignature(form: PipelineRunForm): string {
  const rows = JSON.stringify(form.rows);
  return rows === JSON.stringify(form.defaults) ? 'run' : rows;
}
