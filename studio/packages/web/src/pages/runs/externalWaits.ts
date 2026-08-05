import { outputContract, resolveDocNode } from '@autonomy-studio/shared';
import type {
  Node,
  PendingExternalWait,
  PipelineVersion,
  WaitingReason,
} from '@autonomy-studio/shared';

/**
 * #900 — the pure half of the run monitor's "waiting on a callback" surface.
 *
 * Everything here is a function of the run's parked state and the bound doc, so
 * the page holds no derivation of its own: which parks owe a callback, which doc
 * node is parked, and what an operator has to SEND to that callback.
 *
 * The last one is the reason this file exists rather than a few inline ternaries.
 * A16's inbound contract is unforgiving in a way that is invisible from the URL:
 * a webhook declaring outputs requires EVERY non-optional one (a missing key is a
 * 422 and the node stays parked), while a webhook declaring none accepts any body
 * and stores NOTHING from it (`checkInboundOutputs` — undeclared keys are dropped
 * on purpose, so an external body can never reach the raw-served event log). An
 * operator handed only a URL would discover both by trial and error.
 *
 * #901 made that description load-bearing rather than advisory: the operator can
 * now complete the wait from the app, so this text is what they compose a body
 * against — and getting it wrong is a 422 they read beside the editor, not a
 * `curl` they retry blind. The derivation is unchanged; only its audience is.
 */

/**
 * Whether this run's park is one a CALLBACK resumes.
 *
 * The gate for the whole surface, and deliberately the waiting REASON rather than
 * the bare status: a `wait`-timer park is equally `waiting` and owes no callback,
 * so gating on the status alone would fire a request on every timer park and then
 * render an empty section under a heading claiming a callback is owed. The reducer
 * gives `waiting_external` precedence when a run is parked on both, so the reason
 * loses no case (`engine/reduce.ts`).
 */
export function owesCallback(reason: WaitingReason | null): boolean {
  return reason === 'waiting_external';
}

/**
 * The DOC node behind a parked wait's `nodeId`, or null when it cannot be named.
 *
 * The parked id is whatever the engine parked, which inside a parallel `foreach`
 * body is an instance key (`w@1`) and not a doc id at all. `resolveDocNode` is the
 * one resolution policy for that — exact id first (so a legacy doc's literal `x@2`
 * node resolves to itself), then the instance-suffix strip — and using it here is
 * what stops this surface inventing a second, subtly different lookup.
 *
 * Null when the bound version will not resolve (the page survives that by design,
 * U11) or when the doc genuinely has no such node. Callers say less, rather than
 * guessing.
 */
export function parkedDocNode(doc: PipelineVersion | null, nodeId: string): Node | null {
  if (doc === null) return null;
  return resolveDocNode(doc.nodes, nodeId) ?? null;
}

/**
 * One sentence saying what the callback body must contain, or null when the doc is
 * unavailable and nothing honest can be said.
 *
 * Reads the SAME `outputContract` the inbound boundary validates against, so this
 * cannot drift into describing a contract the server does not enforce.
 */
export function describeCallbackBody(node: Node | null): string | null {
  if (node === null) return null;

  const contract = outputContract(node);
  if (contract.kind === 'invalid') {
    /* Stronger than "cannot be described", because the consequence is worse than
       not knowing. `checkInboundOutputs` classifies a corrupt contract as a
       `contract` failure — not caller-correctable — so the route answers 422 to
       EVERY body, the node stays parked, and the wait runs out its expiry. The
       callback URL below is revealed anyway (it is what an operator would quote in
       a bug report), but telling them to go and try it would be sending them at a
       door that cannot open. Only reachable on a pre-F13a row. */
    return 'This webhook’s declared output contract cannot be read, so NO callback body will be accepted — every attempt is refused and the wait will expire. Re-author the node’s declared outputs to repair it.';
  }
  if (contract.kind === 'absent' || contract.outputs.length === 0) {
    /* `declared: []` is the LOWERED default for a webhook that declares nothing,
       so it and `absent` are one case to an operator. Worth saying explicitly that
       a body is DISCARDED: the callback succeeds either way, so someone who sends
       a payload and sees a 204 would otherwise reasonably assume it landed. */
    return 'This webhook declares no outputs, so the callback needs no body — anything sent is accepted and discarded.';
  }

  const required = contract.outputs.filter((o) => o.optional !== true);
  const optional = contract.outputs.filter((o) => o.optional === true);

  if (required.length === 0) {
    return `The callback body is JSON. Every declared output is optional, so an empty body is accepted; recognised keys: ${nameList(optional)}.`;
  }

  const head = `The callback body must be JSON supplying ${nameList(required)}.`;
  return optional.length === 0
    ? head
    : `${head} Optional: ${nameList(optional)}. Undeclared keys are dropped.`;
}

/** `` `a` (string), `b` (number) `` — the declared outputs, named with their types. */
function nameList(outputs: ReadonlyArray<{ name: string; type: string }>): string {
  return outputs.map((o) => `“${o.name}” (${o.type})`).join(', ');
}

/**
 * A stable per-wait key. `nodeId` alone is not unique across a run's lifetime — a
 * retried webhook parks again under a NEW attempt — and `attemptId` alone is not
 * unique across nodes, so the key is the pair the correlation row itself is keyed
 * on (`(runId, nodeId, attemptId)`, minus the run this list already belongs to).
 *
 * JSON rather than a joined string, so the docblock above is actually true. Node
 * ids are author-supplied and an imported doc can carry a separator character in
 * one, which would let two distinct pairs collapse to one key — a React list key
 * collision, and two waits rendering as one. Encoding removes the question instead
 * of picking a character nobody will type.
 */
export function waitKey(wait: Pick<PendingExternalWait, 'nodeId' | 'attemptId'>): string {
  return JSON.stringify([wait.nodeId, wait.attemptId]);
}
