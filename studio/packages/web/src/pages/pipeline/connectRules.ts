import {
  closesForwardCycle,
  getActivity,
  type Container,
  type Edge,
  type Node,
} from '@autonomy-studio/shared';
import { authoringEdgeKey, edgeLabel, type EdgeCondition } from './edgeCondition';

/**
 * U6b — the rules a connection DRAG is measured against, decided BEFORE the
 * edge exists.
 *
 * Every rule here is one the doc already has: three of them the canvas store
 * enforced SILENTLY (a refused `connect` was an indistinguishable no-op), and
 * the fourth — the forward-DAG rule — was left to the save gate, so the operator
 * could draw an edge, watch it appear, and only then learn from a validation
 * badge that the pipeline can never run. Making them all decidable at
 * connect time is what lets React Flow refuse the gesture and lets the canvas
 * SAY WHY.
 *
 * Pure and framework-free, so the store (which is not React) and the canvas
 * (which is) can share one predicate rather than two that must agree.
 */

/** Why a candidate connection was refused. */
export type ConnectRejectionReason =
  'self-loop' | 'unknown-endpoint' | 'duplicate' | 'forward-cycle';

export interface ConnectRejection {
  reason: ConnectRejectionReason;
  /** Operator-facing, names the endpoints, and says what to do instead. */
  message: string;
}

/** The working graph a candidate is judged against. */
export interface ConnectGraph {
  nodes: Node[];
  edges: Edge[];
  /**
   * The doc's containers. Not authorable on the canvas yet (U6c/U6d) — they come
   * from the version the canvas was opened on, the same carry-forward a save
   * writes back — but they are legal EDGE ENDPOINTS, so leaving them out would
   * make an existing container edge invisible to both the endpoint and the
   * cycle rule.
   */
  containers: Container[];
}

/** A connection the operator is proposing. */
export interface ConnectCandidate {
  from: string;
  to: string;
  /**
   * The routing key the edge would carry. One value, not an `on` plus a loose
   * `branch` (`EdgeCondition`'s whole point) — the duplicate rule keys on it, so
   * an operational `success` and a `switch` case labelled `success` must not
   * collapse into one.
   */
  condition: EdgeCondition;
  /** A back-edge is not part of the forward graph, so the DAG rule skips it. */
  back?: boolean;
}

/**
 * Per-GRAPH work, hoisted out of the per-candidate check.
 *
 * React Flow calls `isValidConnection` on every pointer-move while a connection
 * is being dragged, so the endpoint set and the edge-key set are built ONCE per
 * graph by the caller (a `useMemo` on the canvas) and the per-move check is then
 * two set lookups plus — only for a candidate that passes them — the linear
 * cycle sweep.
 */
export interface ConnectPrecheck {
  graph: ConnectGraph;
  /** Every legal edge endpoint: node ids AND container ids. */
  endpoints: ReadonlySet<string>;
  /** `authoringEdgeKey` of every existing edge. */
  edgeKeys: ReadonlySet<string>;
  /** Nodes by id, for naming an endpoint the way the canvas labels it. */
  byId: ReadonlyMap<string, Node>;
}

export function precomputeConnect(graph: ConnectGraph): ConnectPrecheck {
  return {
    graph,
    endpoints: new Set([...graph.nodes.map((n) => n.id), ...graph.containers.map((c) => c.id)]),
    edgeKeys: new Set(graph.edges.map((e) => authoringEdgeKey(e))),
    byId: new Map(graph.nodes.map((n) => [n.id, n])),
  };
}

/**
 * How an endpoint is NAMED to the operator: by its activity, the way the node is
 * labelled on the canvas.
 *
 * Found in the browser, not in review — and it is why every message here goes
 * through this function. Node ids are minted by `newLocalId`
 * (`n_7c44a16f-98f1-4958-…`), so the first version of the refusal panel read
 * *"'n_7c44a16f-…' → 'n_9c4bb103-…' would close a forward cycle"*: literally
 * true, and unreadable. The unit specs could not catch it because their fixtures
 * use ids a human would choose (`'a'`, `'b'`).
 *
 * Two same-typed nodes therefore share a label. That is accepted: this text is
 * transient feedback about the two ports the operator's pointer just connected,
 * so it names WHAT they wired, not which of two identical activities it was —
 * and there is no per-node name to use instead (`Node` has an id and a type).
 * An endpoint with no node — a container id (U6c/U6d), or an id from a stale
 * view — degrades to the raw id rather than inventing a name.
 */
function endpointLabel(pre: ConnectPrecheck, id: string): string {
  const node = pre.byId.get(id);
  if (node === undefined) return id;
  return getActivity(node.type)?.title ?? node.type;
}

/** The edge a candidate would become — the value both remaining rules read. */
function candidateEdge(c: ConnectCandidate): Edge {
  const base = { id: '__candidate__', from: c.from, to: c.to, ...(c.back ? { back: true } : {}) };
  return { ...base, ...c.condition } as Edge;
}

/**
 * Why this connection cannot be made, or `null` if it can.
 *
 * ORDER IS THE MESSAGE. The rules are ordered most-specific-first: a self-loop
 * is also a cycle, and a duplicate is not a cycle at all, so reporting the
 * narrow reason is what makes the text actionable rather than merely true.
 */
export function connectRejection(
  pre: ConnectPrecheck,
  candidate: ConnectCandidate,
): ConnectRejection | null {
  const { from, to } = candidate;
  const fromName = endpointLabel(pre, from);
  const toName = endpointLabel(pre, to);

  if (from === to) {
    // Refused whether or not it is a back-edge: the back-edge ancestry rule
    // requires the TARGET to forward-reach the SOURCE, which a node can never do
    // for itself, so a self-loop is unsavable in either shape. A single activity
    // that must repeat is a loop CONTAINER (U6d), not an edge.
    return {
      reason: 'self-loop',
      message: `'${fromName}' cannot connect to itself — repeat an activity with a loop container, not an edge`,
    };
  }

  const missing = !pre.endpoints.has(from) ? from : !pre.endpoints.has(to) ? to : null;
  if (missing !== null) {
    return {
      reason: 'unknown-endpoint',
      message: `'${missing}' is not on this canvas`,
    };
  }

  const probe = candidateEdge(candidate);
  if (pre.edgeKeys.has(authoringEdgeKey(probe))) {
    return {
      reason: 'duplicate',
      message:
        `'${fromName}' → '${toName}' already has a '${edgeLabel(probe)}' edge — select it to ` +
        `change its condition, or delete it first`,
    };
  }

  // A back-edge is exempt: it is not in the forward graph, so it cannot close a
  // forward cycle. (It has its own rules — ancestry, `maxBounces`, progress —
  // which only become reachable once the canvas can author one: U6e.)
  if (candidate.back !== true && closesForwardCycle(pre.graph, pre.graph.containers, from, to)) {
    return {
      reason: 'forward-cycle',
      message:
        `'${fromName}' → '${toName}' would close a loop: '${toName}' already leads back to ` +
        `'${fromName}'. The forward graph must stay a DAG — a loop is expressed as a back-edge ` +
        `with a maxBounces cap`,
    };
  }

  return null;
}
