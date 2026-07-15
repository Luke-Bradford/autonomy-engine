import type {
  Container,
  Edge,
  EngineCommand,
  EngineEvent,
  Node,
  NodeRunState,
  ContainerRunState,
  PipelineVersion,
  ReduceResult,
  RunState,
  SubstitutionContext,
  TerminalNodeStatus,
} from './types.js';
import { SubstituteError, TERMINAL_NODE, terminalStatusOf } from './types.js';
import type { OutputType } from '../schemas/pipeline.js';
import { outputContract, type CheckedContract, type OutputContract } from './outputs.js';
import {
  backEdgeResetBody,
  effectiveEdges,
  forwardDescendants,
  nodeForwardAdjacency,
  nodeJoin,
  substitute,
  wholeValueDefect,
} from './params.js';

// ---------------------------------------------------------------------------
// P2b + P2c — the PURE event-sourced reducer + walk (DAG, back-edges,
// containers, and call_pipeline).
//
// `createEngine(doc)` binds a pipeline's immutable graph and returns the pure
// `reduce(state, event)` (the exact 2-arg contract) plus `projectRunState` and a
// `seedState` helper. NO I/O, NO clock, NO random — an `attemptId` is minted
// from `NodeRunState.attempts`, not generated; a `childRunId` is a pure hash of
// (runId, callNodeId, attemptId). Immutable: every transition returns NEW
// objects; the input state is never mutated.
//
// The invariant (CP1): commands out, state changes only on events. The reducer
// returns `dispatchNode`/`startChild`/`finishRun` COMMANDS; the driver performs
// each and appends the resulting event, and only folding that event changes
// state.
//
// P2c layers three constructs onto the P2b acyclic walk. Each is INERT for a
// doc that does not use it (no containers → the container walk is a no-op; no
// `back` edges → no back-edge phase; no `call` config → nodes dispatch as
// before), so the P2b DAG walk + all its invariants are preserved byte-for-byte
// for container-free / loop-free / call-free docs:
//   - back-edges (`edge.back`): a satisfied back-edge resets its loop body and
//     re-walks; `maxBounces` caps it (→ `finishRun{failure,"capped"}`).
//   - containers (loop | stage): a child NAMESPACE with its own lifecycle; a
//     `stage` exits when all children terminal, a `loop` re-rounds until
//     `exitWhen` / `maxRounds`. The container's terminal outcome fires its OUTER
//     edges; a child `skipped` never fails the container.
//   - `call_pipeline` (`node.call`): emits `startChild`, holds the node
//     `waiting` until `call.returned` (a FAILED child still returns outputs).
// ---------------------------------------------------------------------------

/** The immutable graph the reducer walks. Params/outputs arrive via events. */
export type EngineDoc = Pick<PipelineVersion, 'nodes' | 'edges'> & {
  /** Control-flow containers (P2c). Optional/`[]` → a flat P2b DAG walk. */
  containers?: PipelineVersion['containers'];
};

/** The engine bound to one pipeline version's graph (the exact 2-arg reduce). */
export interface Engine {
  /** The pre-`run.started` seed (status `pending`, empty everything). */
  seedState(): RunState;
  /** PURE: fold one event → new state + commands-to-run + diagnostics. */
  reduce(state: RunState, event: EngineEvent): ReduceResult;
  /** Replay: fold `reduce` over a whole log from the seed (for tests + boot). */
  projectRunState(events: EngineEvent[]): RunState;
}

const LIVE_NODE = new Set<NodeRunState['status']>(['ready', 'dispatched']);

/**
 * An edge that can never satisfy — its predecessor is terminal and settled the
 * wrong way (`unsatisfied-terminal`), or the edge is structurally unreachable
 * (`impossible`). The SSOT for both readers: `computeReadiness` (a dead GROUP
 * skips its successor) and `outcomeFailure` (a dead edge is where a skip-taint
 * travels). They must never be able to disagree on what "dead" means — the
 * outcome predicate follows taint along exactly the edges readiness killed.
 */
const isEdgeStateDead = (s: EdgeState): boolean =>
  s === 'impossible' || s === 'unsatisfied-terminal';

/**
 * A defensive hard CEILING on back-edge traversals — both the fallback when a
 * back-edge declares no `maxBounces` (which `validateDoc` requires, so this
 * bounds a doc that bypassed validation) and an upper clamp on a declared one.
 *
 * The clamp is load-bearing, not belt-and-braces. Bounces normally cost a round
 * of real I/O: firing a back-edge resets its body to `pending`, the body then
 * DISPATCHES (non-terminal), and the whole-body-terminal gate blocks a refire
 * until the driver's events land — so the driver paces the loop. A body reached
 * only by `skipped` edges never dispatches (reset → skipped → terminal →
 * refire), so every bounce runs synchronously inside ONE `reduce()` with no I/O
 * between them. `maxBounces` has no schema upper bound, so an unclamped
 * `maxBounces: 100_000_000` burns ~60s of CPU in a single call and blocks the
 * in-process driver's event loop. Clamping here (rather than rejecting the doc
 * at save time) keeps it fail-safe: no previously-valid doc becomes unsavable.
 */
const DEFENSIVE_BOUNCE_CAP = 10_000;

/** Per-incoming-edge state for a successor's readiness (the CP1 truth table). */
type EdgeState = 'satisfied' | 'unsatisfied-terminal' | 'pending' | 'impossible';

/** A node's computed readiness given its incoming edges' states + join rule. */
type Readiness = 'ready' | 'skipped' | 'pending';

/**
 * A terminal outcome for an endpoint (node OR container), or `null` if live.
 * Pinned to the language's `TerminalNodeStatus` vocabulary rather than
 * re-spelling it, so the reducer's outcome model and `${nodes.<id>.status}`
 * cannot drift apart.
 */
type EndpointOutcome = TerminalNodeStatus | null;

/**
 * A STABLE key for an edge, from (from, to, on, branch) — NOT an array index —
 * so a doc save/reorder never changes which `bounces[...]` counter a back-edge
 * maps to (CP1). `\x00` is a delimiter that cannot occur in an id/enum.
 *
 * The `branch` label is part of the key because two arms of one switch share
 * (from, to, 'branch'): without it, `X --branch:a--> Y` and `X --branch:b--> Y`
 * would share a single bounce counter (halving `maxBounces`) and resolve each
 * other's reset body. Unreachable while branch edges are inert (nothing emits a
 * branch outcome until #4 A0/A1/A2) — kept correct by construction so the
 * collision can't be introduced later by a ticket that isn't looking for it.
 */
function stableEdgeKey(e: Edge): string {
  return `${e.from}\x00${e.to}\x00${e.on}\x00${e.on === 'branch' ? e.branch : ''}`;
}

/**
 * Bind a pipeline's graph and return the pure engine. All graph analysis
 * (incoming/outgoing edges, the implicit success-chain, container membership,
 * back-edge bodies, sorted orders) is precomputed ONCE here and closed over —
 * `reduce` itself does no graph walk beyond readiness lookups, and never
 * touches anything outside `state`/`event`.
 */
