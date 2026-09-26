import {
  StrictNodeSchema,
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

/**
 * #1312 — the write SCHEMA's refusals of a node's `policy`, as save badges.
 *
 * Kept OUT of `validateCanvas` for the reason `nameIssues` is: that function is
 * exactly `validatePipelineDoc`, the server's doc gate, and these rules belong to
 * a different gate — `StrictNodeSchema` on the write body (an interval with no
 * retry, the timeout typo ceiling, unknown keys). Without them a policy the
 * editor let through would reach the save's client-side parse and surface as a
 * raw ZodError instead of a badge that names the node.
 *
 * Read through `StrictNodeSchema.shape.policy`, so the rules are the schema's
 * own and nothing here restates a bound.
 */
export function policyIssues(nodes: Node[]): string[] {
  const schema = StrictNodeSchema.shape.policy;
  return nodes.flatMap((n) => {
    if (n.policy === undefined) return [];
    const check = schema.safeParse(n.policy);
    if (check.success) return [];
    // An unknown key has an empty path; `policy.: …` would be noise.
    return check.error.issues.map((issue) =>
      issue.path.length === 0
        ? `node '${n.id}': policy: ${issue.message}`
        : `node '${n.id}': policy.${issue.path.join('.')}: ${issue.message}`,
    );
  });
}

/**
 * #1312 — the issues the node panel's policy section explains: this node's own
 * policy refusals, and every downstream ref refused because this node's outputs
 * are secure — or those of a container it sits in, which a secure child makes
 * secure (`secureOutputIdsOf`).
 *
 * COUPLING: this reads the validators' MESSAGE FORMAT on the UNREWRITTEN strings
 * (`readableIssue` swaps the quoted ids for names, after which nothing here can
 * match). `canvasDoc.test.ts` runs the real validator against these prefixes, so
 * a reworded `validateSecurePolicy` or ref refusal fails there, not silently here.
 */
export function nodePolicyIssues(
  issues: string[],
  nodeId: string,
  containerIds: string[],
): string[] {
  const secureOwners = [nodeId, ...containerIds];
  return issues.filter(
    (issue) =>
      isOwnPolicyIssue(issue, nodeId) ||
      secureOwners.some((id) => issue.includes(`node '${id}' has secure outputs`)),
  );
}

/**
 * Is this RAW issue a refusal of `nodeId`'s own `policy`? `PolicyEditor` lists
 * these beside the fields that cause them, so the node panel's issue list
 * (#863) leaves them out rather than showing the same line twice.
 */
export function isOwnPolicyIssue(issue: string, nodeId: string): boolean {
  return issue.startsWith(`node '${nodeId}': policy`);
}

/**
 * The containers `nodeId` sits in. A secure child makes its container secure
 * (`secureOutputIdsOf`), so a ref refused against the container is this node's
 * policy at work. One level only, because containers do not nest: a container's
 * `children` are node ids, and `validateDoc` refuses any that is not a node.
 */
export function enclosingContainers(nodeId: string, containers: Container[]): string[] {
  return containers.filter((c) => c.children.includes(nodeId)).map((c) => c.id);
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
  // list already names each one, and its own copy is
  // "N validation issue(s) — fix these to save." "Below" is accurate for both
  // buttons that read this — the list renders after the toolbar AND after the
  // conflict banner, though it sits ABOVE the graph canvas itself.
  if (issues.length > 0)
    return `Fix the ${String(issues.length)} validation issue(s) listed below to save.`;
  return null;
}

/**
 * Whether a doc is savable, ignoring anything the SCREEN is doing. Gated on
 * `issues` as of #444: the server REFUSES an invalid doc, so an enabled Save
 * would just round-trip to a 400. The server remains the real gate — this only
 * spares the author a pointless request.
 *
 * DERIVED from `saveDisabledReason` as of #1141 rather than restating its terms,
 * so a rule added there can never be missing here. Passes `previewing: null`
 * because a preview is a property of the screen rather than of the document.
 *
 * That leaves it with NO render-site caller — both buttons need the reason, not
 * the boolean, so both read `saveDisabledReason` directly. It survives as the
 * document-level form, which is what the store tests assert through on purpose:
 * their subject is "the operator gets Save back" (#746), and the boolean is that
 * claim, where an empty `issues` array is only its mechanism. Folding it into
 * those call sites would trade four legible assertions for the same expression
 * written out four times — the exact shape this ticket removed from the JSX.
 */
export function canSave(args: { saving: boolean; ready: boolean; issues: string[] }): boolean {
  return saveDisabledReason({ ...args, previewing: null }) === null;
}
