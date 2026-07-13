import { z } from 'zod';
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
} from './types.js';
import { OutputSchema } from '../schemas/pipeline.js';
import type { OutputType } from '../schemas/pipeline.js';
import {
  backEdgeResetBody,
  effectiveEdges,
  forwardDescendants,
  nodeForwardAdjacency,
  substitute,
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

const TERMINAL_NODE = new Set<NodeRunState['status']>(['success', 'failure', 'skipped']);
const LIVE_NODE = new Set<NodeRunState['status']>(['ready', 'dispatched']);

/**
 * A defensive hard cap on back-edge traversals used ONLY when a back-edge has no
 * `maxBounces` (which `validateDoc` requires — this bounds any doc that bypassed
 * validation, e.g. constructed directly via `createEngine`, so a no-progress
 * body can never spin forever). A validated doc always hits its own smaller cap.
 */
const DEFENSIVE_BOUNCE_CAP = 10_000;

/** Per-incoming-edge state for a successor's readiness (the CP1 truth table). */
type EdgeState = 'satisfied' | 'unsatisfied-terminal' | 'pending' | 'impossible';

/** A node's computed readiness given its incoming edges' states + join rule. */
type Readiness = 'ready' | 'skipped' | 'pending';

/** A terminal outcome for an endpoint (node OR container), or `null` if live. */
type EndpointOutcome = 'success' | 'failure' | 'skipped' | null;

/**
 * A STABLE key for an edge, from (from, to, on) — NOT an array index — so a
 * doc save/reorder never changes which `bounces[...]` counter a back-edge maps
 * to (CP1). `\x00` is a delimiter that cannot occur in an id/enum.
 */
function stableEdgeKey(e: Edge): string {
  return `${e.from}\x00${e.to}\x00${e.on}`;
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

  // Back-edges by source endpoint (for "is this failure handled?" and firing).
  const backOutgoing = new Map<string, Edge[]>();
  for (const e of backEdges) {
    if (!backOutgoing.has(e.from)) backOutgoing.set(e.from, []);
    backOutgoing.get(e.from)!.push(e);
  }

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
    if (oc === 'skipped') return 'impossible';
    if (oc === 'success') {
      return edge.on === 'success' || edge.on === 'completion'
        ? 'satisfied'
        : 'unsatisfied-terminal';
    }
    // failure
    return edge.on === 'failure' || edge.on === 'completion' ? 'satisfied' : 'unsatisfied-terminal';
  }

  /**
   * The CP1 join truth table over an entity's incoming edges. No incoming edge
   * → a root (ready). `dead` = `impossible` ∪ `unsatisfied-terminal` (an edge
   * that can never satisfy). `all` → ready iff every edge satisfied, skipped iff
   * any dead, else pending. `any` → ready iff ≥1 satisfied, skipped iff all
   * dead, else pending.
   */
  function computeReadiness(incoming: Edge[], join: 'all' | 'any', state: RunState): Readiness {
    if (incoming.length === 0) return 'ready';
    const states = incoming.map((e) => edgeState(e, state));
    const dead = (s: EdgeState): boolean => s === 'impossible' || s === 'unsatisfied-terminal';
    if (join === 'all') {
      if (states.every((s) => s === 'satisfied')) return 'ready';
      if (states.some(dead)) return 'skipped';
      return 'pending';
    }
    if (states.some((s) => s === 'satisfied')) return 'ready';
    if (states.every(dead)) return 'skipped';
    return 'pending';
  }

  /**
   * The first TOP-LEVEL entity (node or container) that is `failure` with no
   * outgoing `failure`/`completion` edge (forward OR back) — an unhandled
   * failure that fails the whole run. A child's failure is NOT scanned here; it
   * is caught (or not) inside its container.
   */
  function firstUnhandledFailureTop(state: RunState): string | null {
    for (const id of sortedTopEntities) {
      if (endpointOutcome(id, state) !== 'failure') continue;
      const outs = [...(topOutgoing.get(id) ?? []), ...(backOutgoing.get(id) ?? [])];
      const handled = outs.some((e) => e.on === 'failure' || e.on === 'completion');
      if (!handled) return id;
    }
    return null;
  }

  /**
   * The first child of `c` that is `failure` with no INTERNAL outgoing
   * `failure`/`completion` edge — an unhandled child failure that fails the
   * CONTAINER (not the run). A child `skipped` never fails the container.
   */
  function firstUnhandledChildFailure(c: Container, state: RunState): string | null {
    for (const ch of [...c.children].sort()) {
      if (state.nodes[ch]?.status !== 'failure') continue;
      const outs = childOutgoing.get(ch) ?? [];
      const handled = outs.some((e) => e.on === 'failure' || e.on === 'completion');
      if (!handled) return ch;
    }
    return null;
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
   */
  function buildCtx(state: RunState): SubstitutionContext {
    return {
      params: state.params,
      nodeOutputs: state.outputs,
      run: {
        id: state.runId,
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
    if (r === 'skipped')
      return { state: withNode(state, id, { status: 'skipped' }), changed: true };
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
  function fireBackEdges(state: RunState): Step {
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
      // maxBounces is REQUIRED by validateDoc; the defensive fallback bounds any
      // unvalidated doc so a no-progress body can never spin forever.
      const cap = be.maxBounces ?? DEFENSIVE_BOUNCE_CAP;
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

      const unhandled = firstUnhandledChildFailure(c, state);
      if (unhandled !== null) {
        diagnostics.push(`container '${cid}' failed: unhandled child failure '${unhandled}'`);
        return {
          state: exitContainer(state, c, 'failure', `child_failed:${unhandled}`),
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

  /** Evaluate a loop's `exitWhen` (`${}` boolean) over the round's child outputs. */
  function evalExitWhen(c: Container, state: RunState): boolean {
    if (c.exitWhen === undefined) return false;
    const out = substitute(c.exitWhen, buildCtx(state));
    if (typeof out === 'boolean') return out;
    // A whole-string ref preserves native type; anything else is truthy-coerced
    // conservatively: only an explicit `true`/'true' exits.
    return out === 'true';
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
   * short-circuit on a top-level unhandled failure; then dispatch/skip/enter all
   * newly-ready top-level entities and active-container children in STABLE
   * order. When every top-level entity is terminal, emit `finishRun{success}`.
   */
  function settle(startState: RunState, diagnostics: string[]): ReduceResult {
    let state = startState;
    const commands: EngineCommand[] = [];

    for (;;) {
      const fired = fireBackEdges(state);
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

      const failed = firstUnhandledFailureTop(state);
      if (failed !== null) {
        return {
          state,
          commands: [{ type: 'finishRun', outcome: 'failure', reason: `node_failed:${failed}` }],
          diagnostics,
        };
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
      commands.push({ type: 'finishRun', outcome: 'success' });
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
      const decl = declaredOutputs(node);
      const errs = validateOutputs(decl, event.outputs);
      if (errs.length > 0) {
        diagnostics.push(`node '${event.nodeId}' produced invalid outputs: ${errs.join('; ')}`);
        return settle(withNode(state, event.nodeId, { status: 'failure' }), diagnostics);
      }
      const stored = storeOutputs(decl, event.outputs);
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
      const decl = declaredOutputs(node);
      // Validate declared outputs on BOTH outcomes. A FAILED child still returns
      // projected outputs (the findings loop) — but they flow into `state.outputs`
      // and thus into `${}` substitution, so mistyped outputs must never be stored
      // regardless of outcome. On any type violation the node terminalizes as
      // `failure` with NO stored outputs (on success this is the existing
      // fail-the-node behavior; on failure it drops the mistyped payload).
      const errs = validateOutputs(decl, event.outputs);
      if (errs.length > 0) {
        diagnostics.push(
          `call node '${event.callNodeId}' child returned invalid outputs: ${errs.join('; ')}`,
        );
        return settle(withNode(state, event.callNodeId, { status: 'failure' }), diagnostics);
      }
      const stored = storeOutputs(decl, event.outputs);
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
   * `run.resumed` (boot reconcile): re-emit the pending COMMAND for every node
   * the reducer had already decided but whose driver-side event never landed
   * before the crash. Two cases:
   *   - a `ready` node → re-emit `dispatchNode` (the driver never accepted it).
   *   - a `waiting` call node → re-emit `startChild`. A crash between emitting
   *     `startChild` and the child actually being created leaves the node stuck
   *     `waiting` forever otherwise; the DETERMINISTIC `childRunId` makes the
   *     re-emit idempotent (the driver's child creation keys on it).
   * Both re-emits carry the node's EXISTING `currentAttemptId` (no new attempt),
   * so a duplicate late event from the original try is stale-rejected.
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
    return { state, commands, diagnostics };
  }

  // --- the pure reducer (the exact 2-arg contract) --------------------------

  function reduce(state: RunState, event: EngineEvent): ReduceResult {
    const diagnostics: string[] = [];

    if (event.type === 'run.started') return onRunStarted(state, event, diagnostics);

    if (state.status === 'pending') return { state, commands: [], diagnostics };

    if (event.runId !== state.runId) return { state, commands: [], diagnostics };

    if (state.status !== 'running') {
      if (event.type !== 'run.finished') {
        diagnostics.push(`event '${event.type}' on a '${state.status}' run is ignored`);
      }
      return { state, commands: [], diagnostics };
    }

    switch (event.type) {
      case 'run.finished': {
        if (
          event.outcome === 'success' &&
          !(allTopLevelTerminal(state) && firstUnhandledFailureTop(state) === null)
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
    }
  }

  function seedState(): RunState {
    return {
      runId: '',
      pipelineVersionId: '',
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

/** A node's join rule from `config.join` (`'any'` opt-in; default `'all'`). */
function nodeJoin(node: Node): 'all' | 'any' {
  return node.config['join'] === 'any' ? 'any' : 'all';
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

/** One declared output entry, as read from a node's `config.outputs`. */
type DeclaredOutput = { name: string; type: OutputType };

/**
 * A node's declared `outputs` (from `config.outputs`), or `null` when none are
 * declared / the field is malformed.
 */
function declaredOutputs(node: Node): DeclaredOutput[] | null {
  const parsed = z.array(OutputSchema).safeParse(node.config['outputs']);
  return parsed.success ? parsed.data : null;
}

/**
 * Store ONLY a node's DECLARED output keys, dropping anything else the executor
 * carried (an undeclared key must never become refable). A node with no
 * declared outputs has no contract to enforce → its whole payload passes.
 */
function storeOutputs(
  decl: DeclaredOutput[] | null,
  outputs: Record<string, unknown>,
): Record<string, unknown> {
  return decl === null
    ? { ...outputs }
    : Object.fromEntries(decl.map((d) => [d.name, outputs[d.name]]));
}

/**
 * Validate a result's outputs against declared output types. A missing or
 * mistyped declared output is an error. No declared outputs → trivially valid.
 */
function validateOutputs(
  decl: DeclaredOutput[] | null,
  outputs: Record<string, unknown>,
): string[] {
  if (decl === null) return [];
  const errs: string[] = [];
  for (const d of decl) {
    if (!Object.prototype.hasOwnProperty.call(outputs, d.name)) {
      errs.push(`missing declared output '${d.name}'`);
      continue;
    }
    if (!matchesType(outputs[d.name], d.type)) {
      errs.push(`output '${d.name}' is not of declared type '${d.type}'`);
    }
  }
  return errs;
}

function matchesType(value: unknown, type: OutputType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && !Number.isNaN(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'json':
      return true;
  }
}