export function createEngine(doc: EngineDoc): Engine {
  const nodeIds = doc.nodes.map((n) => n.id);
  const nodeById = new Map<string, Node>(doc.nodes.map((n) => [n.id, n]));

  const containers: Container[] = doc.containers ?? [];
  const containerById = new Map<string, Container>(containers.map((c) => [c.id, c]));
  const containerIds = containers.map((c) => c.id);
  const childToContainer = new Map<string, string>();
  for (const c of containers) for (const ch of c.children) childToContainer.set(ch, c.id);
  const childSet = new Set(childToContainer.keys());
  const topLevelNodeIds = nodeIds.filter((id) => !childSet.has(id));

  // Endpoints for edges = node ids ∪ container ids (an OUTER edge may name a
  // container). Back-edges are split out; forward edges drive the acyclic walk.
  const endpointIds = new Set<string>([...nodeIds, ...containerIds]);
  const allEdges = effectiveEdges(doc);
  const forwardEdges = allEdges.filter(
    (e) => !e.back && endpointIds.has(e.from) && endpointIds.has(e.to),
  );
  const backEdges = allEdges.filter(
    (e) => e.back && endpointIds.has(e.from) && endpointIds.has(e.to),
  );

  // Partition forward edges: INTERNAL (both endpoints children of the SAME
  // container) walk within that container; everything else is a TOP-LEVEL edge
  // between top-level entities (top-level nodes and container ids).
  const internalForwardByContainer = new Map<string, Edge[]>();
  for (const c of containers) internalForwardByContainer.set(c.id, []);
  const topForwardEdges: Edge[] = [];
  for (const e of forwardEdges) {
    const fc = childToContainer.get(e.from);
    const tc = childToContainer.get(e.to);
    if (fc !== undefined && fc === tc) internalForwardByContainer.get(fc)!.push(e);
    else topForwardEdges.push(e);
  }

  // Top-level readiness graph (entities = top-level nodes + containers).
  const topEntities = [...topLevelNodeIds, ...containerIds];
  const sortedTopEntities = [...topEntities].sort();
  const topIncoming = new Map<string, Edge[]>();
  const topOutgoing = new Map<string, Edge[]>();
  for (const id of topEntities) {
    topIncoming.set(id, []);
    topOutgoing.set(id, []);
  }
  for (const e of topForwardEdges) {
    if (topOutgoing.has(e.from)) topOutgoing.get(e.from)!.push(e);
    if (topIncoming.has(e.to)) topIncoming.get(e.to)!.push(e);
  }

  // (F1b removed a `backOutgoing` index here. Its ONLY reader was the old
  // "is this failure handled?" predicate, which counted a failure/completion
  // BACK-edge as handling — fail-open when that edge never fires. The outcome
  // predicate is forward-only; back-edges still drive `fireBackEdges` via
  // `backEdges`/`backBodyByKey` below.)

  // Per-container internal readiness graph (over its children).
  const childIncoming = new Map<string, Edge[]>();
  const childOutgoing = new Map<string, Edge[]>();
  for (const ch of childSet) {
    childIncoming.set(ch, []);
    childOutgoing.set(ch, []);
  }
  for (const c of containers) {
    for (const e of internalForwardByContainer.get(c.id)!) {
      childOutgoing.get(e.from)!.push(e);
      childIncoming.get(e.to)!.push(e);
    }
  }

  // Node→node forward reachability (for back-edge body computation). Container
  // endpoints are excluded — a bare back-edge's body is a node path. Built via
  // the SSOT helpers in params.ts so the reducer and `validateDoc` compute the
  // SAME reset body (they can never disagree on which nodes a bounce resets).
  const nodeAdj = nodeForwardAdjacency(doc);
  const descendants = new Map<string, Set<string>>();
  for (const id of nodeIds) descendants.set(id, forwardDescendants(id, nodeAdj));

  // Precompute each back-edge's loop body (the nodes it resets on a bounce):
  //   - target is a container → its children.
  //   - target is a node → the nodes on forward paths target..source (inclusive).
  const backBodyByKey = new Map<string, string[]>();
  for (const be of backEdges) {
    backBodyByKey.set(
      stableEdgeKey(be),
      backEdgeResetBody(be, nodeIds, descendants, containerById),
    );
  }

  // --- endpoint / edge helpers (pure over the passed-in `state`) ------------

  /** A node's or container's terminal outcome, or `null` if not yet terminal. */
  function endpointOutcome(id: string, state: RunState): EndpointOutcome {
    if (containerById.has(id)) {
      const cs = state.containers[id];
      if (cs === undefined) return null;
      return cs.status === 'success' || cs.status === 'failure' || cs.status === 'skipped'
        ? cs.status
        : null;
    }
    const ns = state.nodes[id];
    if (ns === undefined) return null;
    return TERMINAL_NODE.has(ns.status) ? (ns.status as EndpointOutcome) : null;
  }

  /** The state of ONE incoming edge, from its predecessor endpoint's outcome. */
  function edgeState(edge: Edge, state: RunState): EdgeState {
    if (!endpointIds.has(edge.from)) return 'impossible';
    const oc = endpointOutcome(edge.from, state);
    if (oc === null) return 'pending';
    // Business routing: no activity emits a branch outcome yet (#4 A0/A1/A2), so
    // a branch edge can never satisfy. `settle` reports this as a diagnostic
    // rather than letting the downstream strand silently.
    if (edge.on === 'branch') return 'unsatisfied-terminal';
    if (oc === 'skipped') {
      // A skip propagates unless something explicitly catches it. `completion`
      // does NOT catch it: the activity never ran, so it never completed.
      return edge.on === 'skipped' ? 'satisfied' : 'impossible';
    }
    if (oc === 'success') {
      return edge.on === 'success' || edge.on === 'completion'
        ? 'satisfied'
        : 'unsatisfied-terminal';
    }
    // failure
    return edge.on === 'failure' || edge.on === 'completion' ? 'satisfied' : 'unsatisfied-terminal';
  }

  /**
   * The join truth table over an entity's incoming edges (CP1, corrected by
   * F14/T7). No incoming edge → a root (ready).
   *
   * Edges are grouped BY PREDECESSOR first: **AND across predecessors, OR among
   * the conditions on one predecessor** (ADF `dependsOn`). The OR is what makes
   * multi-condition dependencies expressible at all — `a --success--> d` plus
   * `a --skipped--> d` are alternatives, and ANDing them edge-wise (as this did
   * before F14) meant one was always dead, so `d` could never run.
   *
   * A predecessor group is `satisfied` if ANY of its conditions satisfied,
   * `dead` if ALL of them are dead (`impossible` ∪ `unsatisfied-terminal`),
   * else `pending`. Then `all` → ready iff every group satisfied, skipped iff
   * any group dead; `any` → ready iff ≥1 group satisfied, skipped iff all dead.
   * (`any` is unchanged by the grouping: OR distributes over OR.)
   */
  function computeReadiness(incoming: Edge[], join: 'all' | 'any', state: RunState): Readiness {
    if (incoming.length === 0) return 'ready';

    const byPredecessor = new Map<string, EdgeState[]>();
    for (const e of incoming) {
      const states = byPredecessor.get(e.from);
      if (states === undefined) byPredecessor.set(e.from, [edgeState(e, state)]);
      else states.push(edgeState(e, state));
    }
    // Order-independent (`every`/`some`), so Map iteration order can't affect
    // the result — the reducer stays pure and replay-stable. A GROUP is never
    // 'skipped' (only a whole entity is), hence its own type rather than
    // `Readiness`.
    type Group = 'ready' | 'dead' | 'pending';
    const groups = [...byPredecessor.values()].map((states): Group =>
      states.some((s) => s === 'satisfied')
        ? 'ready'
        : states.every(isEdgeStateDead)
          ? 'dead'
          : 'pending',
    );

    if (join === 'all') {
      if (groups.every((g) => g === 'ready')) return 'ready';
      if (groups.some((g) => g === 'dead')) return 'skipped';
      return 'pending';
    }
    if (groups.some((g) => g === 'ready')) return 'ready';
    if (groups.every((g) => g === 'dead')) return 'skipped';
    return 'pending';
  }

  /**
   * THE outcome predicate (F1b, joint spec §C.3/§C.4) — the single definition
   * of "did this scope's outcome fail", returning the BLAMED entity id or
   * `null` for success.
   *
   * A scope FAILS iff EITHER conjunct fails. Both are load-bearing:
   *
   *   1. **Absorption** — every `failure` entity must be absorbed: by a
   *      satisfied outgoing `failure`/`completion` edge whose target actually
   *      RAN, or by a skip-taint that transitively reaches a satisfied
   *      `on:'skipped'` catch whose target RAN. A taint that merely EVAPORATES
   *      — the successor ran for an unrelated reason, e.g. a `join:'any'`
   *      satisfied by a different predecessor — is NOT absorption.
   *   2. **Leaf-evaluation** — every forward leaf must evaluate to success; a
   *      `skipped` leaf RECURSES to its parents instead (ADF: "Evaluate outcome
   *      for all leaves… If a leaf activity was skipped, we evaluate its parent
   *      activity instead. Pipeline result is success if and only if all nodes
   *      evaluated succeed"). ALL parents are evaluated and ANY evaluated
   *      failure fails the scope — ADF's own "all nodes evaluated" settles the
   *      "which parent?" question, and it is the fail-safe direction.
   *
   * Neither conjunct alone is correct. ADF's leaf rule ALONE is **fail-open**
   * under `join:'any'` — a join ADF does not have, so the rule was never
   * designed against the shape: a wholly uncaught failure whose taint dies at a
   * live sibling leaves no skipped leaf to evaluate, and the run reports
   * success (pinned in `edge-model.test.ts`). Absorption alone leaves the ADF
   * Do-If-Else shape green.
   *
   * SCOPED so the run and a container share ONE rule (§D): pass the top-level
   * entity/edge maps, or a container's child ones. A container's outcome is
   * decided by the same predicate as the run's, scoped to its children.
   *
   * Pure — reads `state` and the bound graph only, never the clock or a mutable
   * row, so it is replay-stable. Both walks carry a `seen` set and terminate on
   * a revisit: a skip-PROPAGATED cycle IS reachable here (every node in it is
   * terminal-`skipped`, so unlike a forward cycle it does not stall the walk
   * before evaluation), and without the guard the walk never ends.
   *
   * **Both walks are ITERATIVE (an explicit stack), not recursive, and that is a
   * requirement rather than a preference.** The predicate they replaced was a
   * flat loop; a recursive form makes the reducer's stack depth O(chain length)
   * on a doc it does not control, and a `RangeError` thrown from inside the PURE
   * reducer crashes the driver's pump. Measured before this was changed: a
   * skipped chain blew the stack at ~5k entities where the old code was fine.
   * No node-count cap exists (`pipeline.ts`'s `nodes` is a bare `z.array`), and
   * the doc need not be validated (#444) — so the bound must come from the walk.
   *
   * Lookups are `?? []`, never `!`: `validateDoc` forbids a cross-boundary
   * forward edge, but it is ADVISORY (its only caller is the canvas badge; the
   * server never calls it — #444), so a git import or a direct POST can reach
   * this reducer with an edge whose endpoint is absent from the scope's map.
   */
  function outcomeFailure(
    entities: readonly string[],
    outgoing: ReadonlyMap<string, Edge[]>,
    incoming: ReadonlyMap<string, Edge[]>,
    state: RunState,
  ): string | null {
    const outs = (id: string): readonly Edge[] => outgoing.get(id) ?? [];
    const ins = (id: string): readonly Edge[] => incoming.get(id) ?? [];
    const ran = (id: string): boolean => {
      const oc = endpointOutcome(id, state);
      return oc === 'success' || oc === 'failure';
    };

    /**
     * A SKIPPED entity's taint, followed to a satisfied `on:'skipped'` catch
     * that RAN. Iterative (see the note above); order is irrelevant to a
     * boolean, so a plain LIFO stack is enough.
     */
    function absorbedSkip(from: string, seen: Set<string>): boolean {
      const stack = [from];
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const e of outs(id)) {
          const es = edgeState(e, state);
          if (e.on === 'skipped' && es === 'satisfied' && ran(e.to)) return true;
          if (isEdgeStateDead(es) && endpointOutcome(e.to, state) === 'skipped') stack.push(e.to);
        }
      }
      return false;
    }

    /**
     * Conjunct 1, per entity.
     *
     * Each dead edge starts a FRESH `absorbedSkip` walk, so overlapping skip
     * subgraphs are re-walked once per candidate — a multiplicative cost on top
     * of `settle`'s already-O(n²) worst case, worth knowing before a large-doc
     * benchmark surprises someone. It is bounded (candidates × taint subgraph)
     * and invisible at real doc sizes, so it is not optimised here.
     *
     * If it ever needs to be: sharing ONE `seen` across the walks is safe, but
     * only because of an asymmetry worth stating rather than rediscovering. A
     * walk that returns `false` has drained its stack, so every id it marked is
     * *proven* non-absorbing and re-walking it can only return `false` again. A
     * walk that returns `true` short-circuits mid-scan and leaves ids marked but
     * unexplored — reusing THAT set would be unsound. Since a `true` ends the
     * whole predicate for this entity, the set is discarded exactly when it
     * would have been unsafe to keep.
     */
    function absorbedFailure(id: string): boolean {
      for (const e of outs(id)) {
        const es = edgeState(e, state);
        if ((e.on === 'failure' || e.on === 'completion') && es === 'satisfied' && ran(e.to)) {
          return true;
        }
        if (
          isEdgeStateDead(es) &&
          endpointOutcome(e.to, state) === 'skipped' &&
          absorbedSkip(e.to, new Set())
        ) {
          return true;
        }
      }
      return false;
    }

    /**
     * Conjunct 2, per leaf: the blamed id, or `null` if this endpoint evaluates
     * clean. Iterative (see the note above). Parents are pushed in REVERSE edge
     * order so the LIFO stack pops them in doc order — this reproduces the
     * depth-first, first-match-wins blame the recursive form gave, which is what
     * `finishRun.reason` names, so it must not drift.
     */
    function evalEndpoint(from: string, seen: Set<string>): string | null {
      const stack = [from];
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const oc = endpointOutcome(id, state);
        if (oc === 'failure') return id;
        if (oc !== 'skipped') continue;
        const parents = ins(id);
        for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]!.from);
      }
      return null;
    }

    for (const id of entities) {
      if (endpointOutcome(id, state) !== 'failure') continue;
      if (!absorbedFailure(id)) return id;
    }
    // Forward leaves. These maps exclude back-edges by construction, so this
    // predicate is forward-only where the pre-F1b one merged `backOutgoing`
    // (§C.5.3). That difference is **deliberate but unobservable**, and the
    // distinction is worth stating precisely rather than overclaiming: a
    // satisfied failure back-edge is consumed by `fireBackEdges` at the TOP of
    // `settle` — it bounces (resetting its source, so the source is no longer
    // terminal-`failure`) or exhausts its budget and finishes the run `capped`
    // — long before the walk reaches a fixpoint and this predicate runs. So no
    // reachable doc lets a terminal-`failure` node arrive here still holding
    // one, and mutation-testing agrees: re-merging back-edges into `outs`
    // leaves the whole suite green. It is NOT pinned, because there is nothing
    // observable to pin.
    //
    // What DOES close the fail-open the old code had is the `ran(e.to)`
    // requirement in `absorbedFailure`, which IS pinned: the old predicate
    // asked only whether a failure/completion edge EXISTED, so a handler that
    // could never run still read as handling.
    for (const id of entities) {
      if (outs(id).length > 0) continue;
      const blamed = evalEndpoint(id, new Set());
      if (blamed !== null) return blamed;
    }
    return null;
  }

  /** THE predicate at TOP-LEVEL scope (§B.2). `null` ⇒ the run succeeded. */
  function runOutcomeFailure(state: RunState): string | null {
    return outcomeFailure(sortedTopEntities, topOutgoing, topIncoming, state);
  }

  /**
   * The SAME predicate scoped to a container's children (§D) — one rule, two
   * scopes. An unhandled child failure fails the CONTAINER, not the run; the
   * container's own `failure` is then absorbed (or not) by its OUTER edges at
   * top level, which is a separate decision made by `runOutcomeFailure`.
   */
  function containerOutcomeFailure(c: Container, state: RunState): string | null {
    return outcomeFailure([...c.children].sort(), childOutgoing, childIncoming, state);
  }

  /** Every TOP-LEVEL entity is terminal (waiting/active/pending count as live). */
  function allTopLevelTerminal(state: RunState): boolean {
    return sortedTopEntities.every((id) => endpointOutcome(id, state) !== null);
  }

  /**
   * Build the `${}` context. `nodeOutputs` is `state.outputs`, populated by
   * `node.succeeded` (and a `call.returned`, whose outputs are recorded even on
   * a failing child) plus a container's projected outputs at exit. `triggerId`/
   * `parentRunId` are not carried in `RunState` here, so they resolve to `null`.
   *
   * `nodeStatuses` projects `state.nodes` down to bare statuses — the language
   * reads a node's verdict, never its `attempts`/`currentAttemptId` bookkeeping.
   * `startedAt` comes from the `run.started` FACT, so it is stable across the
   * whole run and identical on replay (`null` for a pre-E3 log).
   */
  function buildCtx(state: RunState): SubstitutionContext {
    const nodeStatuses: Record<string, NodeRunState['status']> = {};
    for (const [id, ns] of Object.entries(state.nodes)) nodeStatuses[id] = ns.status;
    return {
      params: state.params,
      nodeOutputs: state.outputs,
      nodeStatuses,
      run: {
        runId: state.runId,
        startedAt: state.startedAt,
        pipelineVersionId: state.pipelineVersionId,
        triggerId: null,
        parentRunId: null,
      },
    };
  }

  function prepInput(state: RunState, node: Node): Record<string, unknown> {
    return substitute(node.config, buildCtx(state)) as Record<string, unknown>;
  }

  // --- the readiness fixpoint ("fold-to-fixpoint", CP1 Q2) ------------------

  /**
   * A sentinel a walk step returns: `state` (possibly changed), whether it
   * `changed`, and an optional terminal `finish` command that short-circuits.
   */
  interface Step {
    state: RunState;
    changed: boolean;
    finish?: EngineCommand;
  }

  /**
   * A `branch` edge cannot be satisfied until #4 A0/A1/A2 ship the `if`/`switch`
   * activities that emit a branch outcome, so anything depending on one skips.
   * Say so.
   *
   * This diagnostic is the ONLY thing that makes that visible: `validateDoc`
   * reports a branch edge, but advisorily — its lone caller is the canvas, which
   * renders a badge and still allows Save, and the server never validates at all
   * (#444). So a branch edge reaches the reducer whether it came from git, a
   * direct POST, or the canvas itself. Without this, an operator just sees a
   * silently skipped subgraph.
   */
  function noteInertBranch(id: string, incoming: Edge[], diagnostics: string[]): void {
    const inert = incoming.filter((e) => e.on === 'branch').length;
    if (inert === 0) return;
    // Count them: on a fan-in, a hardcoded singular undercounts the cause and
    // sends the operator hunting ONE edge when several are inert.
    const subject = inert === 1 ? `an incoming 'branch' edge` : `${inert} incoming 'branch' edges`;
    // Deliberately worded as a contributing cause, not THE cause: the entity may
    // also have a genuinely dead operational predecessor, and claiming the branch
    // edge is why would send an operator down the wrong path.
    diagnostics.push(
      `'${id}' was skipped and has ${subject}, which can never be satisfied — no ` +
        `activity emits a branch outcome yet (#4 A0/A1/A2 implement if/switch against this schema)`,
    );
  }

  /**
   * Try to advance ONE pending node (top-level or a child): skip it, dispatch
   * it (`dispatchNode`), or — for a `call_pipeline` node — emit `startChild` and
   * hold it `waiting`. A prep-input failure short-circuits to `invalid_event`.
   */
  function tryDispatchNode(
    state: RunState,
    id: string,
    incoming: Edge[],
    commands: EngineCommand[],
    diagnostics: string[],
  ): Step {
    const ns = state.nodes[id]!;
    if (ns.status !== 'pending') return { state, changed: false };
    const node = nodeById.get(id)!;
    const r = computeReadiness(incoming, nodeJoin(node), state);
    if (r === 'skipped') {
      noteInertBranch(id, incoming, diagnostics);
      return { state: withNode(state, id, { status: 'skipped' }), changed: true };
    }
    if (r !== 'ready') return { state, changed: false };

    const attemptId = `${id}#${ns.attempts}`;
    if (node.call !== undefined) {
      // call_pipeline: resolve the (possibly `${}`) pipelineVersionId + params,
      // hold the node `waiting`, and ask the driver to spawn the child.
      let pvId: string;
      let callParams: Record<string, unknown>;
      try {
        const ctx = buildCtx(state);
        pvId = String(substitute(node.call.pipelineVersionId, ctx));
        callParams = substitute(node.call.params, ctx) as Record<string, unknown>;
      } catch (err) {
        return prepFailure(state, id, err, diagnostics);
      }
      const childRunId = deterministicChildRunId(state.runId, id, attemptId);
      const next = withNode(state, id, {
        status: 'waiting',
        attempts: ns.attempts + 1,
        currentAttemptId: attemptId,
      });
      commands.push({
        type: 'startChild',
        callNodeId: id,
        attemptId,
        childRunId,
        pipelineVersionId: pvId,
        params: callParams,
      });
      return { state: next, changed: true };
    }

    let prepared: Record<string, unknown>;
    try {
      prepared = prepInput(state, node);
    } catch (err) {
      return prepFailure(state, id, err, diagnostics);
    }
    const next = withNode(state, id, {
      status: 'ready',
      attempts: ns.attempts + 1,
      currentAttemptId: attemptId,
    });
    commands.push({ type: 'dispatchNode', nodeId: id, attemptId, preparedInput: prepared });
    return { state: next, changed: true };
  }

  function prepFailure(state: RunState, id: string, err: unknown, diagnostics: string[]): Step {
    const msg = err instanceof Error ? err.message : String(err);
    diagnostics.push(`dispatch prep failed for node '${id}': ${msg}`);
    return {
      state,
      changed: false,
      finish: { type: 'finishRun', outcome: 'failure', reason: 'invalid_event' },
    };
  }

  /**
   * Fire the first SATISFIED back-edge whose WHOLE reset body is terminal.
   * `bounces[edgeKey]++`; exceeding `maxBounces` (or the defensive cap) →
   * `finishRun{failure,"capped"}`. Otherwise reset the loop body to `pending`
   * and clear their outputs — a fresh round recomputes them. Back-edges are
   * considered in STABLE edgeKey order.
   */
  function fireBackEdges(state: RunState, diagnostics: string[]): Step {
    for (const be of [...backEdges].sort((a, b) => cmp(stableEdgeKey(a), stableEdgeKey(b)))) {
      if (edgeState(be, state) !== 'satisfied') continue;
      const key = stableEdgeKey(be);
      const body = backBodyByKey.get(key) ?? [];
      // WHOLE-BODY-terminal gate (mirrors stepContainers' children.every(TERMINAL)):
      // do NOT reset until every node a bounce would reset is terminal. Firing on
      // the SOURCE endpoint alone could reset an in-flight parallel sibling, whose
      // late result would then fold onto a `pending` node → a spurious
      // finishRun{invalid_event}. A `waiting` call child likewise blocks the reset.
      const bodyTerminal = body.every((id) => {
        const ns = state.nodes[id];
        return ns !== undefined && TERMINAL_NODE.has(ns.status);
      });
      if (!bodyTerminal) continue;
      // Every traversal increments; the increment is RECORDED even on the
      // traversal that exceeds the cap (so `bounces` reflects the true count).
      const count = (state.bounces[key] ?? 0) + 1;
      const withBounce: RunState = { ...state, bounces: { ...state.bounces, [key]: count } };
      // maxBounces is REQUIRED by validateDoc; the defensive cap both bounds an
      // unvalidated doc AND clamps a declared one, so no body can spin longer
      // than the ceiling inside a single reduce (see DEFENSIVE_BOUNCE_CAP).
      // Say so when it bites: a doc declaring 50_000 that stops at 10_000 would
      // otherwise report `capped` while the author reads their own doc and sees
      // a cap that was never honoured.
      const cap = Math.min(be.maxBounces ?? DEFENSIVE_BOUNCE_CAP, DEFENSIVE_BOUNCE_CAP);
      if (be.maxBounces !== undefined && be.maxBounces > DEFENSIVE_BOUNCE_CAP && count === 1) {
        diagnostics.push(
          `back-edge '${be.from}'→'${be.to}': declared maxBounces ${be.maxBounces} exceeds the ` +
            `engine ceiling ${DEFENSIVE_BOUNCE_CAP} and was clamped to it`,
        );
      }
      if (count > cap) {
        return {
          state: withBounce,
          changed: false,
          finish: { type: 'finishRun', outcome: 'failure', reason: 'capped' },
        };
      }
      return { state: resetNodes(withBounce, body), changed: true };
    }
    return { state, changed: false };
  }

  /**
   * Advance the first ACTIVE container whose current round is fully terminal:
   *   - an unhandled child failure → the container FAILS (fires its outer edges).
   *   - a `stage` → SUCCEEDS.
   *   - a `loop` → `exitWhen` true → SUCCEEDS; else another round if the round
   *     budget (`maxRounds`) allows (reset children, `round++`); else CAPPED
   *     (the container FAILS with reason `capped`).
   * Containers are considered in STABLE id order.
   */
  function stepContainers(state: RunState, diagnostics: string[]): Step {
    for (const cid of [...containerIds].sort()) {
      const c = containerById.get(cid)!;
      const cs = state.containers[cid]!;
      if (cs.status !== 'active') continue;
      if (!c.children.every((ch) => TERMINAL_NODE.has(state.nodes[ch]!.status))) continue;

      // The BLAMED child, which is not necessarily an UNHANDLED one: under
      // leaf-evaluation the blame can land on a child whose own failure WAS
      // absorbed, reached by a skipped leaf recursing to its parents. Saying
      // "unhandled" here would be affirmatively false in exactly the case the
      // container-parity test drives. §C.5.4 accepted that the opaque
      // `child_failed:<id>` reason string no longer implies "had no handler";
      // it did not sanction a diagnostic that states it in prose.
      const blamed = containerOutcomeFailure(c, state);
      if (blamed !== null) {
        diagnostics.push(`container '${cid}' failed: child '${blamed}' failed`);
        return {
          state: exitContainer(state, c, 'failure', `child_failed:${blamed}`),
          changed: true,
        };
      }
      if (c.kind === 'stage') {
        return { state: exitContainer(state, c, 'success'), changed: true };
      }
      // loop
      let exit: boolean;
      try {
        exit = evalExitWhen(c, state);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        diagnostics.push(`container '${cid}' exitWhen failed: ${msg}`);
        return { state: exitContainer(state, c, 'failure', 'exitWhen_error'), changed: true };
      }
      if (exit) return { state: exitContainer(state, c, 'success'), changed: true };
      if (c.maxRounds !== undefined && cs.round + 1 >= c.maxRounds) {
        diagnostics.push(`container '${cid}' capped at maxRounds=${c.maxRounds}`);
        return { state: exitContainer(state, c, 'failure', 'capped'), changed: true };
      }
      return { state: resetContainerRound(state, c), changed: true };
    }
    return { state, changed: false };
  }

  /**
   * Evaluate a loop's `exitWhen` (`${}` boolean) over the round's child outputs.
   *
   * `exitWhen` is a whole-value-REQUIRED field (#6 E2 / spec #6 Round-2 I1): the
   * canonical TRIM decides the mode, so a stray space or newline cannot demote
   * the boolean to a string. An embedded expression is refused outright — it can
   * only ever resolve to a string, so the loop would never see `true` and would
   * silently burn every round before reporting the misleading reason `capped`.
   * Throwing here surfaces it as `exitWhen_error` on the very first round.
   *
   * This is the enforcement point that BINDS: `validateDoc`'s whole-value rule is
   * advisory (its only caller is the canvas badge, which does not block Save, and
   * the server never calls it), so a git import or a direct POST reaches the
   * engine unchecked. Pure + replay-safe: trim/classify are deterministic on the
   * doc, so a replay of the same log reaches the same verdict.
   */
  function evalExitWhen(c: Container, state: RunState): boolean {
    if (c.exitWhen === undefined) return false;
    const src = c.exitWhen.trim();
    // `wholeValueDefect` is the SSOT the save-time half reads too, so the two can
    // never judge or word the rule differently. It returns null for an
    // unterminated `${` — that falls through so `substitute` raises its own
    // precise grammar error rather than being mislabelled a mode defect.
    const defect = wholeValueDefect(src, 'exitWhen');
    if (defect !== null) throw new SubstituteError(defect);
    const out = substitute(src, buildCtx(state));
    if (typeof out === 'boolean') return out;
    // #6 E6 — the RUN-TIME half of the boolean-condition rule, landing with the
    // save-time check (`validateExitWhen`) that warns the author first.
    //
    // This used to coerce (`return out === 'true'`), which made a `string`-typed
    // "true" work by accident while the SAME activity emitting "yes" — or the
    // padded " true" — burned every round and reported the misleading `capped`.
    // A value that only worked by accident now says so, and says it on round 0.
    //
    // The save-time half cannot close this alone: `validateDoc` is advisory (its
    // only caller is the canvas badge; the server never calls it — #444), so a
    // git import or a direct POST reaches this reducer unchecked. Same
    // both-halves rule E2 set for the MODE check, for the same reason.
    throw new SubstituteError(
      `exitWhen must resolve to a boolean, got ${typeof out} — ` +
        "compare it explicitly (e.g. ${equals(nodes.check.output.done, 'true')})",
    );
  }

  /** A container's projected outputs = its children's outputs merged (sorted). */
  function projectContainerOutputs(c: Container, state: RunState): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const ch of [...c.children].sort()) {
      const co = state.outputs[ch];
      if (co !== undefined) for (const k of Object.keys(co).sort()) out[k] = co[k];
    }
    return out;
  }

  /**
   * Terminate a container: set status + project outputs (also into `outputs`).
   * `reason` (observability) records WHY it terminated on a failure — `capped`
   * (loop hit maxRounds), `child_failed:<id>` (unhandled child failure), or
   * `exitWhen_error` (the exit expression threw). Omitted on a clean success.
   */
  function exitContainer(
    state: RunState,
    c: Container,
    outcome: 'success' | 'failure',
    reason?: string,
  ): RunState {
    const outputs = projectContainerOutputs(c, state);
    const cs = state.containers[c.id]!;
    const nextCs: ContainerRunState =
      reason !== undefined
        ? { ...cs, status: outcome, outputs, reason }
        : { ...cs, status: outcome, outputs };
    let next: RunState = {
      ...state,
      containers: { ...state.containers, [c.id]: nextCs },
    };
    // Expose the container's outputs to `${nodes.<container>.output.<name>}`.
    next = { ...next, outputs: { ...next.outputs, [c.id]: outputs } };
    return next;
  }

  /** Reset a loop container's children for a new round (attempts kept monotonic). */
  function resetContainerRound(state: RunState, c: Container): RunState {
    const cs = state.containers[c.id]!;
    let next = resetNodes(state, c.children);
    next = {
      ...next,
      containers: { ...next.containers, [c.id]: { ...cs, round: cs.round + 1 } },
    };
    return next;
  }

  /** Enter a container: mark it `active` (its root children become ready). */
  function enterContainer(state: RunState, cid: string): RunState {
    const cs = state.containers[cid]!;
    return { ...state, containers: { ...state.containers, [cid]: { ...cs, status: 'active' } } };
  }

  /**
   * Reset a set of nodes to `pending` and CLEAR their `outputs` (a fresh loop
   * round recomputes them). `attempts` is kept MONOTONIC so a fresh dispatch
   * mints a NEW attemptId — a stale result from the prior round can never fold.
   */
  function resetNodes(state: RunState, ids: string[]): RunState {
    let nodes = state.nodes;
    let outputs = state.outputs;
    let touched = false;
    for (const id of ids) {
      const ns = nodes[id];
      if (ns === undefined) continue;
      if (nodes === state.nodes) nodes = { ...nodes };
      nodes[id] = { ...ns, status: 'pending', currentAttemptId: undefined };
      if (Object.prototype.hasOwnProperty.call(outputs, id)) {
        if (outputs === state.outputs) outputs = { ...outputs };
        delete outputs[id];
      }
      touched = true;
    }
    return touched ? { ...state, nodes, outputs } : state;
  }

  /**
   * Re-evaluate readiness to a fixpoint. Each pass, in order: fire a satisfied
   * back-edge (a loop iteration); advance an active container (exit/re-round);
   * then dispatch/skip/enter all newly-ready top-level entities and
   * active-container children in STABLE order. When every top-level entity is
   * terminal, `runOutcomeFailure` decides the run's outcome.
   *
   * F1b DRAINS: there is no longer an eager short-circuit on the first unhandled
   * top-level failure. The walk always runs to completion and the outcome is
   * evaluated once, at the fixpoint. That is what makes ADF's "Generic error
   * handling" pattern work at all (the handler a skip-taint reaches used to stay
   * `pending` forever — #442's core complaint), and it is what makes the outcome
   * evaluable: the verdict genuinely depends on how far the walk drained.
   *
   * **The cost is real and is accepted knowingly, not overlooked.** An
   * already-doomed run now dispatches every independent branch to completion —
   * strictly more work than the short-circuit did. ADF does exactly this, but
   * ADF activities are not billed per token and studio's are (its nodes are LLM
   * calls and HTTP posts), so drain costs real money and real side effects on
   * runs already known to be doomed. It cannot be optimised back: under the
   * settled predicate the outcome DEPENDS on draining, so an eager exit would
   * change the answer, not just the cost. An operator seeing spend on a doomed
   * run should find this paragraph.
   */
  function settle(startState: RunState, diagnostics: string[]): ReduceResult {
    let state = startState;
    const commands: EngineCommand[] = [];

    for (;;) {
      const fired = fireBackEdges(state, diagnostics);
      if (fired.finish) return { state: fired.state, commands: [fired.finish], diagnostics };
      if (fired.changed) {
        state = fired.state;
        continue;
      }

      const stepped = stepContainers(state, diagnostics);
      if (stepped.finish) return { state: stepped.state, commands: [stepped.finish], diagnostics };
      if (stepped.changed) {
        state = stepped.state;
        continue;
      }

      let changed = false;
      for (const id of sortedTopEntities) {
        if (containerById.has(id)) {
          const cs = state.containers[id]!;
          if (cs.status !== 'pending') continue;
          const r = computeReadiness(
            topIncoming.get(id)!,
            containerJoin(containerById.get(id)!),
            state,
          );
          if (r === 'ready') {
            state = enterContainer(state, id);
            changed = true;
          } else if (r === 'skipped') {
            noteInertBranch(id, topIncoming.get(id)!, diagnostics);
            state = withContainer(state, id, { status: 'skipped' });
            changed = true;
          }
          continue;
        }
        const step = tryDispatchNode(state, id, topIncoming.get(id)!, commands, diagnostics);
        if (step.finish) return { state: step.state, commands: [step.finish], diagnostics };
        if (step.changed) {
          state = step.state;
          changed = true;
        }
      }

      for (const cid of [...containerIds].sort()) {
        if (state.containers[cid]!.status !== 'active') continue;
        for (const ch of [...containerById.get(cid)!.children].sort()) {
          const step = tryDispatchNode(state, ch, childIncoming.get(ch)!, commands, diagnostics);
          if (step.finish) return { state: step.state, commands: [step.finish], diagnostics };
          if (step.changed) {
            state = step.state;
            changed = true;
          }
        }
      }

      if (!changed) break;
    }

    if (allTopLevelTerminal(state)) {
      const blamed = runOutcomeFailure(state);
      commands.push(
        blamed === null
          ? { type: 'finishRun', outcome: 'success' }
          : { type: 'finishRun', outcome: 'failure', reason: `node_failed:${blamed}` },
      );
    }
    return { state, commands, diagnostics };
  }

  // --- per-event reducers ---------------------------------------------------

  function onRunStarted(
    state: RunState,
    event: Extract<EngineEvent, { type: 'run.started' }>,
    diagnostics: string[],
  ): ReduceResult {
    if (state.status !== 'pending') {
      if (event.runId === state.runId) {
        diagnostics.push('impossible run.started: this run has already started');
      }
      return { state, commands: [], diagnostics };
    }
    const nodes: Record<string, NodeRunState> = {};
    for (const id of nodeIds) nodes[id] = { status: 'pending', attempts: 0 };
    const containerStates: Record<string, ContainerRunState> = {};
    for (const c of containers)
      containerStates[c.id] = { status: 'pending', round: 0, outputs: {} };
    const started: RunState = {
      runId: event.runId,
      pipelineVersionId: event.pipelineVersionId,
      // The fact, verbatim from the log — never a clock read. `undefined` (a log
      // appended before E3 carried the stamp) folds to `null`, so replay of an
      // old run stays deterministic instead of throwing.
      startedAt: event.startedAt ?? null,
      params: { ...event.params },
      status: 'running',
      nodes,
      outputs: {},
      containers: containerStates,
      bounces: {},
      sessions: {},
    };
    return settle(started, diagnostics);
  }

  function onDispatched(
    state: RunState,
    event: Extract<EngineEvent, { type: 'node.dispatched' }>,
    diagnostics: string[],
  ): ReduceResult {
    const ns = state.nodes[event.nodeId];
    if (ns === undefined) return { state, commands: [], diagnostics };
    if (ns.currentAttemptId === undefined) {
      diagnostics.push(
        `impossible node.dispatched for node '${event.nodeId}' in status '${ns.status}' (no current attempt)`,
      );
      return { state, commands: [], diagnostics };
    }
    if (event.attemptId !== ns.currentAttemptId) {
      return { state, commands: [], diagnostics };
    }
    if (ns.status === 'ready') {
      return {
        state: withNode(state, event.nodeId, { status: 'dispatched' }),
        commands: [],
        diagnostics,
      };
    }
    if (ns.status === 'dispatched') {
      return { state, commands: [], diagnostics };
    }
    diagnostics.push(
      `impossible node.dispatched for node '${event.nodeId}' in status '${ns.status}'`,
    );
    return { state, commands: [], diagnostics };
  }

  function onSucceeded(
    state: RunState,
    event: Extract<EngineEvent, { type: 'node.succeeded' }>,
    diagnostics: string[],
  ): ReduceResult {
    const ns = state.nodes[event.nodeId];
    if (ns === undefined) return { state, commands: [], diagnostics };
    if (LIVE_NODE.has(ns.status)) {
      if (event.attemptId !== ns.currentAttemptId) {
        return { state, commands: [], diagnostics };
      }
      const node = nodeById.get(event.nodeId)!;
      const { errs, checked } = validateOutputs(outputContract(node), event.outputs);
      if (checked === null || errs.length > 0) {
        // `checked === null` ⇒ a corrupt CONFIG, not a bad result: say so rather
        // than blaming the node for producing what its author mis-declared.
        diagnostics.push(
          checked === null
            ? `node '${event.nodeId}' has invalid config: ${errs.join('; ')}`
            : `node '${event.nodeId}' produced invalid outputs: ${errs.join('; ')}`,
        );
        return settle(withNode(state, event.nodeId, { status: 'failure' }), diagnostics);
      }
      const stored = storeOutputs(checked, event.outputs);
      let next = withNode(state, event.nodeId, { status: 'success' });
      next = { ...next, outputs: { ...next.outputs, [event.nodeId]: stored } };
      return settle(next, diagnostics);
    }
    if (ns.status === 'pending') {
      diagnostics.push(`impossible node.succeeded for never-dispatched node '${event.nodeId}'`);
      return {
        state,
        commands: [{ type: 'finishRun', outcome: 'failure', reason: 'invalid_event' }],
        diagnostics,
      };
    }
    if (event.attemptId !== ns.currentAttemptId) {
      return { state, commands: [], diagnostics };
    }
    diagnostics.push(`duplicate node.succeeded for already-terminal node '${event.nodeId}'`);
    return { state, commands: [], diagnostics };
  }

  function onFailed(
    state: RunState,
    event: Extract<EngineEvent, { type: 'node.failed' }>,
    diagnostics: string[],
  ): ReduceResult {
    const ns = state.nodes[event.nodeId];
    if (ns === undefined) return { state, commands: [], diagnostics };
    if (LIVE_NODE.has(ns.status)) {
      if (event.attemptId !== ns.currentAttemptId) {
        return { state, commands: [], diagnostics };
      }
      return settle(withNode(state, event.nodeId, { status: 'failure' }), diagnostics);
    }
    if (ns.status === 'pending') {
      diagnostics.push(`impossible node.failed for never-dispatched node '${event.nodeId}'`);
      return {
        state,
        commands: [{ type: 'finishRun', outcome: 'failure', reason: 'invalid_event' }],
        diagnostics,
      };
    }
    if (event.attemptId !== ns.currentAttemptId) {
      return { state, commands: [], diagnostics };
    }
    if (ns.status === 'success') {
      diagnostics.push(
        `contradiction: node.failed for node '${event.nodeId}' names the same attempt that already succeeded`,
      );
      return { state, commands: [], diagnostics };
    }
    diagnostics.push(`duplicate node.failed for already-terminal node '${event.nodeId}'`);
    return { state, commands: [], diagnostics };
  }

  /**
   * `call.returned` (P2c): resolve a `waiting` `call_pipeline` node. A FAILED
   * child STILL returns projected `outputs` — record them either way (the
   * findings loop) and route the node's terminal outcome from `childOutcome`. A
   * `call.returned` whose `attemptId` is not the node's current attempt is a
   * stale pre-restart child result → ignored.
   */
  function onCallReturned(
    state: RunState,
    event: Extract<EngineEvent, { type: 'call.returned' }>,
    diagnostics: string[],
  ): ReduceResult {
    const ns = state.nodes[event.callNodeId];
    if (ns === undefined) return { state, commands: [], diagnostics };
    if (ns.status === 'waiting') {
      if (event.attemptId !== ns.currentAttemptId) {
        return { state, commands: [], diagnostics }; // STALE child result → ignored
      }
      // Verify the child identity too: an event naming the CURRENT attempt but a
      // DIFFERENT childRunId (a foreign/misrouted child) must NOT terminalize the
      // call node or store its outputs. The expected id is the same deterministic
      // hash the reducer emitted in `startChild`, so this is a pure re-derivation.
      const expectedChildRunId = deterministicChildRunId(
        state.runId,
        event.callNodeId,
        event.attemptId,
      );
      if (event.childRunId !== expectedChildRunId) {
        diagnostics.push(
          `call.returned for '${event.callNodeId}' names an unexpected childRunId ` +
            `'${event.childRunId}' (expected '${expectedChildRunId}') — ignored`,
        );
        return { state, commands: [], diagnostics };
      }
      const node = nodeById.get(event.callNodeId)!;
      // Validate declared outputs on BOTH outcomes. A FAILED child still returns
      // projected outputs (the findings loop) — but they flow into `state.outputs`
      // and thus into `${}` substitution, so mistyped outputs must never be stored
      // regardless of outcome. On any type violation the node terminalizes as
      // `failure` with NO stored outputs (on success this is the existing
      // fail-the-node behavior; on failure it drops the mistyped payload).
      const { errs, checked } = validateOutputs(outputContract(node), event.outputs);
      if (checked === null || errs.length > 0) {
        // A corrupt contract is THIS call node's own config defect — never
        // report it as the child pipeline returning something wrong.
        diagnostics.push(
          checked === null
            ? `call node '${event.callNodeId}' has invalid config: ${errs.join('; ')}`
            : `call node '${event.callNodeId}' child returned invalid outputs: ${errs.join('; ')}`,
        );
        return settle(withNode(state, event.callNodeId, { status: 'failure' }), diagnostics);
      }
      const stored = storeOutputs(checked, event.outputs);
      let next = withNode(state, event.callNodeId, { status: event.childOutcome });
      next = { ...next, outputs: { ...next.outputs, [event.callNodeId]: stored } };
      return settle(next, diagnostics);
    }
    if (ns.status === 'pending') {
      diagnostics.push(
        `impossible call.returned for never-dispatched call node '${event.callNodeId}'`,
      );
      return {
        state,
        commands: [{ type: 'finishRun', outcome: 'failure', reason: 'invalid_event' }],
        diagnostics,
      };
    }
    if (event.attemptId !== ns.currentAttemptId) {
      return { state, commands: [], diagnostics };
    }
    diagnostics.push(
      `duplicate call.returned for already-terminal call node '${event.callNodeId}'`,
    );
    return { state, commands: [], diagnostics };
  }

  function onRetryRequested(
    state: RunState,
    event: Extract<EngineEvent, { type: 'node.retryRequested' }>,
    diagnostics: string[],
  ): ReduceResult {
    const ns = state.nodes[event.nodeId];
    if (ns === undefined) return { state, commands: [], diagnostics };
    if (!LIVE_NODE.has(ns.status)) {
      diagnostics.push(
        `impossible node.retryRequested for node '${event.nodeId}' in status '${ns.status}' (not dispatched/ready)`,
      );
      return { state, commands: [], diagnostics };
    }
    if (event.previousAttemptId !== ns.currentAttemptId) {
      return { state, commands: [], diagnostics };
    }
    const attemptId = `${event.nodeId}#${ns.attempts}`;
    let next = withNode(state, event.nodeId, {
      status: 'ready',
      attempts: ns.attempts + 1,
      currentAttemptId: attemptId,
    });
    if (Object.prototype.hasOwnProperty.call(next.outputs, event.nodeId)) {
      const outputs = { ...next.outputs };
      delete outputs[event.nodeId];
      next = { ...next, outputs };
    }
    let prepared: Record<string, unknown>;
    try {
      prepared = prepInput(next, nodeById.get(event.nodeId)!);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      diagnostics.push(`dispatch prep failed for node '${event.nodeId}': ${msg}`);
      return {
        state: next,
        commands: [{ type: 'finishRun', outcome: 'failure', reason: 'invalid_event' }],
        diagnostics,
      };
    }
    return {
      state: next,
      commands: [
        { type: 'dispatchNode', nodeId: event.nodeId, attemptId, preparedInput: prepared },
      ],
      diagnostics,
    };
  }

  /**
   * `run.resumed` (boot reconcile): re-derive every COMMAND the reducer had
   * already decided but whose driver-side effect never landed before the crash.
   * Two mechanisms, because a crash can drop TWO kinds of ephemeral command:
   *
   * 1. A node whose command was emitted but its accepting event never persisted:
   *    - a `ready` node → re-emit `dispatchNode` (the driver never accepted it).
   *    - a `waiting` call node → re-emit `startChild`. A crash between emitting
   *      `startChild` and the child being created leaves the node stuck
   *      `waiting` forever otherwise; the DETERMINISTIC `childRunId` makes the
   *      re-emit idempotent (the driver's child creation keys on it).
   *    Both re-emits carry the node's EXISTING `currentAttemptId` (no new
   *    attempt), so a duplicate late event from the original try is stale-
   *    rejected. `settle` (below) CANNOT re-derive these — those nodes are no
   *    longer `pending`, so its readiness walk skips them.
   *
   * 2. The walk's own ephemeral output — re-run `settle`. Its `finishRun` /
   *    dispatch commands live only in the reducer's return value, so a crash
   *    between a node's terminal event and the `run.finished` the driver was
   *    about to append DROPS the `finishRun`: the log ends at `node.succeeded`
   *    with no terminal fact, and the projection is stuck `running` with no
   *    live node for mechanism (1) to recover. Re-running `settle` regenerates
   *    that `finishRun` (and dispatches any genuinely-pending newly-ready node,
   *    and re-fires the unhandled-failure short-circuit), so the reconciler can
   *    finalize the run. `settle` skips the `ready`/`waiting`/`dispatched` nodes
   *    handled above, so the two mechanisms never emit for the same node.
   */
  function onResumed(state: RunState, diagnostics: string[]): ReduceResult {
    const commands: EngineCommand[] = [];
    for (const id of [...nodeIds].sort()) {
      const ns = state.nodes[id]!;
      if (ns.currentAttemptId === undefined) continue;
      const node = nodeById.get(id)!;
      if (ns.status === 'ready') {
        let prepared: Record<string, unknown>;
        try {
          prepared = prepInput(state, node);
        } catch {
          continue;
        }
        commands.push({
          type: 'dispatchNode',
          nodeId: id,
          attemptId: ns.currentAttemptId,
          preparedInput: prepared,
        });
      } else if (ns.status === 'waiting' && node.call !== undefined) {
        let pvId: string;
        let callParams: Record<string, unknown>;
        try {
          const ctx = buildCtx(state);
          pvId = String(substitute(node.call.pipelineVersionId, ctx));
          callParams = substitute(node.call.params, ctx) as Record<string, unknown>;
        } catch {
          continue;
        }
        commands.push({
          type: 'startChild',
          callNodeId: id,
          attemptId: ns.currentAttemptId,
          childRunId: deterministicChildRunId(state.runId, id, ns.currentAttemptId),
          pipelineVersionId: pvId,
          params: callParams,
        });
      }
    }
    const settled = settle(state, diagnostics);
    return { state: settled.state, commands: [...commands, ...settled.commands], diagnostics };
  }

  // --- the pure reducer (the exact 2-arg contract) --------------------------

  function reduce(state: RunState, event: EngineEvent): ReduceResult {
    const diagnostics: string[] = [];

    if (event.type === 'run.started') return onRunStarted(state, event, diagnostics);

    if (state.status === 'pending') return { state, commands: [], diagnostics };

    if (event.runId !== state.runId) return { state, commands: [], diagnostics };

    if (state.status !== 'running') {
      // A terminal-transition event (`run.finished`/`run.interrupted`) arriving
      // on an already-terminal run is a benign no-op, not a malformed log, so it
      // earns no diagnostic. `terminalStatusOf` is the SSOT for that set (#443) —
      // the log-authoritative reconciler reads the same one.
      if (terminalStatusOf(event) === null) {
        diagnostics.push(`event '${event.type}' on a '${state.status}' run is ignored`);
      }
      return { state, commands: [], diagnostics };
    }

    switch (event.type) {
      case 'run.finished': {
        // Routed through the SAME `runOutcomeFailure` as `settle` (§B.2). This
        // is an SSOT requirement, not a style preference: these two sites answer
        // the identical question ("is this run's outcome success?"), and a
        // divergence between them is a latent `invalid_event` — `settle` would
        // emit `finishRun{success}`, the driver would append `run.finished`, and
        // the reducer would then call its own event impossible and strand the
        // run at `status:'running'` (which `reconcile` re-drives). Measured, not
        // theorised: changing one site alone reproduces exactly that.
        if (
          event.outcome === 'success' &&
          !(allTopLevelTerminal(state) && runOutcomeFailure(state) === null)
        ) {
          diagnostics.push(
            `impossible run.finished{success}: the run has a live/pending node or an unhandled failure`,
          );
          return {
            state,
            commands: [{ type: 'finishRun', outcome: 'failure', reason: 'invalid_event' }],
            diagnostics,
          };
        }
        return { state: { ...state, status: event.outcome }, commands: [], diagnostics };
      }
      case 'node.output':
        return { state, commands: [], diagnostics };
      case 'node.dispatched':
        return onDispatched(state, event, diagnostics);
      case 'node.succeeded':
        return onSucceeded(state, event, diagnostics);
      case 'node.failed':
        return onFailed(state, event, diagnostics);
      case 'call.returned':
        return onCallReturned(state, event, diagnostics);
      case 'node.retryRequested':
        return onRetryRequested(state, event, diagnostics);
      case 'run.resumed':
        return onResumed(state, diagnostics);
      case 'run.interrupted':
        // Terminal: the boot reconciler froze a run whose non-idempotent node
        // was in flight at crash time. No command — the run stops here (the
        // in-flight node stays `dispatched`/needs-attention); an operator
        // decides what to do next. See the event's doc in `types.ts`.
        return { state: { ...state, status: 'interrupted' }, commands: [], diagnostics };
    }
  }

  function seedState(): RunState {
    return {
      runId: '',
      pipelineVersionId: '',
      startedAt: null,
      params: {},
      status: 'pending',
      nodes: {},
      outputs: {},
      containers: {},
      bounces: {},
      sessions: {},
    };
  }

  function projectRunState(events: EngineEvent[]): RunState {
    let state = seedState();
    for (const event of events) state = reduce(state, event).state;
    return state;
  }

  return { seedState, reduce, projectRunState };
}

