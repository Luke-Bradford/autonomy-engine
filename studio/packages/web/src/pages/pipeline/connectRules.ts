import {
  backEdgeDefect,
  closesForwardCycle,
  containerMembership,
  crossesContainerBoundary,
  type Container,
  type Edge,
  type Node,
} from '@autonomy-studio/shared';
import { activityLabels } from './activityLabel';
import { containerLabels } from './containerRules';
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
  | 'self-loop'
  | 'unknown-endpoint'
  | 'duplicate'
  | 'container-boundary'
  | 'forward-cycle'
  /* U6e — the three back-edge rules, reachable only for a `back: true`
     candidate. See the block at the foot of `connectRejection`. */
  | 'back-ancestry'
  | 'back-no-progress'
  | 'back-parallel-body';

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
   * The doc's containers — the store's working membership: seeded on load,
   * pruned when a node is deleted (#746), and created/re-parented by the
   * property panel (U6d). They are also legal EDGE ENDPOINTS, so leaving them
   * out would make an existing container edge invisible to both the endpoint and
   * the cycle rule.
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
  /** Each activity's identifying name (#878) — what a refusal calls its ends. */
  nodeLabels: ReadonlyMap<string, string>;
  /** Each container's identifying name (#883) — the text its box draws. */
  containerNames: ReadonlyMap<string, string>;
  /**
   * Which container owns each child, FIRST-declared-wins
   * (`containerMembership`, the reducer's and the save gate's own SSOT).
   * Hoisted like everything else here: the boundary rule runs on every
   * pointer-move of a drag, and rebuilding the map per move would rescan every
   * container's children each time.
   */
  childOwner: ReadonlyMap<string, string>;
}

/**
 * Every legal edge endpoint id: nodes UNION containers.
 *
 * `from`/`to` is ONE string field over a namespace the save gate keeps globally
 * unique, so an edge may name either kind. Exported (#786) because
 * `canvasStore.loadVersion` needs the same set to drop an edge whose endpoint
 * resolves to nothing, and two hand-rolled copies of "what counts as an
 * endpoint" is exactly the drift that lets one of them go stale.
 */
export function edgeEndpointIds(
  nodes: readonly Node[],
  containers: readonly Container[],
): Set<string> {
  return new Set([...nodes.map((n) => n.id), ...containers.map((c) => c.id)]);
}

