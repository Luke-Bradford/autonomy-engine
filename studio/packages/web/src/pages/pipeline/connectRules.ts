import {
  closesForwardCycle,
  containerMembership,
  crossesContainerBoundary,
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
  'self-loop' | 'unknown-endpoint' | 'duplicate' | 'container-boundary' | 'forward-cycle';

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
  /** Containers by id — an endpoint can be one, and it is named by its KIND. */
  containerById: ReadonlyMap<string, Container>;
  /**
   * Which container owns each child, FIRST-declared-wins
   * (`containerMembership`, the reducer's and the save gate's own SSOT).
   * Hoisted like everything else here: the boundary rule runs on every
   * pointer-move of a drag, and rebuilding the map per move would rescan every
   * container's children each time.
   */
  childOwner: ReadonlyMap<string, string>;
}

export function precomputeConnect(graph: ConnectGraph): ConnectPrecheck {
  return {
    graph,
    endpoints: new Set([...graph.nodes.map((n) => n.id), ...graph.containers.map((c) => c.id)]),
    edgeKeys: new Set(graph.edges.map((e) => authoringEdgeKey(e))),
    byId: new Map(graph.nodes.map((n) => [n.id, n])),
    containerById: new Map(graph.containers.map((c) => [c.id, c])),
    childOwner: containerMembership(graph.containers).owner,
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
 * A CONTAINER endpoint is named by its KIND — "loop", "stage", "foreach" — which
 * is the same word its box is labelled with on the canvas (U6c), so the sentence
 * points at something the operator can actually see. A container has no activity
 * and no name field, and falling through to the raw id here would reproduce the
 * exact unreadable-id defect above in its container form.
 *
 * An endpoint that is neither — an id from a stale view — degrades to the raw id
 * rather than inventing a name.
 */
function endpointLabel(pre: ConnectPrecheck, id: string): string {
  const node = pre.byId.get(id);
  if (node !== undefined) return getActivity(node.type)?.title ?? node.type;
  const container = pre.containerById.get(id);
  if (container !== undefined) return `${container.kind} container`;
  return id;
}

/** How a container is named when it is the OBSTACLE rather than an endpoint. */
function containerKind(pre: ConnectPrecheck, id: string | undefined): string | undefined {
  return id === undefined ? undefined : pre.containerById.get(id)?.kind;
}

function containerName(pre: ConnectPrecheck, id: string | undefined): string {
  const kind = containerKind(pre, id);
  return kind === undefined ? 'a container' : `the ${kind} container`;
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

  /* U6c — encapsulation, checked BEFORE the cycle sweep.
     Ordered first because it is the narrower fact (a candidate can cross a
     boundary AND close a cycle, and the crossing is the one the operator can see
     the cause of, now that the box is drawn) and because it is two map lookups
     against the sweep's two linear passes.
     A back-edge is exempt the same way the save gate exempts it — a child may
     back-edge to its enclosing container, which is the loop idiom. The shared
     predicate is condition-only, so the exemption is stated here. */
  if (candidate.back !== true && crossesContainerBoundary(pre.childOwner, from, to)) {
    const fromOwner = pre.childOwner.get(from);
    const toOwner = pre.childOwner.get(to);
    // Which side is enclosed decides BOTH how the sentence reads and what it can
    // honestly suggest. Both enclosed (in DIFFERENT containers) is the third
    // case, and it is the one with the traps:
    //  - naming both by kind says nothing when the kinds MATCH — "the stage
    //    container and the stage container" reads as a contradiction. The id is
    //    not available as the disambiguator (`containerName`: a raw `c_<uuid>`
    //    is what U6b's browser pass caught), so the shared-kind sentence names
    //    the two NODES instead, which is what the operator can see on screen;
    //  - the one-sided suggestion is false here. With both ends enclosed there
    //    is no "outside step" to wait on the container, so it points at the two
    //    containers instead.
    const bothEnclosed = fromOwner !== undefined && toOwner !== undefined;
    const fromKind = containerKind(pre, fromOwner);
    const sharedKind =
      bothEnclosed && fromKind === containerKind(pre, toOwner) ? fromKind : undefined;
    const detail = bothEnclosed
      ? sharedKind !== undefined
        ? `'${fromName}' and '${toName}' are in different ${sharedKind} containers`
        : `'${fromName}' is inside ${containerName(pre, fromOwner)} and '${toName}' is ` +
          `inside ${containerName(pre, toOwner)}`
      : fromOwner !== undefined
        ? `'${fromName}' is inside ${containerName(pre, fromOwner)}`
        : `'${toName}' is inside ${containerName(pre, toOwner)}`;
    const suggestion = bothEnclosed
      ? `Connect the containers themselves instead, so one waits for the whole of the other ` +
        `to finish`
      : `Connect the container itself instead, so the outside step waits for the whole ` +
        `container to finish`;
    return {
      reason: 'container-boundary',
      message:
        `'${fromName}' → '${toName}' would cross a container boundary — ${detail}, and a ` +
        `child's edges must stay inside it. ${suggestion}`,
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