// --- shared pure helpers (no closure needed) --------------------------------

/** Immutable single-node patch: returns a new state, never mutates the input. */
function withNode(state: RunState, id: string, patch: Partial<NodeRunState>): RunState {
  const prev = state.nodes[id]!;
  return { ...state, nodes: { ...state.nodes, [id]: { ...prev, ...patch } } };
}

/** Immutable single-container patch. */
function withContainer(state: RunState, id: string, patch: Partial<ContainerRunState>): RunState {
  const prev = state.containers[id]!;
  return { ...state, containers: { ...state.containers, [id]: { ...prev, ...patch } } };
}

/** A container's join rule over its OUTER incoming edges (default `all`). */
function containerJoin(c: Container): 'all' | 'any' {
  return c.join === 'any' ? 'any' : 'all';
}

/** Stable string compare (avoids locale-dependent default sort semantics). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A DETERMINISTIC child run id from (parent runId, callNodeId, attemptId) — a
 * pure 128-bit FNV-1a hash, so a crash-replay re-emits the SAME `startChild` and
 * child creation is idempotent. No clock/random.
 *
 * The width matters: `childRunId` is not just an idempotency key — `onCallReturned`
 * VERIFIES a `call.returned` event's child identity against the re-derived id, so
 * a collision would let a foreign child terminalize the wrong call node. A 32-bit
 * hash is birthday-vulnerable at ~2^16 triples; 128 bits makes a collision
 * negligible across any realistic run/attempt volume.
 */