export function precomputeConnect(graph: ConnectGraph): ConnectPrecheck {
  return {
    graph,
    endpoints: edgeEndpointIds(graph.nodes, graph.containers),
    edgeKeys: new Set(graph.edges.map((e) => authoringEdgeKey(e))),
    nodeLabels: activityLabels(graph.nodes),
    containerNames: containerLabels(graph.containers),
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
 * #878 — an activity is named by its IDENTIFYING name (`activityLabels`: kind
 * plus within-kind ordinal, the text its box carries), so a refusal between two
 * `http_request` nodes no longer reads as one word twice. It used to, on the
 * grounds that transient feedback about two ports need only say WHAT was wired;
 * but the two ends of a refused connection are the one thing this sentence is
 * about, and naming them identically made the panel unreadable in exactly the
 * graph an operator is most likely to be building.
 * #883 — a CONTAINER endpoint is named by its `containerLabels` ordinal ("loop
 * 2"), which is the text its box now draws, so the sentence points at ONE
 * rectangle the operator can see. It used to be the bare kind, on the grounds
 * that that was the box's label; the box's label changed, and a refusal naming
 * "the loop container" with two loops on screen is the unreadable-id defect above
 * in a politer form — the operator still cannot tell which box is meant.
 *
 * An endpoint that is neither — an id from a stale view — degrades to the raw id
 * rather than inventing a name.
 */
function endpointLabel(pre: ConnectPrecheck, id: string): string {
  const name = pre.nodeLabels.get(id);
  if (name !== undefined) return name;
  const container = pre.containerNames.get(id);
  if (container !== undefined) return `${container} container`;
  return id;
}

/**
 * How a container is named when it is the OBSTACLE rather than an endpoint.
 *
 * Same `containerLabels` name as `endpointLabel` uses (#883), for the same
 * reason: a crossing refused by "the loop container" is unactionable while two
 * loops are on screen.
 *
 * `containerNames` is the ONLY lookup, with no `?? kind` behind it, and that is a
 * correctness point rather than brevity. It is built by `containerLabels` from
 * `graph.containers` — the same array `childOwner` is built from — so an id known
 * to either of them is known to both. A kind
 * fallback would be unreachable code advertising a degradation that cannot
 * happen, which is worse than none: a reader would take it as evidence that a
 * container can be nameless. `containerById` went the same way — replacing its
 * two readers with `containerNames` left it dead, and a dead field on a hot
 * precompute is a claim that something still needs it.
 */
function containerName(pre: ConnectPrecheck, id: string | undefined): string {
  const named = id === undefined ? undefined : pre.containerNames.get(id);
  return named === undefined ? 'a container' : `the ${named} container`;
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
    // case, and it is the one with the trap: the one-sided suggestion is false
    // here, because with both ends enclosed there is no "outside step" to wait on
    // the container, so it points at the two containers instead.
    //
    // #883 DELETED the other trap along with a special case. Naming both by KIND
    // said nothing when the kinds matched — "the stage container and the stage
    // container" reads as a contradiction — and the id was not available as the
    // disambiguator (a raw `c_<uuid>` is what U6b's browser pass caught), so a
    // shared-kind branch named the two NODES instead. `containerLabels` is now
    // that disambiguator and is drawn on the box, so both ends are named the same
    // way whether or not the kinds collide, and the branch is gone rather than
    // left as the one surface still naming a container by kind alone.
    const bothEnclosed = fromOwner !== undefined && toOwner !== undefined;
    const detail = bothEnclosed
      ? `'${fromName}' is inside ${containerName(pre, fromOwner)} and '${toName}' is ` +
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

  /* U6e — the back-edge's OWN rules, now that the canvas can author one.
     Until this ticket `back: true` only ever EXEMPTED a candidate (from the two
     rules above) and then accepted whatever was left, with no rule of its own.
     That was harmless while nothing could author one; it stops being harmless
     the moment the offer exists, because every one of these three is a refusal
     the #444 write gate makes.

     These cover the edge's own TOPOLOGY, and only that. A back-edge also has a
     doc-wide consequence no per-candidate rule can see — the first `back: true`
     edge flips `canReRunNodes`, disabling `settled`, so every
     `${nodes.x.status}` ref in the doc newly fails `validateRefs`. That one is
     left to the canvas' validation badge (and the Save gate) deliberately: it is
     reversible by deleting the edge, so refusing it here would make a legitimate
     loop unauthorable because of an expression in an unrelated node.

     Delegated to the shared predicate rather than restated, the same anti-drift
     shape the cycle and boundary rules use: `validateDoc`'s back-edge block and
     this one read the same helpers, so they cannot grow separate opinions.

     Reachable ONLY from the offer's enabled-ness check in `FlowCanvas` — a DRAG
     always carries `DRAWN_EDGE_CONDITION` with `back` unset — so these will read
     as dead code to anyone who greps for a caller that passes `back`. They are
     not: they are what decides whether the offer is shown at all. */
  if (candidate.back === true) {
    const defect = backEdgeDefect(pre.graph, pre.graph.containers, from, to);
    if (defect === 'parallel-body') {
      return {
        reason: 'back-parallel-body',
        message:
          `'${fromName}' → '${toName}' cannot be a back-edge: it touches a foreach body that ` +
          `runs its items in parallel, where the bounce counter — which is keyed by activity, ` +
          `not by item — would never fire and never cap`,
      };
    }
    if (defect === 'ancestry') {
      return {
        reason: 'back-ancestry',
        message:
          `'${fromName}' → '${toName}' cannot be a back-edge: a loop has to go BACK, and ` +
          `'${toName}' does not lead to '${fromName}'. Pick a step that already runs before ` +
          `'${fromName}', or the container enclosing it`,
      };
    }
    if (defect === 'no-progress') {
      return {
        reason: 'back-no-progress',
        message:
          `'${fromName}' → '${toName}' cannot be a back-edge: bouncing it would not re-run ` +
          `'${fromName}' itself, so the loop would repeat forever without making progress. ` +
          `Target a step on the path INTO '${fromName}'`,
      };
    }
  }

  return null;
}
