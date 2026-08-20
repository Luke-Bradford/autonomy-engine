import {
  validatePipelineDoc,
  type Container,
  type Edge,
  type Node,
  type Output,
  type Param,
} from '@autonomy-studio/shared';
import type { PipelineVersionWrite } from '../../api/pipelines';

/**
 * Build the `POST .../versions` body for a canvas save — entirely from WORKING
 * state. `catalogVersion` is deliberately omitted: the server defaults it to the
 * current catalog, re-stamping the doc on save.
 *
 * Every field here was once read off `loaded` (the version the canvas was opened
 * on) because no UI could edit it, and each in turn became a PARAMETER as its
 * editor landed — `containers` in #746, `params`/`outputs` in U16. That
 * migration is the whole point of this function's shape, and the failure it
 * fixes is the same each time: a carry-forward that outlives its "no UI yet"
 * premise silently DISCARDS the operator's edits. In #746 the canvas could
 * delete an enclosed activity and the save body still listed it as a container
 * child, because membership came from the opened version rather than the graph
 * on screen. A param edited on screen would have been dropped identically.
 *
 * With `params`/`outputs` moved, NOTHING is carried forward any more, so the
 * `loaded` parameter is gone: every field of the body now comes from the store.
 * `loaded` keeps its other jobs in the store (the rebase basis for Save, and the
 * un-lowered record of what the server stored) — it is just no longer a source
 * of doc content.
 */
export function toVersionBody(
  nodes: Node[],
  edges: Edge[],
  containers: Container[],
  params: Param[],
  outputs: Output[],
  // #904 — the version this write is based on (`canvasStore.loaded`), or `null`
  // for "this pipeline has no versions yet". A REQUIRED parameter, deliberately
  // not an optional one defaulting to `null`: a caller that forgets it must
  // fail to compile rather than silently send the one value that is a real
  // assertion about the server's state. The server refuses a write whose basis
  // is not the current head (`StaleWriteError`), which is what stops a second
  // author's save from orphaning the first's off the head.
  basedOnVersionId: string | null,
): PipelineVersionWrite {
  return {
    params,
    outputs,
    containers,
    nodes,
    edges,
    basedOnVersionId,
  };
}

/**
 * The save-time validation badges. Delegates to `validatePipelineDoc`, the
 * shared SSOT — which is the SAME function the server's write gate calls
 * (#444), so a badge the canvas shows is exactly what a save would be refused
 * for, by construction rather than by two call sites staying in step.
 */
export function validateCanvas(
  nodes: Node[],
  edges: Edge[],
  containers: Container[],
  params: Param[],
): string[] {
  return validatePipelineDoc({ params, nodes, edges, containers });
}

/** What can stand between the canvas and a save. */
export interface SaveControlContext {
  /** A save already in flight. */
  saving: boolean;
  /** Has the canvas finished loading the pipeline it is showing? */
  ready: boolean;
  /** The validation badges — `[]` is a doc the write gate would accept. */
  issues: string[];
  /** The version being previewed, or `null` when the working graph is on screen. */
  previewing: number | null;
}

/**
 * Why a save is refused, or `null` when it can go ahead.
 *
 * The SINGLE authority on that question as of #1141, which is the point of it.
 * Two buttons save the working graph — the toolbar's Save and the conflict
 * banner's override — and each used to write the refusal terms out by hand.
 * They agreed only by the author having typed the same list twice, and one of
 * them had not: the override omitted `issues`, so the one path that escaped the
 * badge gate was also the one whose failure was unreadable. An invalid doc
 * reached `PipelineVersionWriteSchema.parse` in `api/pipelines.ts`, which throws
 * synchronously, and the canvas printed `Save failed: <raw ZodError>` where a
 * legible diagnostic belongs. Deriving both the `disabled` and the `title` from
 * this one function is what makes that class of drift unrepresentable.
 *
 * The order mirrors `undoDisabledReason` and `arrangeDisabledReason` — busy,
 * then previewing, then not-ready, then the control's own availability — so the
 * three neighbouring controls answer in one grammar rather than three.
 *
 * NOT refused for an ARCHIVED pipeline, matching `arrangeDisabledReason`'s note:
 * archiving is enforced by the server (409) and announced by the page's own
 * banner, and this predicate has never taken an `archived` argument.
 *
 * Deliberately pure, so it is testable without mounting ReactFlow in jsdom.
 */
export function saveDisabledReason({
  saving,
  ready,
  issues,
  previewing,
}: SaveControlContext): string | null {
  if (saving) return 'Wait for the save in flight to finish.';
  // Save writes the WORKING graph, which is not what is on screen while a
  // version is previewed — it would mint a version of something the operator
  // cannot see.
  if (previewing !== null) return 'Leave the preview to save your working graph.';
  if (!ready) return 'Wait for the pipeline to load.';
  // Says how many and where they are, rather than restating them: the badge
  // list below the canvas already names each one, and its own copy is
  // "N validation issue(s) — fix these to save."
  if (issues.length > 0)
    return `Fix the ${String(issues.length)} validation issue(s) listed below to save.`;
  return null;
}

/**
 * Whether the Save button is enabled. Gated on `issues` as of #444: the server
 * now REFUSES an invalid doc, so an enabled Save would just round-trip to a
 * 400. The server remains the real gate — this only spares the author a
 * pointless request.
 *
 * DERIVED from `saveDisabledReason` as of #1141 rather than restating its terms,
 * so a rule added there can never be missing here. Asks the question with no
 * preview open, because the preview is a property of the SCREEN rather than of
 * the document, and the store-level callers that use this predicate have no
 * preview to report.
 */
export function canSave(args: { saving: boolean; ready: boolean; issues: string[] }): boolean {
  return saveDisabledReason({ ...args, previewing: null }) === null;
}