function deterministicChildRunId(runId: string, callNodeId: string, attemptId: string): string {
  return `child_${fnv1a128(`${runId}\x00${callNodeId}\x00${attemptId}`)}`;
}

// FNV-1a 128-bit (BigInt) — the standard parameters. Pure; no clock/random.
const FNV128_OFFSET = 0x6c62272e07bb014262b821756295c58dn;
const FNV128_PRIME = 0x0000000001000000000000000000013bn;
const FNV128_MASK = (1n << 128n) - 1n;

/** FNV-1a 128-bit hash → 32-hex. Pure. */
function fnv1a128(s: string): string {
  let h = FNV128_OFFSET;
  for (let i = 0; i < s.length; i += 1) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV128_PRIME) & FNV128_MASK;
  }
  return h.toString(16).padStart(32, '0');
}

/**
 * Store ONLY a node's DECLARED output keys, dropping anything else the executor
 * carried (an undeclared key must never become refable). A node with no
 * declared outputs has no contract to enforce → its whole payload passes.
 *
 * Takes a `CheckedContract`, so an `invalid` one cannot reach the
 * whole-payload branch: `validateOutputs` errors first and terminalizes the
 * node. That is a TYPE guarantee rather than a comment — see `CheckedContract`.
 */
function storeOutputs(
  contract: CheckedContract,
  outputs: Record<string, unknown>,
): Record<string, unknown> {
  return contract.kind === 'declared'
    ? Object.fromEntries(contract.outputs.map((d) => [d.name, outputs[d.name]]))
    : { ...outputs };
}

