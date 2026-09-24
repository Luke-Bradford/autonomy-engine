import type {
  ConnectionDependentsResponse,
  ConnectionKind,
  DependentNode,
  DynamicDependentNode,
} from '@autonomy-studio/shared';
import { formatNameList, type DependencyCheck } from './dependencyCheck';

/**
 * #1252 — which pipeline NODES a connection edit breaks, said at the point of
 * the edit. The half `dependentTriggers.ts` left out, and the worse silence.
 *
 * A `kind` change that keeps the connection READY (its secret present, or a
 * credential-less kind to another) trips no reverse gate: kind-validity is
 * outside readiness by design, so every dependent trigger stays ENABLED, fires
 * on schedule, and fails every run with `CONNECTION_KIND_INVALID`. The trigger
 * note is correctly silent there — nothing is being disabled — and the triggers
 * page goes on showing a healthy `enabled`. This note is what says otherwise.
 *
 * Drawn on ANY kind move, not only a readiness-crossing one, because a node's
 * accepted kinds have nothing to do with secrets. Still ADVISORY, never a gate:
 * the server accepts the write, and dispatch remains the refusal.
 *
 * Answered locally per Kind select from `acceptedKinds`, which the server sends
 * per node (see `DependentNodeSchema`), so moving the select costs no request.
 */
export type NodeCheck = DependencyCheck<{
  readonly nodes: readonly DependentNode[];
  readonly dynamicNodes: readonly DynamicDependentNode[];
}>;

/** The form-open read, in the shape the helpers below take. */
export function nodeCheckOf(
  dependents: ConnectionDependentsResponse | null,
  unavailable: string | null,
): NodeCheck {
  if (unavailable !== null) return { state: 'unavailable', detail: unavailable };
  if (dependents === null) return { state: 'loading' };
  return { state: 'known', nodes: dependents.nodes, dynamicNodes: dependents.dynamicNodes };
}

/**
 * The nodes this kind change NEWLY breaks: the stored kind satisfies them and
 * the next one does not. A node that already refuses the stored kind is left
 * out — it fails today, and blaming this edit for it would be a false claim.
 */
export function nodesBrokenByKind(
  nodes: readonly DependentNode[],
  storedKind: ConnectionKind,
  nextKind: ConnectionKind,
): DependentNode[] {
  return nodes.filter(
    (node) => node.acceptedKinds.includes(storedKind) && !node.acceptedKinds.includes(nextKind),
  );
}

/**
 * `nightly etl › summarise`, deduped: the candidate set can hold a pipeline's
 * latest version AND an older trigger-pinned one, and naming the same node
 * twice would read as two nodes. Deduped by `pipelineId`, NOT the label —
 * pipeline names are not unique, and two pipelines sharing one are two nodes.
 */
function nodeLabels(nodes: readonly DynamicDependentNode[]): string[] {
  const byNode = new Map<string, string>();
  for (const node of nodes) {
    byNode.set(`${node.pipelineId}\u0000${node.nodeId}`, `${node.pipelineName} › ${node.nodeId}`);
  }
  return [...byNode.values()];
}

function nodePhrase(labels: readonly string[], qualifier = ''): string {
  const noun = labels.length === 1 ? 'pipeline node' : 'pipeline nodes';
  return `${labels.length} ${qualifier}${noun} (${formatNameList(labels)})`;
}

/** Empty for an empty list, so callers can append it unconditionally. */
function dynamicNodeClause(
  dynamicNodes: readonly DynamicDependentNode[],
  alsoNamed: boolean,
  question: string,
): string {
  const labels = nodeLabels(dynamicNodes);
  if (labels.length === 0) return '';
  const verb = labels.length === 1 ? 'chooses' : 'choose';
  return ` ${nodePhrase(labels, alsoNamed ? 'other ' : '')} ${verb} a connection at run time, so only a run can say ${question}.`;
}

/**
 * The edit-form note. `null` ONLY when the select has not moved, or from a
 * completed read in which nothing breaks and nothing is unsettled.
 *
 * `triggersDisabled` is the trigger note's own condition
 * (`kindChangeDisablesTriggers`). When it holds, the save switches bound
 * triggers OFF and the note beside this one says so, so the "stays enabled"
 * clause would contradict it — it is dropped, not reworded.
 */
export function nodeKindAdvisory(
  check: NodeCheck,
  storedKind: ConnectionKind,
  nextKind: ConnectionKind,
  triggersDisabled: boolean,
): string | null {
  if (storedKind === nextKind) return null;
  const question = `whether ${nextKind} suits them`;
  switch (check.state) {
    case 'loading':
      return 'Still checking which pipeline nodes use this connection.';
    case 'unavailable':
      return `Could not check which pipeline nodes use this connection (${check.detail}) — any whose activity does not accept ${nextKind} will fail at run time.`;
    case 'known': {
      const broken = nodeLabels(nodesBrokenByKind(check.nodes, storedKind, nextKind));
      if (broken.length === 0) {
        const dynamic = dynamicNodeClause(check.dynamicNodes, false, question).trim();
        return dynamic === '' ? null : dynamic;
      }
      const verb = broken.length === 1 ? 'does' : 'do';
      return `Saving this breaks ${nodePhrase(broken)}: ${broken.length === 1 ? 'its' : 'their'} activity ${verb} not accept a ${nextKind} connection, so every run of ${broken.length === 1 ? 'it' : 'them'} fails${triggersDisabled ? '' : ` — and any trigger bound to ${broken.length === 1 ? 'it' : 'them'} will stay enabled and keep firing`}.${dynamicNodeClause(check.dynamicNodes, true, question)}`;
    }
  }
}

/**
 * The node clause of the delete confirm. Every node naming the connection
 * breaks, whatever kinds it accepts — the connection is gone. Empty string ONLY
 * on an earned empty.
 */
export function deleteConfirmNodeClause(check: NodeCheck): string {
  const question = 'whether they use it';
  switch (check.state) {
    case 'loading':
      return 'Still checking which pipeline nodes use it.';
    case 'unavailable':
      return `Could not check which pipeline nodes use it (${check.detail}) — any that do will fail at run time.`;
    case 'known': {
      const labels = nodeLabels(check.nodes);
      if (labels.length === 0) return dynamicNodeClause(check.dynamicNodes, false, question).trim();
      const verb = labels.length === 1 ? 'uses' : 'use';
      return `${nodePhrase(labels)} ${verb} it and will fail at run time until pointed at another connection.${dynamicNodeClause(check.dynamicNodes, true, question)}`;
    }
  }
}
