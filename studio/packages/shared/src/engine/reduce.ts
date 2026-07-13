import { z } from 'zod';
import type {
  Edge,
  EngineCommand,
  EngineEvent,
  Node,
  NodeRunState,
  PipelineVersion,
  ReduceResult,
  RunState,
  SubstitutionContext,
} from './types.js';
import { OutputSchema } from '../schemas/pipeline.js';
import type { OutputType } from '../schemas/pipeline.js';
import { effectiveEdges, substitute } from './params.js';

// ---------------------------------------------------------------------------
// P2b — the PURE event-sourced reducer + acyclic DAG walk.
//
// `createEngine(doc)` binds a pipeline's immutable graph and returns the pure
// `reduce(state, event)` (the exact 2-arg contract) plus `projectRunState` and a
// `seedState` helper. NO I/O, NO clock, NO random — an `attemptId` is minted
// from `NodeRunState.attempts`, not generated. Immutable: every transition
// returns NEW objects; the input state is never mutated.
//
// The invariant (CP1): commands out, state changes only on events. The reducer
// returns `dispatchNode`/`finishRun` COMMANDS; the driver performs each and
// appends the resulting event, and only folding that event changes state.
//
// DEFERRED to P2c (this reducer treats them as unsupported / not-yet-emitted):
// back-edges/loops (`edge.back`), containers (loop/stage), and `call_pipeline`
// (`startChild`/`call.returned`, the `waiting` node status). The ACYCLIC walk
// below is complete: typed success/failure/completion edges, the join truth
// table, skip propagation, unhandled-failure, terminal `run.finished`, and
// typed-output validation.
// ---------------------------------------------------------------------------

/** The immutable graph the reducer walks. Params/outputs arrive via events. */
export type EngineDoc = Pick<PipelineVersion, 'nodes' | 'edges'>;

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

/** Per-incoming-edge state for a successor's readiness (the CP1 truth table). */
type EdgeState = 'satisfied' | 'unsatisfied-terminal' | 'pending' | 'impossible';

/** A node's computed readiness given its incoming edges' states + join rule. */
type Readiness = 'ready' | 'skipped' | 'pending';

/**
 * Bind a pipeline's graph and return the pure engine. All graph analysis
 * (incoming/outgoing edges, the implicit success-chain, sorted node order) is
 * precomputed ONCE here and closed over — `reduce` itself does no graph walk
 * beyond readiness lookups, and never touches anything outside `state`/`event`.
 */