/**
 * Validate a result's outputs against the node's output contract. A missing or
 * mistyped declared output is an error. `absent` (no contract) → trivially
 * valid. `invalid` (a CORRUPT contract) → an error, never "no contract": see
 * `OutputContract` for why conflating those two fails open (#1 F13a).
 *
 * NARROWS on success: a `null` return means the contract is `CheckedContract`,
 * which is what lets `storeOutputs` refuse an `invalid` one at the type level.
 */
function validateOutputs(
  contract: OutputContract,
  outputs: Record<string, unknown>,
): { errs: string[]; checked: CheckedContract | null } {
  // A corrupt contract is a CONFIG defect, not a bad result — the node produced
  // nothing wrong. Worded to match `validateDoc`'s `config.outputs is
  // malformed` so both paths are greppable together, and kept distinct from the
  // caller's "produced invalid outputs" framing (which would blame the node, or
  // on the call path the CHILD PIPELINE, for the author's typo).
  if (contract.kind === 'invalid') {
    return { errs: [`config.outputs is malformed (${contract.reason})`], checked: null };
  }
  if (contract.kind === 'absent') return { errs: [], checked: contract };
  const errs: string[] = [];
  for (const d of contract.outputs) {
    if (!Object.prototype.hasOwnProperty.call(outputs, d.name)) {
      errs.push(`missing declared output '${d.name}'`);
      continue;
    }
    if (!matchesType(outputs[d.name], d.type)) {
      errs.push(`output '${d.name}' is not of declared type '${d.type}'`);
    }
  }
  return { errs, checked: contract };
}

function matchesType(value: unknown, type: OutputType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    // FINITE, not merely `!isNaN` (#6 E6). `number` means finite everywhere else
    // in this engine (`matchesSig` enforces it on every fn arg), and E6 types
    // `${nodes.x.output.n}` from this very declaration — so admitting `Infinity`
    // here would seed an output that fails its own type check downstream.
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'json':
      return true;
  }
}