export function createEngine(doc: EngineDoc): Engine {
  const nodeIds = doc.nodes.map((n) => n.id);
  const sortedIds = [...nodeIds].sort();
  const nodeById = new Map<string, Node>(doc.nodes.map((n) => [n.id, n]));
  const idSet = new Set(nodeIds);

  // Forward edges only — back-edges (`edge.back`) are a P2c concern and are
  // excluded from the acyclic walk. Edge-less docs synthesize the success-chain
  // via the shared `effectiveEdges` SSOT.
  const forwardEdges = effectiveEdges(doc).filter(
    (e) => !e.back && idSet.has(e.from) && idSet.has(e.to),
  );
  const incomingByNode = new Map<string, Edge[]>();
  const outgoingByNode = new Map<string, Edge[]>();
  for (const id of nodeIds) {
    incomingByNode.set(id, []);
    outgoingByNode.set(id, []);
  }
  for (const e of forwardEdges) {
    incomingByNode.get(e.to)!.push(e);
    outgoingByNode.get(e.from)!.push(e);
  }

  // --- graph-derived helpers (pure over a passed-in `nodes` map) ------------

  /** The state of ONE incoming edge, from its predecessor's current status. */
  function edgeState(edge: Edge, nodes: RunState['nodes']): EdgeState {
    const pred = nodes[edge.from];
    if (pred === undefined) return 'impossible';
    switch (pred.status) {
      case 'skipped':
        return 'impossible';
      case 'success':
        return edge.on === 'success' || edge.on === 'completion'
          ? 'satisfied'
          : 'unsatisfied-terminal';
      case 'failure':
        return edge.on === 'failure' || edge.on === 'completion'
          ? 'satisfied'
          : 'unsatisfied-terminal';
      default:
        // pending / ready / dispatched / waiting — predecessor not yet terminal.
        return 'pending';
    }
  }

  /**
   * The CP1 join truth table. A node with NO incoming edges is a root (ready).
   * `dead` = `impossible` ∪ `unsatisfied-terminal` (an edge that can never
   * satisfy). `join:all` → ready iff every edge satisfied, skipped iff any dead,
   * else pending. `join:any` → ready iff ≥1 satisfied, skipped iff all dead,
   * else pending.
   */
  function readiness(nodeId: string, nodes: RunState['nodes']): Readiness {
    const incoming = incomingByNode.get(nodeId) ?? [];
    if (incoming.length === 0) return 'ready';
    const states = incoming.map((e) => edgeState(e, nodes));
    const dead = (s: EdgeState): boolean => s === 'impossible' || s === 'unsatisfied-terminal';
    if (nodeJoin(nodeById.get(nodeId)!) === 'all') {
      if (states.every((s) => s === 'satisfied')) return 'ready';
      if (states.some(dead)) return 'skipped';
      return 'pending';
    }
    // join: any
    if (states.some((s) => s === 'satisfied')) return 'ready';
    if (states.every(dead)) return 'skipped';
    return 'pending';
  }

  /** A failed node is UNHANDLED iff it has no outgoing `failure`/`completion` edge. */
  function firstUnhandledFailure(nodes: RunState['nodes']): string | null {
    for (const id of sortedIds) {
      if (nodes[id]?.status !== 'failure') continue;
      const outs = outgoingByNode.get(id) ?? [];
      const handled = outs.some((e) => e.on === 'failure' || e.on === 'completion');
      if (!handled) return id;
    }
    return null;
  }

  function allTerminal(nodes: RunState['nodes']): boolean {
    return sortedIds.every((id) => TERMINAL_NODE.has(nodes[id]!.status));
  }

  /**
   * Build the `${}` context for a node's `preparedInput`. `nodeOutputs` is
   * `state.outputs`, which is populated ONLY by `node.succeeded` — so a ref can
   * read a node's output solely after that node terminally succeeded (validated).
   * `triggerId`/`parentRunId` are not carried in `RunState` under P2b, so they
   * resolve to `null` here (the P2d driver, holding the `runs` row, supplies the
   * full identity later).
   */
  function prepInput(state: RunState, node: Node): Record<string, unknown> {
    const ctx: SubstitutionContext = {
      params: state.params,
      nodeOutputs: state.outputs,
      run: {
        id: state.runId,
        pipelineVersionId: state.pipelineVersionId,
        triggerId: null,
        parentRunId: null,
      },
    };
    return substitute(node.config, ctx) as Record<string, unknown>;
  }

  // --- the readiness fixpoint ("fold-to-fixpoint", CP1 Q2) ------------------

  /**
   * Re-evaluate readiness to a fixpoint and emit ALL newly-ready nodes'
   * `dispatchNode` commands in STABLE sorted order (the driver owns concurrency).
   * An unhandled failure short-circuits to `finishRun{failure}` BEFORE any
   * dispatch (checked at the top of every pass — a failure only ever enters via
   * a pre-applied `node.failed`, so no dispatch is dropped). When every node is
   * terminal, emits `finishRun{success}`.
   */
  function settle(startState: RunState, diagnostics: string[]): ReduceResult {
    let state = startState;
    const commands: EngineCommand[] = [];

    for (;;) {
      const failed = firstUnhandledFailure(state.nodes);
      if (failed !== null) {
        return {
          state,
          commands: [{ type: 'finishRun', outcome: 'failure', reason: `node_failed:${failed}` }],
          diagnostics,
        };
      }

      let changed = false;
      for (const id of sortedIds) {
        const ns = state.nodes[id]!;
        if (ns.status !== 'pending') continue;
        const r = readiness(id, state.nodes);
        if (r === 'ready') {
          let prepared: Record<string, unknown>;
          try {
            prepared = prepInput(state, nodeById.get(id)!);
          } catch (err) {
            // A doc that passed `validateRefs` should never reach here; treat an
            // unresolvable dispatch input as a corrupting fact (fail-safe).
            const msg = err instanceof Error ? err.message : String(err);
            diagnostics.push(`dispatch prep failed for node '${id}': ${msg}`);
            return {
              state,
              commands: [{ type: 'finishRun', outcome: 'failure', reason: 'invalid_event' }],
              diagnostics,
            };
          }
          const attemptId = `${id}#${ns.attempts}`;
          state = withNode(state, id, {
            status: 'ready',
            attempts: ns.attempts + 1,
            currentAttemptId: attemptId,
          });
          commands.push({ type: 'dispatchNode', nodeId: id, attemptId, preparedInput: prepared });
          changed = true;
        } else if (r === 'skipped') {
          state = withNode(state, id, { status: 'skipped' });
          changed = true;
        }
      }
      if (!changed) break;
    }

    if (allTerminal(state.nodes)) {
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
      // A run.started for a different run (or a double-start) never mutates.
      return { state, commands: [], diagnostics };
    }
    const nodes: Record<string, NodeRunState> = {};
    for (const id of nodeIds) nodes[id] = { status: 'pending', attempts: 0 };
    const started: RunState = {
      runId: event.runId,
      pipelineVersionId: event.pipelineVersionId,
      // Copy, never alias, the event's `params` object — `event` is the logged
      // fact and must never be mutated through a reference held in `state`.
      params: { ...event.params },
      status: 'running',
      nodes,
      outputs: {},
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
    if (ns === undefined) return { state, commands: [], diagnostics }; // node not in doc
    if (ns.currentAttemptId === undefined) {
      // No attempt was EVER minted for this node (it was never made ready) —
      // distinct from "stale": there is no real prior attempt this could be
      // late for, so this is IMPOSSIBLE in normal flow, not a benign no-op.
      diagnostics.push(
        `impossible node.dispatched for node '${event.nodeId}' in status '${ns.status}' (no current attempt)`,
      );
      return { state, commands: [], diagnostics };
    }
    if (event.attemptId !== ns.currentAttemptId) {
      return { state, commands: [], diagnostics }; // stale — a real prior attempt, not the live one
    }
    if (ns.status === 'ready') {
      return {
        state: withNode(state, event.nodeId, { status: 'dispatched' }),
        commands: [],
        diagnostics,
      };
    }
    if (ns.status === 'dispatched') {
      return { state, commands: [], diagnostics }; // duplicate of the current attempt → benign
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
        return { state, commands: [], diagnostics }; // STALE pre-restart result → ignored
      }
      const node = nodeById.get(event.nodeId)!;
      const decl = declaredOutputs(node);
      const errs = validateOutputs(decl, event.outputs);
      if (errs.length > 0) {
        // A bad-typed output FAILS the node — unvalidated data never crosses.
        diagnostics.push(`node '${event.nodeId}' produced invalid outputs: ${errs.join('; ')}`);
        return settle(withNode(state, event.nodeId, { status: 'failure' }), diagnostics);
      }
      // SECURITY: store ONLY the node's DECLARED output keys, dropping anything
      // else the executor's event carried — an undeclared key (e.g. a
      // secret-ish value) must never persist into `state.outputs` and become
      // refable via `${nodes.x.output.<undeclared>}`. A node with no declared
      // `outputs` at all has no contract to enforce, so its whole payload
      // passes through unchanged (unlike a partially-declared node).
      const storedOutputs =
        decl === null
          ? { ...event.outputs }
          : Object.fromEntries(decl.map((d) => [d.name, event.outputs[d.name]]));
      let next = withNode(state, event.nodeId, { status: 'success' });
      next = { ...next, outputs: { ...next.outputs, [event.nodeId]: storedOutputs } };
      return settle(next, diagnostics);
    }
    if (ns.status === 'pending') {
      // A result with no prior dispatch corrupts causal meaning → invalid_event.
      diagnostics.push(`impossible node.succeeded for never-dispatched node '${event.nodeId}'`);
      return {
        state,
        commands: [{ type: 'finishRun', outcome: 'failure', reason: 'invalid_event' }],
        diagnostics,
      };
    }
    if (event.attemptId !== ns.currentAttemptId) {
      return { state, commands: [], diagnostics }; // stale duplicate of an old attempt
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
        return { state, commands: [], diagnostics }; // STALE → ignored
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
      // The SAME attempt cannot have both succeeded and failed — this is not
      // a duplicate, it is a contradiction in the log. State stays terminal
      // (success) either way; only the diagnostic differs.
      diagnostics.push(
        `contradiction: node.failed for node '${event.nodeId}' names the same attempt that already succeeded`,
      );
      return { state, commands: [], diagnostics };
    }
    diagnostics.push(`duplicate node.failed for already-terminal node '${event.nodeId}'`);
    return { state, commands: [], diagnostics };
  }

  /**
   * `node.retryRequested` (the boot reconciler's ENGINE retry decision): mint a
   * fresh attempt so the stale executor result (old `attemptId`) can never fold,
   * clear the node's outputs (a re-run recomputes them), and re-dispatch.
   */
  function onRetryRequested(
    state: RunState,
    event: Extract<EngineEvent, { type: 'node.retryRequested' }>,
    diagnostics: string[],
  ): ReduceResult {
    const ns = state.nodes[event.nodeId];
    if (ns === undefined) return { state, commands: [], diagnostics };
    if (!LIVE_NODE.has(ns.status)) {
      // Only a `dispatched` node (the boot-reconcile case) — or, arguably, a
      // `ready` one — may be retried. A `pending` node was never dispatched;
      // an already-terminal (`success`/`failure`/`skipped`) node must never be
      // resurrected (it would clear validated outputs and re-dispatch a node
      // the run already resolved) — surface it instead of silently no-op'ing.
      diagnostics.push(
        `impossible node.retryRequested for node '${event.nodeId}' in status '${ns.status}' (not dispatched/ready)`,
      );
      return { state, commands: [], diagnostics };
    }
    if (event.previousAttemptId !== ns.currentAttemptId) {
      return { state, commands: [], diagnostics }; // stale/superseded retry → no-op
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
   * `run.resumed` (boot reconcile): re-emit `dispatchNode` for every node left in
   * `ready` (a command was emitted but its `node.dispatched` may have been lost
   * to the crash). No state change — recovery is pure command re-emission.
   */
  function onResumed(state: RunState, diagnostics: string[]): ReduceResult {
    const commands: EngineCommand[] = [];
    for (const id of sortedIds) {
      const ns = state.nodes[id]!;
      if (ns.status !== 'ready' || ns.currentAttemptId === undefined) continue;
      let prepared: Record<string, unknown>;
      try {
        prepared = prepInput(state, nodeById.get(id)!);
      } catch {
        continue;
      }
      commands.push({
        type: 'dispatchNode',
        nodeId: id,
        attemptId: ns.currentAttemptId,
        preparedInput: prepared,
      });
    }
    return { state, commands, diagnostics };
  }

  // --- the pure reducer (the exact 2-arg contract) --------------------------

  function reduce(state: RunState, event: EngineEvent): ReduceResult {
    const diagnostics: string[] = [];

    // `run.started` establishes run identity (the seed's runId is '').
    if (event.type === 'run.started') return onRunStarted(state, event, diagnostics);

    // Totality: any non-start event before the run has started is not ours yet.
    if (state.status === 'pending') return { state, commands: [], diagnostics };

    // Totality: an event for a DIFFERENT run is a silent no-op.
    if (event.runId !== state.runId) return { state, commands: [], diagnostics };

    // The run is already terminal — a late event never resurrects it.
    if (state.status !== 'running') {
      if (event.type !== 'run.finished') {
        diagnostics.push(`event '${event.type}' on a '${state.status}' run is ignored`);
      }
      return { state, commands: [], diagnostics };
    }

    switch (event.type) {
      case 'run.finished': {
        // Totality guard: a `success` claim must be BACKED by reality — every
        // node terminal AND no unhandled failure sitting in state — or it is
        // an impossible/forged event (e.g. a race with a still-pending node)
        // and must not silently terminalize the run. `failure` is intentionally
        // NOT gated here: it is the reducer's OWN fail-safe correction for an
        // impossible event elsewhere (settle()'s prepInput-failure branch,
        // onSucceeded/onFailed's never-dispatched-node branch) — those paths
        // never flip a node to 'failure' themselves, so gating `failure` the
        // same way would make that corrective `run.finished` event ALSO
        // impossible to apply, and the run could never actually terminalize.
        if (
          event.outcome === 'success' &&
          !(allTerminal(state.nodes) && firstUnhandledFailure(state.nodes) === null)
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
        // Observability only — partial outputs never mutate state / feed `${}`.
        return { state, commands: [], diagnostics };
      case 'node.dispatched':
        return onDispatched(state, event, diagnostics);
      case 'node.succeeded':
        return onSucceeded(state, event, diagnostics);
      case 'node.failed':
        return onFailed(state, event, diagnostics);
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

/** A node's join rule from `config.join` (`'any'` opt-in; default `'all'`). */
function nodeJoin(node: Node): 'all' | 'any' {
  return node.config['join'] === 'any' ? 'any' : 'all';
}

/** One declared output entry, as read from a node's `config.outputs`. */
type DeclaredOutput = { name: string; type: OutputType };

/**
 * A node's declared `outputs` (from `config.outputs`, an optional `Output[]`
 * the P3 catalog will formalize), or `null` when none are declared / the field
 * is malformed — the single parse shared by validation and output-storage
 * filtering, so the two can never disagree on what "declared" means.
 */
function declaredOutputs(node: Node): DeclaredOutput[] | null {
  const parsed = z.array(OutputSchema).safeParse(node.config['outputs']);
  return parsed.success ? parsed.data : null;
}

/**
 * Validate a `node.succeeded`'s outputs against the node's declared output
 * types. A missing or mistyped declared output is an error → the node fails.
 * A node without declared outputs (`decl === null`) validates trivially
 * (nothing to check).
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
      // A `json` output accepts any already-structured value.
      return true;
  }
}
