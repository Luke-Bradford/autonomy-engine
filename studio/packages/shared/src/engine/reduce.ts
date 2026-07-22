import type {
  Container,
  Edge,
  EngineCommand,
  EngineEvent,
  FailureKind,
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
import {
  FAIL_ACTIVITY_TYPE,
  FILTER_ACTIVITY_TYPE,
  IF_ACTIVITY_TYPE,
  IF_BRANCH_TRUE,
  IF_BRANCH_FALSE,
  SWITCH_ACTIVITY_TYPE,
  SWITCH_DEFAULT_BRANCH,
  WAIT_ACTIVITY_TYPE,
  WEBHOOK_ACTIVITY_TYPE,
} from '../catalog/types.js';
import { outputContract, storeOutputs, validateOutputs } from './outputs.js';
import {
  backEdgeResetBody,
  composeFilterExpr,
  containerJoin,
  containerMembership,
  forwardDescendants,
  nodeForwardAdjacency,
  nodeJoin,
  partitionReadiness,
  substitute,
  triggerRoot,
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
  /**
   * F2c — re-derive the COMMANDS a projection implies, appending NOTHING.
   *
   * `projectRunState` discards commands (they live only in `reduce`'s return
   * value), so a driver that re-reads the log to get a fresh state loses the very
   * dispatches it re-read for. This recovers them. It is the identical derivation
   * `run.resumed` folds to — asserted, not assumed, in `reduce.test.ts` — exposed
   * WITHOUT the event, because `run.resumed` is BOOT's durable fact: appending one
   * mid-run to obtain its commands would log a crash recovery that never happened.
   *
   * PREMISE INVERSION, and the reason this seam is documented rather than merely
   * exported: `onResumed` was written for "everything in flight was LOST", and
   * `driveRun` calls it when nothing was. Under the per-run drive lock
   * (`run/drives.ts`) that holds for `ready` nodes — no concurrent drive exists,
   * so a `ready` node's dispatch provably never started. It does NOT yet hold for
   * `waiting` call nodes: this re-emits `startChild` for every one, which would
   * re-spawn a LIVE child pipeline. Latent only because P3's executor stubs
   * `startChild` into an immediate `call.returned{failure}`, so no node ever
   * persists `waiting`. Making the re-emit genuinely idempotent via the
   * deterministic `childRunId` is P3b's obligation, and it is stated in the spec's
   * build order — not an assumption this seam is entitled to make.
   */
  resume(state: RunState): ReduceResult;
}

const LIVE_NODE = new Set<NodeRunState['status']>(['ready', 'dispatched']);

/**
 * #491 — is this node awaiting an event that can only arrive from OUTSIDE the
 * reducer? The one question the stalled backstop in `settle` turns on.
 *
 * NOT `LIVE_NODE`, and the difference is the whole point. `LIVE_NODE` answers
 * "may a result event fold onto this node" and deliberately excludes `waiting`
 * and `retry_pending`; widening it would silently let a late `node.succeeded`
 * fold onto a HELD node (see `onRetryDue`, §A.4), which is a property F2b
 * depends on. This asks a different question and needs its own set — the two
 * must be free to disagree.
 *
 * Definitionally this is `!TERMINAL_NODE.has(s) && s !== 'pending'`, and it is
 * NOT written that way on purpose. An exhaustive `switch` with no `default` is
 * the only guard that makes a 9th `NodeRunStatus` a COMPILE error here, forcing
 * its author to decide which side it falls on — `types.ts` records that
 * `TERMINAL_NODE`'s `satisfies` cannot do this, and points at `terminalStatusOf`
 * as the pattern to copy. Collapsing this to the identity would delete that
 * guard, and a status wrongly defaulted to "awaits nothing" tears down healthy
 * runs while one wrongly defaulted to "awaits something" resurrects the hang.
 *
 * `pending` is the load-bearing `false`: it awaits READINESS, which only this
 * reducer's own walk decides. At a `settle` fixpoint the walk has already had
 * its say, so a `pending` node is one nothing will ever make ready.
 *
 * What each `true` is waiting for (kept here rather than beside its `case`, so
 * the labels stay adjacent — eslint's `no-fallthrough` counts a case carrying
 * only a comment as non-empty):
 *   - `ready`         — `dispatchNode` was emitted; the driver owes `node.dispatched`.
 *   - `dispatched`    — the executor owes a `node.succeeded` / `node.failed`.
 *   - `waiting`       — a `call_pipeline` child owes a `call.returned`.
 *   - `retry_pending` — S1's DURABLE ALARM row owes a `node.retryDue`. NOTHING is
 *     in flight here, which is exactly why a naive "converged and idle" test
 *     would tear down every retrying run.
 *   - `wait_pending`  — S1's DURABLE ALARM row owes a `timer.due` (#4 A6). Same
 *     shape as `retry_pending`: nothing in flight, a durable alarm the only
 *     resolver — so `true`, or a run whose sole live node is waiting would be
 *     torn down `stalled` (the single highest-risk classification in this ticket).
 *   - `external_wait_pending` — #4 A13: a `webhook` node owes an inbound
 *     `externalWait.completed` (or its expiry alarm owes `externalWait.expired`).
 *     Same shape as `wait_pending` — nothing in flight, resolved only by an
 *     external event — so `true`, else a run whose sole live node is an external
 *     wait is torn down `stalled` before any callback can arrive.
 */
function awaitsExternalEvent(status: NodeRunState['status']): boolean {
  switch (status) {
    case 'ready':
    case 'dispatched':
    case 'waiting':
    case 'retry_pending':
    case 'wait_pending':
    case 'external_wait_pending':
      return true;
    case 'pending':
    case 'success':
    case 'failure':
    case 'skipped':
      return false;
  }
}

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
 * The `branch` label is part of the key because two arms of one branching node
 * share (from, to, 'branch'): without it, `X --branch:a--> Y` and
 * `X --branch:b--> Y` would share a single bounce counter (halving `maxBounces`)
 * and resolve each other's reset body. REACHABLE and load-bearing since #4 A1 —
 * an `if`'s two arms can both target one node (e.g. an approval "redo" back-edge
 * arm alongside the forward arm) — so this must stay in the key.
 */
function stableEdgeKey(e: Edge): string {
  return `${e.from}\x00${e.to}\x00${e.on}\x00${e.on === 'branch' ? e.branch : ''}`;
}

// Largest `seconds` for which the driver's `dueAt = now + seconds*1000` stays a
// SAFE integer (past `Number.MAX_SAFE_INTEGER` a value is still an "integer" to
// `Number.isInteger` but has lost ms precision, so the STORED `dueAt` would drift
// from the intended instant — and an outright overflow to `±Infinity` fails
// `ArmWakeupInputSchema`'s `z.number().int()`). The driver adds the wall clock
// `now` (epoch ms) ON TOP of `seconds*1000`, so the bound reserves headroom for it:
// capping `seconds*1000` alone leaves only ~1e3 ms of slack, far less than `now`
// (~1.78e12). `NOW_CEILING_MS` (1e15 ms ≈ year 33650) over-estimates any real
// clock; the resulting max wait is still ~253k years, past any real use. Module
// scope: pure literals, so computed ONCE rather than per `createEngine` call.
const NOW_CEILING_MS = 1e15;
// EXPORTED as the SSOT for the durable-alarm `dueAt` safe-integer ceiling: the
// pure reducer bounds `wait`/`webhook` durations against it (throwing), and the
// server's `armContainerTimeout` clamps A17's static container `timeout` against
// the SAME value before computing `dueAt` — one constant, never a redeclared copy.
export const MAX_WAIT_SECONDS = Math.floor((Number.MAX_SAFE_INTEGER - NOW_CEILING_MS) / 1000);

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

  // Every doc defect the bind detects, reported ONCE per run at `run.started`
  // (drained below). One list, not one per defect class: the write path refuses
  // such a doc now (#444), but rows written before that gate were never
  // validated, so these diagnostics remain the only thing that makes a
  // neutralization visible to an operator.
  const docDefects: string[] = [];

  // #487: a container child that is NOT a node id is neutralized here, at the
  // bind, so every downstream reader is correct BY CONSTRUCTION rather than by
  // remembering to guard. `seedState`/`run.started` seed `state.nodes` from
  // `doc.nodes` alone, so a child with no node behind it has no entry and the
  // `state.nodes[<child>]!` reads walk off the end — a TypeError out of the PURE
  // reducer, which does not fail the run: it escapes the fold and kills the
  // driver's pump. Fail-open in the worst place.
  //
  // The site reached FIRST is `tryDispatchNode`, via `settle`'s per-container
  // child-dispatch pass — a container is entered and its children dispatched in
  // the same `settle` iteration, so the throw lands before `stepContainers` is
  // re-entered. `stepContainers`' own `state.nodes[ch]!.status` is a latent
  // SECOND site (#487 reported it as the only one). Both are fixed here by
  // construction, which is the argument for normalizing at the bind rather than
  // guarding the read that happened to be found.
  //
  // The rule mirrors `validateDoc`'s own ("child '<x>' is not a node in this
  // pipeline") — and the CLASS is that rule, not the nested-container shape it
  // was reported as: a ghost id, a container id (studio does not nest
  // containers), and a container's own id all land here.
  //
  // Posture is #480's: treat the defect as if it were not authored. The
  // container's REAL children still run, so a doc that is wrong in one place does
  // not silently stop dispatching work that was authored correctly.
  const rawContainers: Container[] = doc.containers ?? [];
  // Membership is resolved to ONE owner per child by the shared
  // `containerMembership` SSOT (FIRST-declared-wins), so this reducer and
  // `validateDoc` can never disagree on who owns a child — the divergence #492
  // closed, where the validator resolved FIRST-wins and reported it while this
  // map silently took the LAST owner. Two different questions hang off a
  // container's children and the two must stay SEPARATE:
  //   - "does this child have node state to read, under THIS container?" — the
  //     filtered `containers.children` below, which is what stops the reducer
  //     throwing (#487) AND what neutralizes a duplicate down to its one owner.
  //   - "who OWNS this id?" — this map, which CLASSIFIES EDGES (internal vs
  //     top-level vs cross-boundary) and must reflect what the author wrote.
  // Membership is built over RAW children (not the #487-filtered set): deriving
  // it from the filtered set would conflate the two, and the effect is not
  // academic — dropping a container-id child would delete it from this map, so an
  // edge leaving it silently stops being cross-boundary, is no longer voided from
  // `topOutgoing`, and absorbs a failure that nothing handled — the exact
  // fail-open #480 closed, re-opened for one doc class, flipping a run from
  // `failure` to `success`. Pinned both ways in `malformed-doc.test.ts`.
  const { owner: childToContainer, duplicates: childDuplicates } =
    containerMembership(rawContainers);
  const childSet = new Set(childToContainer.keys());
  // #492: a NODE child claimed by more than one container is IGNORED in every
  // container but its first-declared owner (below, `kept` drops it), so exactly
  // one container enters, dispatches, awaits and projects it. Say so — same
  // neutralize-and-diagnose posture as the non-node case. A NON-node duplicate is
  // already fully described by the non-node message (it runs nowhere), so the
  // duplicate framing, which promises it runs under its first owner, would be a
  // lie for it — reported only for node children.
  for (const { child, first, container } of childDuplicates) {
    if (!nodeById.has(child)) continue;
    docDefects.push(
      `container '${container}': child '${child}' also belongs to container '${first}' and is ` +
        `IGNORED here: a child must belong to exactly one container, so it is entered, ` +
        `dispatched and awaited only under '${first}' (its first-declared owner) — treated as ` +
        `if it were not authored in '${container}'`,
    );
  }
  const containers: Container[] = rawContainers.map((c) => {
    // Keep a child only if it is a node AND this container is its resolved owner:
    // the first conjunct neutralizes a non-node id (#487), the second neutralizes
    // a duplicate down to its one owner (#492). Both keep every downstream reader
    // correct BY CONSTRUCTION rather than by remembering to guard.
    const kept = c.children.filter((ch) => nodeById.has(ch) && childToContainer.get(ch) === c.id);
    if (kept.length === c.children.length) return c;
    for (const ch of c.children) {
      if (nodeById.has(ch)) continue;
      docDefects.push(
        `container '${c.id}': child '${ch}' is not a node in this pipeline and is IGNORED: ` +
          `a container's children must be nodes, so it cannot be entered, dispatched or ` +
          `awaited — it is treated as if it were not authored`,
      );
    }
    return { ...c, children: kept };
  });
  const containerById = new Map<string, Container>(containers.map((c) => [c.id, c]));
  const containerIds = containers.map((c) => c.id);
  // Derived from `childSet` (the membership keys over RAW children), NOT the
  // `kept`-filtered bodies: a top-level node is one no container claims. A
  // duplicate node child is still claimed (by its first owner), so it stays out
  // of `topLevelNodeIds` — it does not leak back as an unconditional root.
  const topLevelNodeIds = nodeIds.filter((id) => !childSet.has(id));

  // Endpoints + the FORWARD readiness partition (endpoints = node ids ∪ container
  // ids; INTERNAL vs TOP-LEVEL edge classification incl. #480/#488/#498) come from
  // the SHARED SSOT `partitionReadiness` (params.ts), so the static ref-checker
  // (`computeGraph`) keys dominance off the EXACT same classification the reducer
  // runs on — the #567 anti-drift guarantee. This reducer keeps ownership of the
  // `topOutgoing` index and the cross-boundary DIAGNOSTICS below (the static path
  // reports those separately, in `validateDoc`).
  const {
    endpointIds,
    backEdges,
    internalForwardByContainer,
    topForwardEdges,
    topIncoming,
    childIncoming,
  } = partitionReadiness(doc, containers, childToContainer);

  // Top-level readiness entities (top-level nodes + containers) + the `topOutgoing`
  // index this reducer owns (the partition supplies `topIncoming`).
  const topEntities = [...topLevelNodeIds, ...containerIds];
  const sortedTopEntities = [...topEntities].sort();
  const topOutgoing = new Map<string, Edge[]>();
  for (const id of topEntities) topOutgoing.set(id, []);
  // #480: a CROSS-BOUNDARY edge — exactly one endpoint a child, or children of
  // DIFFERENT containers (`params.ts`'s `validateDoc` states the same rule as
  // `fromOwner !== toOwner`; keep the two in step) — is excluded from
  // `topOutgoing`, and ONLY from `topOutgoing`. `validateDoc` forbids the shape
  // but ADVISORILY (see the note on the outcome predicate below), so the
  // reducer neutralizes it rather than assuming validation removed it.
  //
  // The two indexes are deliberately asymmetric:
  //   - top → CHILD: already inert for readiness (`childIncoming` takes
  //     INTERNAL edges only), so the child runs for reasons unrelated to the
  //     source. Left in `topOutgoing` it read as a satisfied failure/completion
  //     edge whose target RAN, absorbing a failure nothing handled — fail-open.
  //     Dropping it can also make the source a forward leaf (if it has no other
  //     top-level outgoing edge), and leaf-evaluation then blames its failed
  //     ancestor. Both conjuncts move the same way: strictly more blame.
  //   - CHILD → top: already absent from `topOutgoing` (its source is a child,
  //     so it is not a `topOutgoing` key), but LOAD-BEARING in `topIncoming` —
  //     it is what still skips the top-level target when the child does not
  //     take the edge. Dropping it there would leave that target with no
  //     incoming edges, making it a root that fires unconditionally
  //     (`computeReadiness`: empty incoming ⇒ 'ready') — a WORSE fail-open than
  //     the one being fixed. So the `topIncoming` guard stays exactly as it was.
  //     Pinned in `edge-model.test.ts`.
  //
  // #488 is the ONE exception to "the `topIncoming` guard stays exactly as it
  // was", and it is exactly the case the paragraph above does not cover: a child
  // → its OWN enclosing container id. #480 kept child → top edges in
  // `topIncoming` because they are load-bearing (they SKIP the target); for a
  // child → its own container that reasoning inverts. The edge makes the
  // container wait on a child it must first ACTIVATE — `h` only dispatches once
  // `c` is active, `c` only becomes ready once `h` takes the edge — so nothing
  // dispatches and the walk cannot progress. A liveness failure, not a wrong
  // answer.
  //
  // What that costs is now DIFFERENT, and the difference is why this guard still
  // earns its place: since #491 the run no longer sits in `running` forever with
  // no terminal to reconcile against — the stalled backstop terminalizes it as
  // `failure{reason:'stalled'}`. That is containment, not a fix. Without this
  // guard the author's container never runs at all and the run reports `stalled`;
  // with it, the container activates and the run does what was authored. Do not
  // read the backstop as making this redundant.
  //
  // So the edge is INERT: the container is already the child's parent scope, and
  // the edge encodes a dependency that inverts activation order. Dropping it from
  // `topIncoming` leaves the container a root that activates — which is correct
  // here, and is NOT the fail-open #480 warns about: that hazard is a target
  // losing a gate it should have had, whereas this "gate" could never be
  // satisfied by construction.
  //
  // Removing it from `topIncoming` also removes it from the outcome predicate
  // (`ins`, in `outcomeFailure`'s leaf-blame walk). No blame is lost, and the
  // reason is the container's ACTIVATION rule, not its edge count (it may still
  // hold other incoming edges): a container reached as a skipped leaf never went
  // `active`, so its children never ran — they are `pending`, never `failure`, so
  // `evalEndpoint` had nothing to blame through this edge either way.
  //
  // The #488 edge lands in NO index after this — `topOutgoing.has(e.from)` is
  // already false (its source is a child) and `internalForwardByContainer`
  // rejects it (`fc` = the container, `tc` = undefined) — but it IS reported
  // (the #488 branch below) and then `continue`d, so "no index" here is not
  // "silently dropped". The one OTHER shape that lands in no index — a child →
  // child of a DIFFERENT container — was silently dropped until #498, and is now
  // caught by the fall-through at the end of the loop. (Cross-container BACK
  // edges are a deliberate non-goal: `params.ts`'s validator exempts `e.back`
  // from the boundary rule, and they never reach `topForwardEdges` — only
  // forward edges do.) Pinned in `malformed-doc.test.ts` and `edge-model.test.ts`.
  //
  // The cross-boundary diagnostic is shared by both report sites (the top-source
  // guard and the child→child fall-through) so their wording cannot drift — the
  // rule and the neutralization are identical; only the source's altitude differs.
  const crossBoundaryDefect = (e: Edge): string =>
    `edge '${e.id}' ('${e.from}' → '${e.to}') crosses a container boundary and is ` +
    `IGNORED: a child's forward edges must stay within its container, so it cannot ` +
    `route or handle an outcome — it is treated as if it were not authored`;
  for (const e of topForwardEdges) {
    const crossBoundary = childToContainer.get(e.from) !== childToContainer.get(e.to);
    if (topOutgoing.has(e.from)) {
      // Recorded only when the edge would OTHERWISE have been indexed here, so
      // the diagnostic never claims to have voided an edge that still routes.
      if (crossBoundary) {
        docDefects.push(crossBoundaryDefect(e));
      } else topOutgoing.get(e.from)!.push(e);
    }
    if (childToContainer.get(e.from) === e.to) {
      docDefects.push(
        `edge '${e.id}' ('${e.from}' → '${e.to}') points at its own enclosing container and ` +
          `is IGNORED: the container must activate before its child can run, so this edge ` +
          `could only ever strand the run (neither would ever start) — it is treated as if ` +
          `it were not authored`,
      );
      continue;
    }
    // #498: a child → child of a DIFFERENT container reaches here indexed
    // NOWHERE — the top-source guard above never fired (`e.from` is a child, so
    // not a `topOutgoing` key), it is not the #488 own-container case, and
    // `topIncoming` (built by `partitionReadiness`) does not take it (`e.to` is a
    // child, not a top entity). It is the same cross-boundary rule as the guard
    // above (always cross-boundary by construction here — a same-container child
    // pair is `internalForward`, never in `topForwardEdges`), reported at the one
    // place it is actually dropped. The `topIncoming` INDEXING itself now lives in
    // `partitionReadiness` (the SSOT); this loop only emits the diagnostic.
    if (!topIncoming.has(e.to) && !topOutgoing.has(e.from)) {
      docDefects.push(crossBoundaryDefect(e));
    }
  }

  // (F1b removed a `backOutgoing` index here. Its ONLY reader was the old
  // "is this failure handled?" predicate, which counted a failure/completion
  // BACK-edge as handling — fail-open when that edge never fires. The outcome
  // predicate is forward-only; back-edges still drive `fireBackEdges` via
  // `backEdges`/`backBodyByKey` below.)

  // Per-container internal readiness: `childIncoming` comes from the shared
  // `partitionReadiness`; this reducer builds only the `childOutgoing` mirror it
  // uses for its child-level outcome walk.
  const childOutgoing = new Map<string, Edge[]>();
  for (const ch of childSet) childOutgoing.set(ch, []);
  for (const c of containers) {
    for (const e of internalForwardByContainer.get(c.id)!) childOutgoing.get(e.from)!.push(e);
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
    if (oc === 'skipped') {
      // A skip propagates unless something explicitly catches it. `completion`
      // does NOT catch it: the activity never ran, so it never completed. A
      // branch edge from a SKIPPED `if` is `impossible` here — the source never
      // evaluated, so its (possibly stale, from a prior loop round) `branches`
      // entry must NOT be read. This is why the branch check sits AFTER this
      // block, not before it (#4 A0).
      return edge.on === 'skipped' ? 'satisfied' : 'impossible';
    }
    // Business routing (#4 A0): a branch edge is `satisfied` iff its source
    // recorded EXACTLY this branch label (`condition.evaluated`, folded into
    // `state.branches`). A terminal source that recorded no branch — a
    // non-branching activity, a failed `if`, or any node from a pre-A0 doc —
    // leaves every outgoing branch edge dead (`unsatisfied-terminal`), so the
    // downstream skips. The `if` node itself is `success` here (control nodes
    // terminate `success`), so this is reached with `oc === 'success'`.
    if (edge.on === 'branch') {
      return state.branches[edge.from] === edge.branch ? 'satisfied' : 'unsatisfied-terminal';
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
   * the doc need not be validated — so the bound must come from the walk.
   *
   * Lookups are `?? []`, never `!`: `validateDoc` forbids a cross-boundary
   * forward edge, and the write path now REFUSES a doc that breaks that rule
   * (#444) — but rows written before that gate were never validated, so such an
   * edge can still reach this reducer with an endpoint absent from the scope's
   * map. The gate closed the door; it did not clean the house.
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
   * a failing child) plus a container's projected outputs at exit. `run.triggerId`
   * now comes from `state.triggerContext` (the `run.triggerContext` seed, #5 S12);
   * `parentRunId` is still not carried in `RunState`, so it resolves to `null`.
   *
   * `nodeStatuses` projects `state.nodes` down to bare statuses — the language
   * reads a node's verdict, never its `attempts`/`currentAttemptId` bookkeeping.
   * `startedAt` comes from the `run.started` FACT, so it is stable across the
   * whole run and identical on replay (`null` for a pre-E3 log).
   */
  function buildCtx(state: RunState): SubstitutionContext {
    const nodeStatuses: Record<string, NodeRunState['status']> = {};
    for (const [id, ns] of Object.entries(state.nodes)) nodeStatuses[id] = ns.status;
    // The CLOSED `${trigger.*}` field set (#5 S12), flattened from the durable
    // `run.triggerContext` seed via the shared `triggerRoot` helper (#5 S12b) —
    // the same flattening `resolveTriggerBindings` uses at fire time, so a
    // trigger field reads identically whether bound into params or read in a
    // node config. Every field is always present (null where the fire carried
    // none) so `${trigger.scheduledTime}` resolves to `null` rather than
    // throwing an unknown-field error on a manual/child run.
    const trigger = triggerRoot(state.triggerContext);
    return {
      params: state.params,
      nodeOutputs: state.outputs,
      nodeStatuses,
      run: {
        runId: state.runId,
        startedAt: state.startedAt,
        pipelineVersionId: state.pipelineVersionId,
        // One source for the trigger id — `${run.triggerId}` and
        // `${trigger.triggerId}` are the same fact and must never drift.
        triggerId: trigger.triggerId,
        parentRunId: null,
      },
      trigger,
    };
  }

  function prepInput(state: RunState, node: Node): Record<string, unknown> {
    return substitute(node.config, buildCtx(state), 0, foreachItemOf(state, node.id)) as Record<
      string,
      unknown
    >;
  }

  /**
   * #2 L13a — resolve a node's (possibly `${}`) `connectionId` against the run
   * env, so ONE node can route Anthropic-vs-OpenAI by a `${params.provider}`.
   * Mirrors `call.pipelineVersionId`'s dispatch-time resolution
   * (`String(substitute(...))`, full interpolation, same `buildCtx`/`item` env as
   * `prepInput`) so the resolved id shares EXACTLY the config's env — a route that
   * reads `${nodes.x.status}` sees the same status the config does. A literal id
   * passes through `substitute` unchanged; `undefined` stays `undefined` (the
   * node carries no connection). Throws exactly as `prepInput` does (bad ref /
   * grammar), so the caller's existing try/catch → `prepFailure` covers it.
   */
  function resolveConnectionId(state: RunState, node: Node): string | undefined {
    if (node.connectionId === undefined) return undefined;
    return String(substitute(node.connectionId, buildCtx(state), 0, foreachItemOf(state, node.id)));
  }

  /**
   * Bundle the two dispatch-prep resolutions so every `dispatchNode` emission
   * site threads a resolved `connectionId` alongside the substituted config with
   * NO drift — both run against the SAME `(state, node)` the site passes. Kept as
   * ONE helper (rather than two calls per site) so a future site cannot ship the
   * config resolution and forget the connection one.
   */
  function prepDispatch(
    state: RunState,
    node: Node,
  ): { preparedInput: Record<string, unknown>; resolvedConnectionId: string | undefined } {
    return {
      preparedInput: prepInput(state, node),
      resolvedConnectionId: resolveConnectionId(state, node),
    };
  }

  /**
   * Build a `dispatchNode` command from a `prepDispatch` result. The SOLE
   * constructor of this command, so the four emission sites (`tryDispatchNode`,
   * `onRetryDue`, `onRetryRequested`, `run.resumed` re-emit) cannot drift on which
   * fields a `dispatchNode` carries — dropping `resolvedConnectionId` at one site
   * (the #2 L13a routing key) is made structurally impossible rather than a
   * per-site discipline.
   */
  function dispatchNodeCommand(
    nodeId: string,
    attemptId: string,
    prepared: { preparedInput: Record<string, unknown>; resolvedConnectionId: string | undefined },
  ): Extract<EngineCommand, { type: 'dispatchNode' }> {
    return {
      type: 'dispatchNode',
      nodeId,
      attemptId,
      preparedInput: prepared.preparedInput,
      resolvedConnectionId: prepared.resolvedConnectionId,
    };
  }

  /**
   * The `${item}` binding (#4 A4) for a node dispatched INSIDE a `foreach` body —
   * the element at the container's current item index (`round`), or `undefined`
   * for any node not in a foreach (so `${item}` throws its "only bound inside …"
   * error everywhere else, unchanged). The resolved `items` array is snapshotted
   * on `ContainerRunState.items` at enter, so this is a pure read.
   */
  function foreachItemOf(state: RunState, id: string): { value: unknown } | undefined {
    const cid = childToContainer.get(id);
    if (cid === undefined) return undefined;
    const c = containerById.get(cid);
    if (c === undefined || c.kind !== 'foreach') return undefined;
    const cs = state.containers[cid];
    if (cs === undefined) return undefined;
    const items = cs.items;
    if (items === undefined || cs.round >= items.length) return undefined;
    return { value: items[cs.round] };
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
   * A skipped entity's OBSERVABILITY backstop (retired `noteInertBranch`, re-scoped
   * for #4 A0). Flag ONLY the anomaly: an incoming `branch` edge whose source
   * terminalised `success`/`failure` WITHOUT recording a branch (`branches[from]`
   * undefined) — a non-branching activity, a failed `if`, or a pre-#444 legacy row.
   * Such an edge can never satisfy, so the target is skipped SILENTLY (the run can
   * still succeed, so nothing else surfaces the lost subgraph). `validateDoc` is the
   * write-time half, but legacy rows were never validated — this is the runtime half
   * the deleted comment warned not to drop on the strength of `validateDoc` alone.
   *
   * NOT flagged: a source that took a DIFFERENT arm (`branches[from]` defined ≠ this
   * label — normal routing) or a SKIPPED source (skip propagation — cause already
   * upstream; edgeState makes those `impossible`, so they never reach here as dead
   * `branch` edges with a terminal success/failure source).
   */
  function noteDeadBranchOnSkip(
    id: string,
    incoming: Edge[],
    state: RunState,
    diagnostics: string[],
  ): void {
    const dead = incoming.filter((e) => {
      if (e.on !== 'branch') return false;
      const oc = endpointOutcome(e.from, state);
      return (oc === 'success' || oc === 'failure') && state.branches[e.from] === undefined;
    }).length;
    if (dead === 0) return;
    const subject = dead === 1 ? `an incoming 'branch' edge` : `${dead} incoming 'branch' edges`;
    diagnostics.push(
      `'${id}' was skipped and has ${subject} whose source terminalised without recording a ` +
        `branch outcome (a non-branching activity, a failed 'if', or a pre-#444 legacy row), so ` +
        `the edge could never be satisfied and the subgraph was skipped silently — check the ` +
        `branch source`,
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
      noteDeadBranchOnSkip(id, incoming, state, diagnostics);
      return { state: withNode(state, id, { status: 'skipped' }), changed: true };
    }
    if (r !== 'ready') return { state, changed: false };

    const attemptId = `${id}#${ns.attempts}`;
    const controlEvent = controlBranchEvent(node.type);
    if (controlEvent !== undefined) {
      // #4 A1/A2 — a `control` `if`/`switch` is ENGINE-evaluated: no connector, no
      // executor round-trip. The reducer learns "this is control" STRUCTURALLY
      // from `node.type` (the `call_pipeline`/`Node.call` precedent D6's note
      // sanctions), checked before `node.call` — a node is one or the other.
      // Evaluate the `${}` condition/`on` PURELY (clock-free + replay-stable),
      // then ask the driver to make the chosen branch durable via
      // `evaluateControl` (whose `event` names the durable event to append). The
      // node holds `ready` (the driver owes `condition.evaluated`/`switch.evaluated`,
      // mirroring the `dispatchNode`/`node.dispatched` handshake) and is NEVER
      // handed to the executor. A bad condition/`on` throws → `prepFailure` →
      // `finishRun{invalid_event}`, the same verdict a dispatch prep-throw reaches.
      let branch: string;
      try {
        branch = evalControlBranch(node, state, foreachItemOf(state, id));
      } catch (err) {
        return prepFailure(state, id, err, diagnostics);
      }
      const next = withNode(state, id, {
        status: 'ready',
        attempts: ns.attempts + 1,
        currentAttemptId: attemptId,
      });
      commands.push({
        type: 'evaluateControl',
        nodeId: id,
        attemptId,
        branch,
        event: controlEvent,
      });
      return { state: next, changed: true };
    }
    if (node.type === FAIL_ACTIVITY_TYPE) {
      // #4 A7 — a `control` `fail` is ENGINE-evaluated like `if`/`switch` (checked
      // here, before `node.call` and dispatch — a node is one or the other), but it
      // produces a FAILURE, not a branch. Resolve the `${}` `message` PURELY, hold
      // the node `ready` (the driver owes `node.failed`, the same handshake `if`/
      // `switch` use for their durable event), and emit a `failNode` command. NEVER
      // handed to the executor. A missing/bad `message` throws → `prepFailure` →
      // `finishRun{invalid_event}`, the same verdict a control-eval throw reaches.
      let error: string;
      try {
        error = evalFailMessage(node, state, foreachItemOf(state, id));
      } catch (err) {
        return prepFailure(state, id, err, diagnostics);
      }
      const next = withNode(state, id, {
        status: 'ready',
        attempts: ns.attempts + 1,
        currentAttemptId: attemptId,
      });
      commands.push({ type: 'failNode', nodeId: id, attemptId, error });
      return { state: next, changed: true };
    }
    if (node.type === FILTER_ACTIVITY_TYPE) {
      // #4 A8 — a `control` `filter` is ENGINE-evaluated like `if`/`switch`/`fail`
      // (checked here, before `node.call` and dispatch — a node is one or the
      // other), but it produces a normal SUCCESS carrying a `result` OUTPUT, not a
      // branch or a failure. Resolve `items`+`predicate` PURELY (the inert
      // `filter(items, predicate)` closed-fn over run state), hold the node `ready`
      // (the driver owes `node.succeeded`, the same handshake `if`/`switch`/`fail`
      // use for their durable event), and emit a `succeedControl` command. NEVER
      // handed to the executor. A missing/bad `items`/`predicate` (non-array,
      // non-boolean predicate, bad `${}` ref) throws → `prepFailure` →
      // `finishRun{invalid_event}`, the same verdict a control-eval throw reaches.
      let outputs: Record<string, unknown>;
      try {
        outputs = evalFilter(node, state, foreachItemOf(state, id));
      } catch (err) {
        return prepFailure(state, id, err, diagnostics);
      }
      const next = withNode(state, id, {
        status: 'ready',
        attempts: ns.attempts + 1,
        currentAttemptId: attemptId,
      });
      commands.push({ type: 'succeedControl', nodeId: id, attemptId, outputs });
      return { state: next, changed: true };
    }
    if (node.type === WAIT_ACTIVITY_TYPE) {
      // #4 A6 — a `control` `wait` is ENGINE-evaluated like `if`/`switch`/`fail`/
      // `filter` (checked here, before `node.call` and dispatch — a node is one or
      // the other), but it is DURABLE: it PARKS on S1's alarm instead of producing a
      // branch/failure/success synchronously. Resolve the `${}` `seconds` PURELY,
      // hold the node `ready` (the driver owes `timer.waitScheduled`, the same
      // handshake the other control activities use for their durable event), and
      // emit a `scheduleWait` command carrying the resolved duration. NEVER handed to
      // the executor. A missing/bad `seconds` (non-string, non-finite, negative, bad
      // `${}` ref) throws → `prepFailure` → `finishRun{invalid_event}`, the same
      // verdict a control-eval throw reaches. The node does NOT enter `wait_pending`
      // here — that transition is `timer.waitScheduled`'s fold, appended by the
      // driver AFTER it arms the alarm, so a `wait_pending` node always has a live
      // alarm (why wait, unlike retry, needs no boot re-arm).
      let seconds: number;
      try {
        seconds = evalWaitSeconds(node, state, foreachItemOf(state, id));
      } catch (err) {
        return prepFailure(state, id, err, diagnostics);
      }
      const next = withNode(state, id, {
        status: 'ready',
        attempts: ns.attempts + 1,
        currentAttemptId: attemptId,
      });
      commands.push({ type: 'scheduleWait', nodeId: id, attemptId, seconds });
      return { state: next, changed: true };
    }
    if (node.type === WEBHOOK_ACTIVITY_TYPE) {
      // #4 A13 — a `control` `webhook` is ENGINE-evaluated like `wait` (checked
      // here, before `node.call` and dispatch), and DURABLE, but PARKS awaiting an
      // inbound callback rather than a timer. Resolve the `${}` `timeoutSeconds`
      // PURELY, hold the node `ready` (the driver owes `externalWait.created`, the
      // same handshake `wait` uses for `timer.waitScheduled`), and emit a
      // `scheduleExternalWait` command carrying the resolved timeout. NEVER handed to
      // the executor. A missing/bad `timeoutSeconds` throws → `prepFailure` →
      // `finishRun{invalid_event}`. The node does NOT enter `external_wait_pending`
      // here — that transition is `externalWait.created`'s fold, appended by the
      // driver AFTER it arms the expiry alarm + correlation row, so an
      // `external_wait_pending` node always has a live alarm.
      let timeoutSeconds: number;
      try {
        timeoutSeconds = evalWebhookTimeoutSeconds(node, state, foreachItemOf(state, id));
      } catch (err) {
        return prepFailure(state, id, err, diagnostics);
      }
      const next = withNode(state, id, {
        status: 'ready',
        attempts: ns.attempts + 1,
        currentAttemptId: attemptId,
      });
      commands.push({ type: 'scheduleExternalWait', nodeId: id, attemptId, timeoutSeconds });
      return { state: next, changed: true };
    }
    if (node.call !== undefined) {
      // call_pipeline: resolve the (possibly `${}`) pipelineVersionId + params,
      // hold the node `waiting`, and ask the driver to spawn the child.
      let pvId: string;
      let callParams: Record<string, unknown>;
      try {
        const ctx = buildCtx(state);
        const item = foreachItemOf(state, id);
        pvId = String(substitute(node.call.pipelineVersionId, ctx, 0, item));
        callParams = substitute(node.call.params, ctx, 0, item) as Record<string, unknown>;
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

    let prepared: {
      preparedInput: Record<string, unknown>;
      resolvedConnectionId: string | undefined;
    };
    try {
      prepared = prepDispatch(state, node);
    } catch (err) {
      return prepFailure(state, id, err, diagnostics);
    }
    const next = withNode(state, id, {
      status: 'ready',
      attempts: ns.attempts + 1,
      currentAttemptId: attemptId,
    });
    commands.push(dispatchNodeCommand(id, attemptId, prepared));
    return { state: next, changed: true };
  }

  // Return type PINS `finish` as present (not the `Step`-optional `finish?`): every
  // `prepFailure` path terminalizes, so each call site reads `failed.finish` without a
  // non-null `!`. Narrowing here makes the invariant compiler-enforced — if a future
  // edit stopped setting `finish`, this signature would fail to typecheck rather than
  // silently emit an `undefined` command downstream.
  function prepFailure(
    state: RunState,
    id: string,
    err: unknown,
    diagnostics: string[],
  ): Step & { finish: EngineCommand } {
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
   *     (the container FAILS with reason `capped`). A loop that can never exit —
   *     an empty body (`no_progress`) or neither `exitWhen` nor `maxRounds`
   *     (`no_exit_condition`) — FAILS after its mandatory first round.
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
      if (c.kind === 'foreach') {
        // #4 A4 — the item-round is terminal and unfailed (the failure check above
        // short-circuits fail-fast). Capture THIS item's projected child outputs
        // into the order-stable `results` accumulator BEFORE `resetNodes` clears
        // them, then advance to the next item or exit. `round` is the 0-based item
        // index; the loop-only guards below (`no_progress`/`no_exit_condition`/
        // `capped`) are deliberately unreachable for a foreach — it is bounded by
        // `items.length`, not `exitWhen`/`maxRounds`.
        const items = cs.items ?? [];
        const results = [...(cs.results ?? []), mergeChildOutputs(c, state)];
        const withResults = withContainer(state, c.id, { results });
        if (cs.round + 1 < items.length) {
          return { state: resetContainerRound(withResults, c), changed: true };
        }
        return { state: exitContainer(withResults, c, 'success'), changed: true };
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
      // A loop with an EMPTY body cannot progress, so re-rounding it is provably
      // non-terminating: the round is VACUOUSLY terminal, the reset returns
      // nothing to `pending`, and round N+1 is bit-identical to round N — so
      // `exitWhen` can never change. `settle` spun here SYNCHRONOUSLY at 100% CPU
      // inside ONE `reduce()`, with no I/O to pace it and no timeout able to
      // preempt it: the driver's event loop simply stopped.
      //
      // This is the same fixpoint argument, and the same verdict, as
      // `validateDoc`'s back-edge no-progress rule ("makes no progress — its
      // reset body must include its source ... re-fires forever"). The loop
      // CONTAINER had no such guard in either the validator or the reducer; it
      // does now, in both.
      //
      // Deliberately ABOVE the `maxRounds` cap. An empty loop with a `maxRounds`
      // already terminated, reporting `capped` — but `capped` means "hit the
      // round budget", which implies the rounds did work and a bigger budget
      // might have helped. Both are false here. `no_progress` is the honest
      // reason whatever the budget says.
      //
      // The empty body is reachable two ways: authored empty (schema-legal —
      // `ContainerSchema.children` has no min length), or left empty by #487's
      // normalization above when every child was a non-node id.
      if (c.children.length === 0) {
        diagnostics.push(
          `container '${cid}' makes no progress: a loop with no children re-rounds forever ` +
            `(its exitWhen cannot change, because a round resets nothing)`,
        );
        return { state: exitContainer(state, c, 'failure', 'no_progress'), changed: true };
      }
      // A loop with a non-empty body but NEITHER an `exitWhen` NOR a `maxRounds`
      // can never terminate: `evalExitWhen` returns false for an undefined
      // `exitWhen` (above), so the exit is unreachable, and with no cap the
      // re-round below fires forever. Unlike the empty-body case this is NOT a
      // synchronous spin — the body's children are real, so the driver paces each
      // round — but it is still an authored infinite loop that never ends.
      //
      // `validateDoc` refuses such a doc at write time (#444: "a loop needs an
      // exitWhen", UNCONDITIONALLY — a `maxRounds` is only the round cap, never the
      // exit). But rows written before that gate were never validated and are
      // IMMUTABLE, so this reducer is the only place one already in storage can be
      // stopped — the same last-line-of-defense role `evalExitWhen`'s E2 mode check
      // plays. Do-while is honoured: the mandatory first round has already run
      // (this branch is only reached once the round is terminal); we fail CLOSED
      // rather than re-round.
      //
      // The guard requires BOTH fields absent, deliberately asymmetric with the
      // validator (which rejects a missing `exitWhen` regardless of `maxRounds`):
      // a pre-gate row with a `maxRounds` but no `exitWhen` DOES terminate, via the
      // `capped` cap below, so there is nothing to defend there. Do not "align" it
      // to the validator — that would relabel a legitimately capped loop.
      if (c.exitWhen === undefined && c.maxRounds === undefined) {
        diagnostics.push(
          `container '${cid}' has no exit condition: a loop with neither exitWhen nor ` +
            `maxRounds re-rounds forever`,
        );
        return { state: exitContainer(state, c, 'failure', 'no_exit_condition'), changed: true };
      }
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
   * This is the enforcement point that BINDS for a doc already in storage: the
   * write path refuses one that breaks `validateDoc`'s whole-value rule now
   * (#444), but rows written before that gate were never validated and still
   * reach the engine unchecked. Pure + replay-safe: trim/classify are
   * deterministic on the doc, so a replay of the same log reaches the same
   * verdict.
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
    // The save-time half cannot close this alone: the write path refuses such a
    // doc now (#444), but rows written before that gate were never validated and
    // still reach this reducer unchecked. Same both-halves rule E2 set for the
    // MODE check, for the same reason.
    throw new SubstituteError(
      `exitWhen must resolve to a boolean, got ${typeof out} — ` +
        "compare it explicitly (e.g. ${equals(nodes.check.output.done, 'true')})",
    );
  }

  /**
   * #4 A4 — evaluate a `foreach` container's `${}` `items` to its ARRAY, ONCE at
   * enter time over the OUTER scope (`buildCtx`). Whole-value-REQUIRED like
   * `exitWhen`: an embedded/interpolated `items` can only ever be a STRING, so it
   * would iterate the string's characters or throw — refuse it outright (the
   * run-time half of the save-time `validateForeachItems` rule, binding for a row
   * written before that gate). A non-array result throws → `invalid_event` (never
   * silently coerced), the same fail-LOUD posture as the switch `cases` guard.
   * Pure over `state`: `substitute` reads only bound outputs/params/trigger, so a
   * replay reaches the same array.
   */
  function evalForeachItems(c: Container, state: RunState): unknown[] {
    const src = (c.items ?? '').trim();
    const defect = wholeValueDefect(src, 'items');
    if (defect !== null) throw new SubstituteError(defect);
    // `items` is NOT unbounded even from a data-controlled array (`params`/trigger):
    // `substitute` charges every materialised array against the inert language's
    // per-field element budget (`MAX_ARRAY_ELEMENTS_TOTAL`, params.ts), so an
    // over-cap `items` throws HERE → the run fails `invalid_event` before a single
    // item dispatches. That is the resolver's designated resource limit for
    // array-forms (spec #6 "Resource limits"); it is the foreach's iteration
    // ceiling, the counterpart to a loop's `maxRounds`.
    const out = substitute(src, buildCtx(state));
    if (!Array.isArray(out)) {
      throw new SubstituteError(
        `foreach '${c.id}' items must resolve to an array, got ${out === null ? 'null' : typeof out} — ` +
          'items is the ${} array the body iterates (e.g. ${params.records})',
      );
    }
    return out;
  }

  /**
   * #4 A1 — evaluate an `if` node's `${}` boolean `config.condition` to its
   * branch LABEL (`'true'`/`'false'`, matching `BranchEdgeSchema.branch`, a
   * string — NOT a raw boolean, so `edgeState`'s `===` against the declared
   * label holds). This is `evalExitWhen`'s exact shape, reading the SAME
   * `wholeValueDefect` SSOT the save-time half (`validateDoc`) reads, so the two
   * cannot word the rule differently. Pure over `state`: `substitute` reads only
   * bound outputs/params/trigger context, so a replay reaches the same label.
   * Throws (→ `prepFailure` → `finishRun{invalid_event}`) on a missing/non-string
   * condition, a mode defect, or a non-boolean result — the run-time half of
   * E6's boolean-condition rule that the write gate (#444) warns about first.
   */
  function evalIfBranch(node: Node, state: RunState, item?: { value: unknown }): string {
    const raw = node.config['condition'];
    if (typeof raw !== 'string') {
      throw new SubstituteError(
        `if node '${node.id}' has no string 'condition' — an if routes on a ` +
          "boolean ${} expression (e.g. ${equals(nodes.check.output.ok, 'true')})",
      );
    }
    const src = raw.trim();
    const defect = wholeValueDefect(src, 'condition');
    if (defect !== null) throw new SubstituteError(defect);
    const out = substitute(src, buildCtx(state), 0, item);
    if (typeof out === 'boolean') return out ? IF_BRANCH_TRUE : IF_BRANCH_FALSE;
    throw new SubstituteError(
      `if condition must resolve to a boolean, got ${typeof out} — ` +
        "compare it explicitly (e.g. ${equals(nodes.check.output.done, 'true')})",
    );
  }

  /**
   * #4 A1/A2 — is `type` an engine-evaluated control BRANCHING activity, and if
   * so, which durable event does its evaluation make? The ONE structural SSOT the
   * reducer routes control nodes by (`tryDispatchNode` dispatch-prep + `resume`'s
   * crash-recovery re-emit both read it), so the two paths cannot disagree on
   * which types are control. `undefined` for every non-branching type (a normal
   * execution node, a `call_pipeline`, a container).
   */
  function controlBranchEvent(
    type: string,
  ): 'condition.evaluated' | 'switch.evaluated' | undefined {
    if (type === IF_ACTIVITY_TYPE) return 'condition.evaluated';
    if (type === SWITCH_ACTIVITY_TYPE) return 'switch.evaluated';
    return undefined;
  }

  /**
   * #4 A1/A2 — evaluate a control branching node to its branch LABEL, dispatching
   * on `type` to the per-activity evaluator. PRECONDITION: `controlBranchEvent`
   * returned a defined event for this node (the caller checked). Throws
   * (→ `prepFailure` → `finishRun{invalid_event}`) on a bad condition/`on`, so the
   * decision is a fact the driver can make durable or the run fails — never a
   * silent mis-route. EXHAUSTIVE over the control types (an unhandled type throws
   * rather than silently running the `if` evaluator): adding a type to
   * `controlBranchEvent` but forgetting the evaluator here surfaces loudly, not as
   * a wrong-branch route.
   */
  function evalControlBranch(node: Node, state: RunState, item?: { value: unknown }): string {
    if (node.type === IF_ACTIVITY_TYPE) return evalIfBranch(node, state, item);
    if (node.type === SWITCH_ACTIVITY_TYPE) return evalSwitchBranch(node, state, item);
    throw new SubstituteError(`no control-branch evaluator for node type '${node.type}'`);
  }

  /**
   * #4 A2 — evaluate a `switch` node's `${}` `config.on` to its branch LABEL: the
   * matched case label, or `SWITCH_DEFAULT_BRANCH` when the value matches none.
   * Unlike `if` (whose boolean can only come from a WHOLE-value `${}`), a `switch`
   * matches on a STRING, so an EMBEDDED template (`"tier-${x}"`) is a legitimate
   * `on` and is NOT whole-value-gated — `substitute` resolves it to a string
   * verbatim (no `.trim()`: the resolved value is matched exactly against the case
   * labels, so trimming could silently change which arm is taken). Pure over
   * `state`: `substitute` reads only bound outputs/params/trigger context, so a
   * replay reaches the same label. Throws (→ `invalid_event`) on a missing/
   * non-string `on`, an `on` that resolves to a non-string (a whole-value
   * `${number}` etc.), or a missing/malformed `cases` (non-array or empty) — the
   * run-time half of A2's string-match rule that the write gate
   * (`validateSwitchConfig`) warns about first.
   */
  function evalSwitchBranch(node: Node, state: RunState, item?: { value: unknown }): string {
    const raw = node.config['on'];
    if (typeof raw !== 'string') {
      throw new SubstituteError(
        `switch node '${node.id}' has no string 'on' — a switch routes on a ` +
          'string ${} expression (e.g. ${nodes.classify.output.label})',
      );
    }
    const out = substitute(raw, buildCtx(state), 0, item);
    if (typeof out !== 'string') {
      throw new SubstituteError(
        `switch 'on' must resolve to a string, got ${typeof out} — ` +
          'convert it explicitly (e.g. ${string(nodes.count.output.n)})',
      );
    }
    // The write gate (`validateSwitchConfig`) is only ADVISORY, so a saved doc can
    // reach here with a missing/malformed `cases`. Fail LOUD (→ `invalid_event`),
    // mirroring the `on` check above and the write gate's own
    // `!Array.isArray(rawCases) || rawCases.length === 0` rule — never silently
    // normalise to `[]` and route EVERY value to `default`, which would mask a
    // dropped/corrupt config as a benign fallthrough (an absent fact manufactured
    // as a default).
    const rawCases = node.config['cases'];
    if (!Array.isArray(rawCases) || rawCases.length === 0) {
      throw new SubstituteError(
        `switch node '${node.id}' has no non-empty 'cases' array — a switch routes ` +
          'a string value against a list of case labels (e.g. ["gold", "silver"])',
      );
    }
    return rawCases.includes(out) ? out : SWITCH_DEFAULT_BRANCH;
  }

  /**
   * #4 A7 — resolve a `fail` node's authored `${}` `message` to the plain string
   * the driver makes durable as `node.failed.error`. UNLIKE `if`/`switch` (which
   * evaluate to a routing BRANCH), a `fail` produces a FAILURE — so this returns
   * the resolved message text, and the caller emits a `failNode` command (not
   * `evaluateControl`). Pure over `state`: `substitute` reads only bound outputs/
   * params/trigger context (+ the `foreach` `item`), so a replay resolves the same
   * message. The message is an EMBEDDED template (display text, e.g. `"rejected:
   * ${nodes.check.output.reason}"`), NOT whole-value-gated the way an `if`'s
   * boolean is — `String()` coerces whatever it resolves to, since a message is
   * human text. Throws (→ `prepFailure` → `finishRun{invalid_event}`) on a
   * missing/non-string/empty raw `message` — a malformed fail-config, distinct
   * from the fail firing, fails the run LOUD rather than manufacturing a benign
   * default message (mirrors `evalSwitchBranch`'s raw-`on` check and the
   * project's "never manufacture an absent fact" rule). A `${}` that itself throws
   * (a bad ref/mode defect) reaches the same verdict.
   */
  function evalFailMessage(node: Node, state: RunState, item?: { value: unknown }): string {
    const raw = node.config['message'];
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new SubstituteError(
        `fail node '${node.id}' has no 'message' — a fail force-fails with a ` +
          "message describing the failure (e.g. 'validation rejected the input')",
      );
    }
    return String(substitute(raw, buildCtx(state), 0, item));
  }

  /**
   * #4 A8 — resolve a `filter` node's `items`+`predicate` to its `{ result }`
   * output. UNLIKE `if`/`switch` (a branch) and `fail` (a failure), a `filter`
   * SUCCEEDS with data — the input array filtered by the whole-value `${}`
   * predicate, order-preserved. `composeFilterExpr` splices the two whole-value
   * fields into the inert language's existing `filter(items, predicate)` closed-fn
   * (ONE `${}`, ONE array-element budget, `Array.prototype.filter` order), which
   * `substitute` evaluates PURELY over run state (+ the `foreach` `item` for a
   * filter inside a foreach body — the predicate's own `${item}` SHADOWS it
   * per-element via the `filter` fn's `withItem`, exactly like a nested
   * `filter(rows, greater(item, 2))`). Throws `SubstituteError` (→ `prepFailure` →
   * `invalid_event`) on a missing/non-whole-value `items`/`predicate`, a non-array
   * `items`, a non-boolean predicate element, or a bad `${}` ref — the malformed
   * config fails the run LOUD rather than manufacturing a benign empty result (the
   * project's "never manufacture an absent fact" rule; mirrors `evalSwitchBranch`).
   */
  function evalFilter(
    node: Node,
    state: RunState,
    item?: { value: unknown },
  ): Record<string, unknown> {
    const out = substitute(composeFilterExpr(node.config), buildCtx(state), 0, item);
    // The `filter(...)` fn returns an array or throws (`loopArr` on a non-array
    // `items`, `expectBool` on a non-boolean predicate element). This guard is
    // defensive — a composed `filter` can only yield an array — and keeps the
    // stored `result` output honestly array-typed.
    if (!Array.isArray(out)) {
      throw new SubstituteError(`filter node '${node.id}' did not resolve to an array`);
    }
    return { result: out };
  }

  /**
   * #4 A6 — resolve a `wait` node's authored `${}` `seconds` to the finite,
   * non-negative NUMBER the driver's `armWait` turns into `dueAt = now +
   * seconds*1000`. Pure over `state` (+ the `foreach` `item`): `substitute` reads
   * only bound outputs/params/trigger context, so a replay resolves the SAME
   * duration and the re-armed alarm keeps the original `dueAt`.
   *
   * `seconds` is a WHOLE-value `${}` field (like `if.condition`/`foreach.items`), so
   * a well-formed one resolves to a TYPED value — a `number` (`${5}` /
   * `${nodes.x.output.delay}`) or a numeric string; `Number()` coerces the latter.
   * BOTH halves of the whole-value rule fire (the `wholeValueDefect` SSOT, exactly
   * as `evalIfBranch`/`evalForeachItems` apply it at run time — not just at save):
   * an embedded template (`"wait ${x}s"`) can only resolve to a STRING, never a
   * duration, so it throws here as well as at save.
   *
   * Throws `SubstituteError` (→ `prepFailure` → `finishRun{invalid_event}`) on a
   * missing/non-string raw `seconds`, a non-whole-value template, or a value that
   * resolves to NaN / ±Infinity / a NEGATIVE number, or a non-number/non-numeric-
   * string shape (array/boolean/null/empty-string) — a malformed wait fails the run
   * LOUD rather than parking on a silently-defaulted or backwards timer (the
   * project's "never manufacture an absent fact" rule; mirrors `evalFailMessage`/
   * `evalFilter`, and the non-finite refusal #547 pinned at ingestion boundaries).
   * Zero is allowed (an immediate wake). The `armWait` boundary rounds `dueAt` to
   * integer ms (S1's `dueAt` is `z.number().int()`), so a fractional `${}` seconds
   * is a valid sub-second wait, not an arm-time crash.
   */
  function evalWaitSeconds(node: Node, state: RunState, item?: { value: unknown }): number {
    return evalDurationSeconds(node, state, item, 'seconds', 'wait');
  }

  /**
   * #4 A13 — a `webhook` node's `${}` `timeoutSeconds`, resolved by the SAME
   * whole-value/finite/bounded rules as a `wait`'s `seconds` (the shared
   * `evalDurationSeconds` SSOT). The driver's `armExternalWait` turns it into the
   * expiry `dueAt = now + timeoutSeconds*1000`. Required (a webhook must always be
   * time-bounded — its own dispatch-prep throws on absence, so a parked webhook
   * always has a live expiry alarm and can never stall).
   */
  function evalWebhookTimeoutSeconds(
    node: Node,
    state: RunState,
    item?: { value: unknown },
  ): number {
    return evalDurationSeconds(node, state, item, 'timeoutSeconds', 'webhook');
  }

  /**
   * #4 A6/A13 — the SSOT for resolving a durable-park node's `${}` DURATION field
   * to the finite, non-negative, bounded number the driver turns into an alarm
   * `dueAt`. Parameterised by the config key (`seconds` / `timeoutSeconds`) and the
   * node NOUN (`wait` / `webhook`) so `wait` and `webhook` share one hardened rule —
   * the whole-value gate (an embedded template can only produce a STRING),
   * the fail-open guards (`Number([])`/`Number(false)`/`Number('')` all coerce to a
   * manufactured `0`), and the `MAX_WAIT_SECONDS` overflow bound — instead of two
   * copies that could drift.
   */
  function evalDurationSeconds(
    node: Node,
    state: RunState,
    item: { value: unknown } | undefined,
    field: string,
    noun: string,
  ): number {
    const raw = node.config[field];
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new SubstituteError(
        `${noun} node '${node.id}' has no '${field}' — a ${noun} parks for a number of ` +
          'seconds (e.g. ${5} or ${nodes.check.output.retryAfter})',
      );
    }
    const src = raw.trim();
    // Run-time whole-value gate, the SSOT `validateDoc` reads at save —
    // enforced HERE too so a pre-gate legacy row (or any bypass of the save path)
    // fails LOUD instead of coercing an embedded template's string result.
    const defect = wholeValueDefect(src, field);
    if (defect !== null) throw new SubstituteError(defect);
    const resolved = substitute(src, buildCtx(state), 0, item);
    // Accept a `number` (`${5}` / a number-typed ref) or a NON-EMPTY numeric
    // `string` (`${'7'}` / a string-typed ref) — `Number` coerces the latter. But
    // NOT via a bare `Number(resolved)`, which is fail-OPEN: `Number([])`,
    // `Number(false)`, `Number(null)` and `Number('')` all yield `0`, and
    // `Number([5])` yields `5` — so an array / boolean / null / empty-string
    // `${}` would SILENTLY park for a manufactured duration instead of failing the
    // run. Reject every non-number, non-numeric-string shape LOUD (the project's
    // "never manufacture an absent fact" rule; the #547 non-finite refusal generalised
    // to "not a plausible duration at all").
    let seconds: number;
    if (typeof resolved === 'number') {
      seconds = resolved;
    } else if (typeof resolved === 'string' && resolved.trim() !== '') {
      seconds = Number(resolved);
    } else {
      seconds = NaN;
    }
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new SubstituteError(
        `${noun} node '${node.id}' ${field} must resolve to a finite, non-negative number ` +
          `(got ${JSON.stringify(resolved)})`,
      );
    }
    // Upper-bound so the driver's `dueAt = now + seconds*1000` cannot overflow past
    // a SAFE integer (→ ±Infinity / precision loss). An unbounded astronomical value
    // passes the finite/non-negative gate here but then fails `ArmWakeupInputSchema`'s
    // `z.number().int()` INSIDE the arm as a boot poison pill (the run re-throws on
    // every resume) instead of failing LOUD here — the opposite tail of the
    // fractional case the arm rounds. Reject at eval time so a bad duration fails the
    // run cleanly, never the alarm arm. `MAX_WAIT_SECONDS` keeps the FULL
    // `dueAt = now + seconds*1000` within `Number.MAX_SAFE_INTEGER` (it reserves
    // headroom for `now` — see the constant), so no precision drift or overflow
    // reaches the arm; the cap is still ~253k years, past any real wait.
    if (seconds > MAX_WAIT_SECONDS) {
      throw new SubstituteError(
        `${noun} node '${node.id}' ${field} ${seconds} exceeds the maximum ${MAX_WAIT_SECONDS} ` +
          '(a longer wait would overflow the alarm due time)',
      );
    }
    return seconds;
  }

  /** The current round's children outputs, merged (sorted, last-key-wins). */
  function mergeChildOutputs(c: Container, state: RunState): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const ch of [...c.children].sort()) {
      const co = state.outputs[ch];
      if (co !== undefined) for (const k of Object.keys(co).sort()) out[k] = co[k];
    }
    return out;
  }

  /**
   * A container's projected outputs at exit. A `loop`/`stage` projects the LAST
   * round's merged child outputs. A `foreach` (#4 A4) instead projects the
   * order-stable aggregate `{ results }` — the per-item accumulator on its
   * `ContainerRunState` — on BOTH success (every item) and failure (the items
   * completed before the failing one). `results` is index-aligned with `items`;
   * `[]` for a zero-item foreach.
   */
  function projectContainerOutputs(c: Container, state: RunState): Record<string, unknown> {
    if (c.kind === 'foreach') return { results: state.containers[c.id]?.results ?? [] };
    return mergeChildOutputs(c, state);
  }

  /**
   * Terminate a container: set status + project outputs (also into `outputs`).
   * `reason` (observability) records WHY it terminated on a failure — `capped`
   * (loop hit maxRounds), `child_failed:<id>` (unhandled child failure),
   * `exitWhen_error` (the exit expression threw), `no_progress` (an empty loop
   * body) or `no_exit_condition` (a loop with neither exitWhen nor maxRounds).
   * Omitted on a clean success.
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

  /**
   * #4 A17 — ABANDON a timed-out loop's still-live children: flip each NON-terminal
   * child to terminal `skipped` (clearing its attempt), so a late result for its
   * in-flight dispatch folds to a benign no-op. Deliberately NOT `resetNodes`
   * (→ `pending`): a late `node.succeeded`/`node.failed` for a `pending` node is
   * treated by `onSucceeded`/`onFailed` as an IMPOSSIBLE log (never-dispatched →
   * `finishRun{invalid_event}`), which would spuriously FAIL the whole run when the
   * loop's outer failure edge is handled and the run keeps going. A TERMINAL status
   * makes the same late event a "duplicate/stale terminal" no-op instead. Terminal
   * children are left as-is (a child that genuinely succeeded this round keeps its
   * result for the loop's partial output projection). `skipped` is the honest
   * status: the loop timed out, so these children were abandoned mid-flight, not
   * failed. Their in-flight executor work is not cancelled (no cancellation seam);
   * an `external_wait_pending` child's correlation row/expiry alarm are likewise
   * left to the existing orphan-settle sweep (#580) — the status flip already makes
   * a late callback/expiry fold a no-op.
   */
  function abandonLiveChildren(state: RunState, ids: string[]): RunState {
    let nodes = state.nodes;
    for (const id of ids) {
      const ns = nodes[id];
      if (ns === undefined || TERMINAL_NODE.has(ns.status)) continue;
      if (nodes === state.nodes) nodes = { ...nodes };
      nodes[id] = { ...ns, status: 'skipped', currentAttemptId: undefined };
    }
    return nodes === state.nodes ? state : { ...state, nodes };
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
   * #4 A4 — enter a `foreach`: evaluate `items` ONCE and snapshot it onto
   * `ContainerRunState.items` (so the per-item `${item}` binding and the `results`
   * index are stable for the whole lifetime). Then either:
   *   - EMPTY items → exit `success` immediately with `{results:[]}`; the body runs
   *     ZERO times (a foreach over nothing is a success, not a stall); or
   *   - non-empty → mark `active` with an empty `results` accumulator, so item 0's
   *     children dispatch bound to `${item}` = items[0].
   * An items-eval throw (bad expr / non-array) terminalizes the run `invalid_event`
   * via `Step.finish` — the same verdict a dispatch prep-throw reaches, plumbed
   * through settle's enter loop (which otherwise has no finish channel).
   */
  function enterForeachStep(state: RunState, c: Container, diagnostics: string[]): Step {
    let items: unknown[];
    try {
      items = evalForeachItems(c, state);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      diagnostics.push(`container '${c.id}' items failed: ${msg}`);
      return {
        state,
        changed: false,
        finish: { type: 'finishRun', outcome: 'failure', reason: 'invalid_event' },
      };
    }
    if (items.length === 0) {
      const seeded = withContainer(state, c.id, { items, results: [] });
      return { state: exitContainer(seeded, c, 'success'), changed: true };
    }
    return {
      state: withContainer(state, c.id, { status: 'active', items, results: [] }),
      changed: true,
    };
  }

  /**
   * Reset a set of nodes to `pending` and CLEAR their `outputs` (a fresh loop
   * round recomputes them). `attempts` is kept MONOTONIC so a fresh dispatch
   * mints a NEW attemptId — a stale result from the prior round can never fold.
   *
   * `retries` IS cleared, and the split from `attempts` is the point (F2b): each
   * loop round is a fresh execution of the node and gets its own retry budget,
   * while attempt-ids keep marching so a prior round's result can never fold.
   * Keying eligibility on `attempts` alone would let BOUNCES silently spend the
   * operator's retries — see `NodeRunState.retries`.
   *
   * A `retry_pending` node caught in a reset is reset like any other (§A.6): its
   * armed alarm then fires against a node that is no longer held, and both the
   * clock's freshness check and `onRetryDue`'s own guard drop it.
   */
  function resetNodes(state: RunState, ids: string[]): RunState {
    let nodes = state.nodes;
    let outputs = state.outputs;
    let touched = false;
    for (const id of ids) {
      const ns = nodes[id];
      if (ns === undefined) continue;
      if (nodes === state.nodes) nodes = { ...nodes };
      nodes[id] = { ...ns, status: 'pending', currentAttemptId: undefined, retries: 0 };
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
        const cc = containerById.get(id);
        if (cc !== undefined) {
          const cs = state.containers[id]!;
          if (cs.status !== 'pending') continue;
          const r = computeReadiness(topIncoming.get(id)!, containerJoin(cc), state);
          if (r === 'ready') {
            if (cc.kind === 'foreach') {
              // Foreach entry resolves `items` and may finish (bad items →
              // invalid_event) or exit immediately (zero items → success), so it
              // needs the `Step.finish` channel `enterContainer` lacks.
              const step = enterForeachStep(state, cc, diagnostics);
              if (step.finish) return { state: step.state, commands: [step.finish], diagnostics };
              state = step.state;
              changed = true;
            } else {
              state = enterContainer(state, id);
              // #4 A17 — a `loop` with a wall-clock `timeout` arms its durable
              // safety alarm the moment it goes `active`. Emitted HERE (the
              // pending→active transition, guarded above) so it fires EXACTLY once
              // per container lifetime — re-rounds keep the container `active` and
              // never re-enter, so the bound is the loop's TOTAL wall-clock, not
              // per-round. Loop-only: a `stage`/`foreach` does not re-round, so a
              // timeout is meaningless (validateDoc refuses it there). The
              // reducer's PURE half is emitting the resolved static `seconds`; the
              // driver decides WHEN (`now + seconds*1000`) and stays the sole clock
              // reader, exactly as `scheduleWait` does.
              if (cc.kind === 'loop' && cc.timeout !== undefined) {
                commands.push({
                  type: 'scheduleContainerTimeout',
                  containerId: id,
                  seconds: cc.timeout,
                });
              }
              changed = true;
            }
          } else if (r === 'skipped') {
            noteDeadBranchOnSkip(id, topIncoming.get(id)!, state, diagnostics);
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
    } else if (!Object.values(state.nodes).some((ns) => awaitsExternalEvent(ns.status))) {
      // #491 — THE STALLED BACKSTOP. The walk has reached its fixpoint with the
      // run non-terminal, and no node anywhere awaits an event. Nothing can ever
      // change again: `pending` resolves only via this walk, which just had its
      // say. So the run can NEVER finish. Terminalize it rather than leave it
      // wedged `running` forever, holding a concurrency slot until an operator
      // notices. What lands in the LOG is the durable `run.finished` below; the
      // diagnostic naming the entities lands in the `run_diagnostics` sink (#497
      // — `recordRunDiagnostics` at every fold site), readable at
      // `GET /api/runs/:id/diagnostics`. Both halves of #491 are now observable:
      // the run's terminal `reason:'stalled'` says it could never finish, and
      // `stalledEntities` says WHICH entities wedged it.
      //
      // `else if`, NOT `if`, and that is a correctness requirement rather than
      // style: a forward cycle does NOT imply a stall. The joint F1b/F2b spec
      // (§P4) probes a SKIP-PROPAGATED cycle whose skip enters from outside, so
      // every node terminalizes without running and `allTopLevelTerminal` holds
      // — a run that legitimately SUCCEEDS. As a bare `if` this would append a
      // second, contradictory `finishRun{failure}` after that success, which the
      // driver's pump would silently swallow (it folds the first terminal and
      // breaks). Pinned in `stalled-backstop.test.ts`.
      //
      // CONSERVATIVE BY DESIGN. Any node awaiting an event vetoes the verdict,
      // even one on an unrelated branch, so the stall is DELAYED until the last
      // in-flight node resolves. That costs a doomed run some wall-clock; the
      // alternative — firing while something is still out there — tears down a
      // HEALTHY run, which is far worse than the hang this replaces. A false
      // negative is today's behaviour; a false positive is data loss with extra
      // steps.
      //
      // WHAT THIS DOES NOT COVER, stated because it looks like a gap: a crash
      // between F2b's HOLD becoming durable and its alarm being armed leaves a
      // `retry_pending` node with no alarm to fire. This backstop deliberately
      // does not fire there (`retry_pending` awaits an event, and a PURE reducer
      // cannot read the alarm table to learn the row is missing). That is
      // `reconcile.ts`'s `recoverHeld`, at boot, by design. This covers
      // READINESS deadlock; alarm liveness is owned elsewhere.
      diagnostics.push(
        `run stalled: no entity can become ready and nothing is awaiting an event, so the ` +
          `run can never finish — never-terminal: {${stalledEntitiesLabel(state)}}. Terminalized as ` +
          `failure{reason:'stalled'} rather than wedged 'running' forever. The usual cause is ` +
          `a forward cycle, which validateDoc rejects — but the write path only began ` +
          `enforcing that at #444, and rows written before it were never validated.`,
      );
      commands.push({ type: 'finishRun', outcome: 'failure', reason: 'stalled' });
    }
    return { state, commands, diagnostics };
  }

  /**
   * The entities a stalled run is stuck on. It must name the things that can
   * actually never terminalize, and nothing else.
   *
   * WHERE THIS GOES: the `run_diagnostics` sink (#497). Every production caller
   * of `reduce` now records its fold's diagnostics there — `appendAndFold`, or a
   * hand-paired `recordRunDiagnostics` where the append and fold must be split
   * (`driver.ts`, `reconcile.ts`, `retry-alarm.ts`) — readable at
   * `GET /api/runs/:id/diagnostics`. This closed the systemic gap for EVERY
   * `docDefects` report (#480's ignored edge, #487's ghost child), not just this
   * one. So both halves of #491 are operator-visible: the DURABLE
   * `run.finished{reason:'stalled'}` says the run could never finish, and this
   * says WHICH entities wedged it.
   *
   * The diagnostic is NOT an engine event, deliberately: it is a DERIVATION of
   * (immutable doc + log), and putting a derivation in the event log would
   * re-fold every bound log (#443) and double-count on replay. Off-log, keyed by
   * `(runId, seq, phase, ordinal)` so a re-derivation is idempotent.
   *
   * Top-level entities carry the verdict, but naming only them is useless for a
   * container: a reader would see `c1` and learn nothing about WHICH of its
   * children deadlocked. So an ACTIVE container contributes its non-terminal
   * children too.
   *
   * A TERMINAL container's children are deliberately excluded. `settle` marks a
   * container `skipped` without touching its children (and `exitContainer` does
   * not either), so they sit `pending` for the life of the run — harmless, but
   * they are not stuck on anything and naming them would point the reader at an
   * innocent bystander.
   *
   * The `Set` DEDUPES defensively. Since #492 that is belt-and-suspenders rather
   * than load-bearing: `childToContainer` is now FIRST-wins and a duplicate child
   * is neutralized out of every non-owning container's body (`containers` above),
   * so a node appears in exactly ONE container's `children` and can no longer be
   * named twice by two active containers. It is kept anyway — this is a REPORTER
   * over a doc the write gate never validated, and describing what it finds
   * without assuming well-formedness is cheaper to keep than to reason about
   * removing if that neutralization ever changes.
   *
   * CAPPED for the same reason `run.started` loops over `docDefects` instead of
   * spreading them: `children` has no schema max and a pre-#444-gate row was
   * never validated, so the count is attacker-shaped. Truncation is stated, never
   * silent — an absent fact must not be manufactured as "that was all of them"
   * (the F13a/#473 rule).
   */
  function stalledEntities(state: RunState): string[] {
    const stuck = new Set(sortedTopEntities.filter((id) => endpointOutcome(id, state) === null));
    for (const cid of [...containerIds].sort()) {
      if (state.containers[cid]!.status !== 'active') continue;
      for (const ch of [...containerById.get(cid)!.children].sort()) {
        if (!TERMINAL_NODE.has(state.nodes[ch]!.status)) stuck.add(ch);
      }
    }
    return [...stuck];
  }

  /** How many stuck ids the stall diagnostic names before truncating. */
  const STALL_NAME_CAP = 50;

  /** The stuck set as a diagnostic fragment: deduped, capped, honestly truncated. */
  function stalledEntitiesLabel(state: RunState): string {
    const stuck = stalledEntities(state);
    const named = stuck.slice(0, STALL_NAME_CAP).join(', ');
    const rest = stuck.length - STALL_NAME_CAP;
    return rest > 0 ? `${named}, …and ${rest} more` : named;
  }

  // --- per-event reducers ---------------------------------------------------

  // #5 S12 — fold the durable fire-time trigger context into the PRE-`run.started`
  // seed. It must land while the run is still `pending` (the driver appends it
  // immediately before `run.started`); a `run.triggerContext` arriving after the
  // run has started is an impossible log and folds to a no-op + diagnostic rather
  // than mutating a live run's identity.
  function onRunTriggerContext(
    state: RunState,
    event: Extract<EngineEvent, { type: 'run.triggerContext' }>,
    diagnostics: string[],
  ): ReduceResult {
    if (state.status !== 'pending') {
      // Accurate for EVERY non-pending status — the run may have started,
      // finished, failed, or been interrupted; the seed belongs before any of
      // them, so name the actual status rather than assuming "already started".
      diagnostics.push(
        `impossible run.triggerContext: the run is no longer pending (status: ${state.status})`,
      );
      return { state, commands: [], diagnostics };
    }
    // A SECOND seed on a still-pending run is an impossible log (the driver
    // appends exactly one, before `run.started`). The FIRST wins — overwriting
    // would let a malformed log silently rewrite the run's identity — and the
    // divergence is reported, mirroring `onRunStarted`'s already-started guard.
    if (state.triggerContext !== null) {
      diagnostics.push('impossible run.triggerContext: the run is already seeded');
      return { state, commands: [], diagnostics };
    }
    return {
      state: {
        ...state,
        // Establish the run's identity at SEED time (the seed is its first event).
        // Until now `runId` was only set by `run.started`; carrying it here lets
        // the pre-start `run.interrupted` path below make a real identity check,
        // and `onRunStarted` re-sets the same value (single-run log) so nothing
        // downstream changes.
        runId: event.runId,
        triggerContext: {
          triggerId: event.triggerId,
          scheduledTime: event.scheduledTime ?? null,
          body: event.body ?? null,
        },
      },
      commands: [],
      diagnostics,
    };
  }

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
    // #480/#487/#488: say so when the bind voided something the author wrote.
    // Same reasoning the other bind-time diagnostics follow, and the same
    // conclusion:
    // `validateDoc` reports these shapes and the write path now refuses them
    // (#444), but rows written before that gate were never validated, so such a
    // doc still reaches the reducer and this stays the ONLY thing that makes the
    // neutralization visible. Without it the operator sees a run behave nothing
    // like the graph they authored, with no hint why. Emitted once per run,
    // after the already-started guard.
    // A LOOP, not `push(...docDefects)`: a spread passes one argument per element
    // and blows the stack (`RangeError`) somewhere past ~100k of them. `children`
    // has no schema max, and a pre-#444-gate row was never validated, so the
    // count is
    // attacker-shaped, and the same standard the iterative walks in this file are
    // held to applies — a `RangeError` out of the PURE reducer kills the pump.
    for (const d of docDefects) diagnostics.push(d);
    const nodes: Record<string, NodeRunState> = {};
    for (const id of nodeIds) nodes[id] = { status: 'pending', attempts: 0, retries: 0 };
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
      // #5 S3 — a freshly-started run is `running`, never parked; stated
      // explicitly like `branches` because this literal is rebuilt from scratch
      // (no `...state` spread), and a missing field would leave it `undefined`.
      waitingReason: null,
      nodes,
      outputs: {},
      containers: containerStates,
      bounces: {},
      // #4 A0 — rebuilt from scratch here (no `...state` spread), so it must be
      // stated explicitly like every sibling; missing it leaves `branches`
      // `undefined` and `edgeState`'s `state.branches[from]` throws OUT of the
      // pure reducer (the #487 fail-open this whole file guards against).
      branches: {},
      sessions: {},
      // Carried across the started transition — the `run.triggerContext` seed
      // (#5 S12) folds into the `pending` state BEFORE this event, and rebuilding
      // `RunState` from scratch here would silently drop it, breaking
      // `${trigger.*}` for every node dispatched by the settle below.
      triggerContext: state.triggerContext,
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

  /**
   * #4 A0/A1/A2 — fold a control node's branch decision (`condition.evaluated` for
   * an `if`, `switch.evaluated` for a `switch`): the node chose a business branch.
   * The two events are IDENTICAL in shape and fold identically, so ONE handler
   * serves both (the event type is preserved in the log only for observability).
   * Same shape as `onSucceeded` (a control node reaches terminal `success` the
   * same way a dispatched node does, just via a different accepting event): the
   * node is `ready` awaiting exactly this event, so record BOTH the terminal
   * `success` AND the chosen `branch` label, then `settle` so `edgeState` routes
   * the taken arm. A stale `attemptId` (a pre-restart evaluation) is ignored; a
   * `pending` node is impossible (nothing evaluated it); the other statuses are
   * unreachable for a control node (it is never dispatched/waiting/retrying) but
   * carry a defined diagnostic no-op for parity with `onSucceeded`.
   */
  function onControlBranchEvaluated(
    state: RunState,
    event: Extract<EngineEvent, { type: 'condition.evaluated' | 'switch.evaluated' }>,
    diagnostics: string[],
  ): ReduceResult {
    const ns = state.nodes[event.nodeId];
    if (ns === undefined) return { state, commands: [], diagnostics };
    if (ns.status === 'ready') {
      if (event.attemptId !== ns.currentAttemptId) {
        return { state, commands: [], diagnostics };
      }
      let next = withNode(state, event.nodeId, { status: 'success' });
      next = { ...next, branches: { ...next.branches, [event.nodeId]: event.branch } };
      return settle(next, diagnostics);
    }
    if (ns.status === 'pending') {
      diagnostics.push(`impossible ${event.type} for never-evaluated node '${event.nodeId}'`);
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
      `${event.type} for node '${event.nodeId}' in unexpected status '${ns.status}'`,
    );
    return { state, commands: [], diagnostics };
  }

  /**
   * F2b (D4) — is this failure retry-eligible? The reducer's whole half of the
   * retry decision, and deliberately the smallest possible read: the failure's
   * `kind` (F0), the node's `retries` so far, and `policy.retry` from the
   * IMMUTABLE bound version. No clock, no driver, no mutable row — so it is
   * replay-stable by construction.
   *
   * `permanent`/`cancelled` NEVER retry (D4). This couples `settle`'s notion of
   * a run-ending failure to retry POLICY, which #472 flagged; that coupling is
   * intrinsic to the HOLD the operator chose, and it is bounded to exactly these
   * two reads.
   */
  function retryEligible(node: Node, ns: NodeRunState, kind: FailureKind): boolean {
    if (kind !== 'transient') return false;
    // Absent and explicit-0 are read DISTINCTLY and not normalized (`?? 0` would
    // erase the difference). Both mean 0 today — no catalog/global default
    // exists — but F2a's schema requires the distinction survive to F13b, where
    // absent must resolve to THE DEFAULT while an explicit 0 still means
    // "never retry this node". Keeping the read shaped like the eventual rule is
    // what stops that from being a silent behaviour change later.
    const declared = node.policy?.retry;
    const budget = declared === undefined ? 0 : declared;
    return ns.retries < budget;
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
      if (retryEligible(nodeById.get(event.nodeId)!, ns, event.kind)) {
        // The HOLD (#472, §A). Fold to a NON-terminal status and ask the driver
        // to arm the alarm. Deliberately does NOT call `settle`: the node is not
        // terminal, so nothing new can have become ready or skipped, and the run
        // cannot finish — `settle` would be a no-op walk. The node leaves this
        // state ONLY via `node.retryDue` (or a back-edge reset).
        return {
          state: withNode(state, event.nodeId, { status: 'retry_pending' }),
          commands: [
            {
              type: 'scheduleRetry',
              nodeId: event.nodeId,
              failedAttemptId: event.attemptId,
              // #2 L7 — thread the provider's `Retry-After` hint (frozen on this
              // durable event) to the driver, which prefers it over the static
              // `policy.retryIntervalSeconds`. Omitted when absent (→ policy
              // interval). Copying an already-frozen number keeps the reducer
              // clock-free and replay-deterministic.
              ...(event.retryAfterSeconds !== undefined
                ? { retryAfterSeconds: event.retryAfterSeconds }
                : {}),
            },
          ],
          diagnostics,
        };
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

  /**
   * `node.retryDue` (F2b/F2c): the alarm fired — re-dispatch a HELD node under a
   * NEW attempt.
   *
   * Guarded on `retry_pending`, NOT on `LIVE_NODE`, and that is a decision
   * rather than an accident (§A.4). Widening `LIVE_NODE` to include
   * `retry_pending` would have silently let a late `node.succeeded` fold onto a
   * held node in `onSucceeded`/`onFailed`; a held node belongs to no existing
   * guard set (it is neither `ready`/`dispatched` nor `waiting`), which is
   * exactly the property that makes this safe.
   *
   * This is the ONE site that consumes the policy's retry budget (`retries + 1`)
   * — see `NodeRunState.retries` for why that is not `attempts`.
   */
  function onRetryDue(
    state: RunState,
    event: Extract<EngineEvent, { type: 'node.retryDue' }>,
    diagnostics: string[],
  ): ReduceResult {
    const ns = state.nodes[event.nodeId];
    if (ns === undefined) return { state, commands: [], diagnostics };
    if (ns.status !== 'retry_pending') {
      // At-least-once delivery + a back-edge reset both reach here legitimately:
      // a duplicate alarm for a node whose retry already dispatched, or one whose
      // body was reset to `pending` by a loop round. The clock's handler
      // suppresses both before appending, so this is the second layer (spec #5:
      // "at-least-once + an idempotent fold"). A no-op, not a diagnostic — it is
      // an expected delivery, not a malformed log.
      return { state, commands: [], diagnostics };
    }
    if (event.previousAttemptId !== ns.currentAttemptId) {
      // A stale alarm naming an attempt this node has moved past.
      return { state, commands: [], diagnostics };
    }
    const attemptId = `${event.nodeId}#${ns.attempts}`;
    const next = withNode(state, event.nodeId, {
      status: 'ready',
      attempts: ns.attempts + 1,
      retries: ns.retries + 1,
      currentAttemptId: attemptId,
    });
    // No stale-output clear here, unlike `onRetryRequested` below: a
    // `retry_pending` node can ONLY have come from `onFailed`'s LIVE_NODE branch,
    // and no failure path there stores outputs (`onCallReturned` is the one
    // failure path that does, and it gates on `waiting`, which `onFailed` cannot
    // reach). `onRetryRequested` recovers a node from `ready`/`dispatched`, which
    // a `node.output` observability event cannot populate either — but it has the
    // clear, so this asymmetry is deliberate and stated rather than silent.
    let prepared: {
      preparedInput: Record<string, unknown>;
      resolvedConnectionId: string | undefined;
    };
    try {
      prepared = prepDispatch(next, nodeById.get(event.nodeId)!);
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
      commands: [dispatchNodeCommand(event.nodeId, attemptId, prepared)],
      diagnostics,
    };
  }

  /**
   * #4 A6 — fold `timer.waitScheduled`: a `wait` node's durable alarm is armed, so
   * PARK it `ready` → `wait_pending`. The `timer.*` twin of `node.retryScheduled`,
   * but NOT inert — where retry's hold was already entered by `node.failed`, a wait
   * has no prior hold event, so THIS fold is what enters it. Guarded on the node
   * being `ready` at exactly this attempt (a stale/duplicate scheduled event for a
   * node that has moved on is a no-op, mirroring `onRetryDue`). Does NOT `settle`:
   * the node is now parked, nothing downstream can advance until `timer.due`.
   */
  function onWaitScheduled(
    state: RunState,
    event: Extract<EngineEvent, { type: 'timer.waitScheduled' }>,
    diagnostics: string[],
  ): ReduceResult {
    const ns = state.nodes[event.nodeId];
    if (ns === undefined) return { state, commands: [], diagnostics };
    if (ns.status !== 'ready' || ns.currentAttemptId !== event.attemptId) {
      // At-least-once + a back-edge reset both reach here legitimately (a duplicate
      // scheduled event, or a node whose round reset it) — a no-op, not a defect.
      return { state, commands: [], diagnostics };
    }
    return {
      state: withNode(state, event.nodeId, { status: 'wait_pending' }),
      commands: [],
      diagnostics,
    };
  }

  /**
   * #4 A6 — fold `timer.due`: the parked `wait` node's alarm fired, so COMPLETE it
   * (`wait_pending` → `success`, empty outputs — a wait produces no data). The
   * `timer.*` twin of `onRetryDue`, but where retry re-dispatches, a wait SUCCEEDS
   * (there is nothing to re-run), reaching terminal `success` the same way
   * `onSucceeded` does and then `settle`-ing so downstream edges route. Guarded on
   * `wait_pending` at the parked attempt (NOT `LIVE_NODE`, exactly as `onRetryDue`
   * guards on `retry_pending`): an at-least-once redelivery, or an alarm naming an
   * attempt the node has moved past, is a no-op. The clock's handler suppresses both
   * before appending — this is the second layer (spec #5: "at-least-once + an
   * idempotent fold").
   */
  function onWaitDue(
    state: RunState,
    event: Extract<EngineEvent, { type: 'timer.due' }>,
    diagnostics: string[],
  ): ReduceResult {
    const ns = state.nodes[event.nodeId];
    if (ns === undefined) return { state, commands: [], diagnostics };
    if (ns.status !== 'wait_pending' || ns.currentAttemptId !== event.previousAttemptId) {
      return { state, commands: [], diagnostics };
    }
    return settle(withNode(state, event.nodeId, { status: 'success' }), diagnostics);
  }

  /**
   * #4 A17 — fold `container.timeoutScheduled`: a `loop`'s wall-clock timeout alarm
   * is armed, so STAMP `timeoutDueAt` onto its run-state. The container twin of
   * `onWaitScheduled`, but it PARKS NOTHING (the loop stays `active`, its children
   * keep running) — the stamp is the operator/audit fact AND the crash-recovery
   * marker `onResumed` reads. Like `onWaitScheduled` it does NOT `settle`: nothing
   * downstream changed, and the arm command was already emitted at enter. Guarded
   * on the container being `active` at fold time — an at-least-once redelivery, or
   * a scheduled event for a loop that already exited, is a no-op (never resurrect a
   * terminal container's marker).
   */
  function onContainerTimeoutScheduled(
    state: RunState,
    event: Extract<EngineEvent, { type: 'container.timeoutScheduled' }>,
    diagnostics: string[],
  ): ReduceResult {
    const cs = state.containers[event.containerId];
    if (cs === undefined || cs.status !== 'active') {
      return { state, commands: [], diagnostics };
    }
    return {
      state: withContainer(state, event.containerId, { timeoutDueAt: event.dueAt }),
      commands: [],
      diagnostics,
    };
  }

  /**
   * #4 A17 — fold `container.timedOut`: a `loop`'s wall-clock timeout ELAPSED. If
   * the loop is still `active`, NEUTRALIZE its still-live children then FAIL it
   * (`active` → `failure`, reason `timeout`) and `settle` so its outer failure edge
   * routes. The container twin of `onWaitDue`, but it FAILS rather than succeeds.
   *
   * The `abandonLiveChildren` call is load-bearing and UNIQUE to this exit: every
   * OTHER container-failure path (`capped`/`child_failed`/`exitWhen_error`/
   * `no_progress`) is only reached by `stepContainers` AFTER every child is
   * terminal, so there is nothing live to neutralize. A timeout fires while
   * children may be `dispatched` (a running LLM/HTTP call) or `external_wait_pending`
   * (the canonical human-loop case). `exitContainer` alone does not touch children,
   * so without the neutralization a late `node.succeeded`/`externalWait.completed`
   * would still fold — either re-animating a node UNDER an already-exited container,
   * or (if it landed on a `pending` reset) being read as an IMPOSSIBLE log and
   * FAILING the whole run `invalid_event`. Both are real defects once the loop's
   * outer failure edge is HANDLED (the ADF generic-error pattern this reducer
   * drains) and the run keeps running. Flipping the live children to terminal
   * `skipped` makes any late event a benign no-op — see `abandonLiveChildren`. The
   * container is now terminal, so `settle` never re-visits those children.
   *
   * Guarded on `active`: an at-least-once redelivery, or a timeout for a loop that
   * already exited via `exitWhen`/`maxRounds`/a child failure BEFORE the alarm
   * fired, folds as a no-op (the second layer behind the handler's `active` guard).
   */
  function onContainerTimedOut(
    state: RunState,
    event: Extract<EngineEvent, { type: 'container.timedOut' }>,
    diagnostics: string[],
  ): ReduceResult {
    const cs = state.containers[event.containerId];
    if (cs === undefined || cs.status !== 'active') {
      return { state, commands: [], diagnostics };
    }
    const c = containerById.get(event.containerId);
    if (c === undefined) return { state, commands: [], diagnostics };
    diagnostics.push(`container '${c.id}' timed out (wall-clock ${c.timeout}s)`);
    const neutralized = abandonLiveChildren(state, c.children);
    return settle(exitContainer(neutralized, c, 'failure', 'timeout'), diagnostics);
  }

  /**
   * #4 A13 — fold `externalWait.created`: a `webhook` node's expiry alarm +
   * correlation row are armed, so PARK it `ready` → `external_wait_pending`. The
   * external-wait twin of `onWaitScheduled` (and NOT inert, for the same reason: a
   * webhook has no prior hold event). Guarded on the node being `ready` at exactly
   * this attempt (a stale/duplicate created event for a node that has moved on — an
   * at-least-once re-arm, or a back-edge reset — is a no-op). Does NOT `settle`: the
   * node is now parked, nothing downstream can advance until the callback/expiry.
   */
  function onExternalWaitCreated(
    state: RunState,
    event: Extract<EngineEvent, { type: 'externalWait.created' }>,
    diagnostics: string[],
  ): ReduceResult {
    const ns = state.nodes[event.nodeId];
    if (ns === undefined) return { state, commands: [], diagnostics };
    if (ns.status !== 'ready' || ns.currentAttemptId !== event.attemptId) {
      return { state, commands: [], diagnostics };
    }
    return {
      state: withNode(state, event.nodeId, { status: 'external_wait_pending' }),
      commands: [],
      diagnostics,
    };
  }

  /**
   * #4 A13/A16 — fold `externalWait.completed`: the parked `webhook` node's inbound
   * callback arrived, so COMPLETE it (`external_wait_pending` → `success`). The
   * external-wait twin of `onWaitDue`: where a wait completes on a `timer.due`, a
   * webhook completes on an HTTP-route append, but both SUCCEED and `settle` so
   * downstream `success` edges route. Guarded on `external_wait_pending` at the
   * parked attempt (NOT `LIVE_NODE`, exactly as `onWaitDue`/`onRetryDue` guard): an
   * at-least-once redelivery, or a completion naming an attempt the node has moved
   * past, is a no-op. The route's own row-status guard is the first layer; this is
   * the second (the pure fold).
   *
   * #4 A16 — the callback body's TYPED outputs ride `event.outputs` (validated +
   * declared-key filtered at the HTTP boundary; `undefined` for a pre-A16 event or
   * a webhook with no declared contract → `{}`, the A13 empty-outputs behaviour).
   * This fold RE-FILTERS through `storeOutputs` against the immutable version's
   * contract — NEVER failing the node (unlike `onSucceeded`, whose fail branch
   * would defeat A16's stay-parked-on-malformed semantic; the boundary already
   * rejected a bad payload) — so a hand-crafted event cannot seed an undeclared
   * refable key. A corrupt (`invalid`) contract on a pre-F13a row folds as `absent`
   * (store the already-filtered `{}`), never blocking the completion.
   */
  function onExternalWaitCompleted(
    state: RunState,
    event: Extract<EngineEvent, { type: 'externalWait.completed' }>,
    diagnostics: string[],
  ): ReduceResult {
    const ns = state.nodes[event.nodeId];
    if (ns === undefined) return { state, commands: [], diagnostics };
    if (ns.status !== 'external_wait_pending' || ns.currentAttemptId !== event.previousAttemptId) {
      return { state, commands: [], diagnostics };
    }
    const node = nodeById.get(event.nodeId)!;
    const contract = outputContract(node);
    // A DECLARED contract with an outputs-carrying (A16) event → filter to declared
    // keys (never trust the event's key set). Everything else → store `{}`:
    //  - a PRE-A16 event has no `outputs` field → `{}` (its A13 empty-outputs
    //    behaviour on replay; NOT `storeOutputs(contract, {})`, which would
    //    manufacture `{name: undefined}` for each declared key);
    //  - ABSENT/INVALID → `{}`: nothing is refable, and — unlike `onSucceeded`'s
    //    trusted-executor `storeOutputs(absent, …)` whole-payload branch — an
    //    inbound callback body is UNTRUSTED, so a hand-crafted event must not seed
    //    projected state with undeclared keys.
    // This mirrors the HTTP boundary's `checkInboundOutputs` so the two stay in
    // lock-step.
    const stored =
      event.outputs !== undefined && contract.kind === 'declared'
        ? storeOutputs(contract, event.outputs)
        : {};
    let next = withNode(state, event.nodeId, { status: 'success' });
    next = { ...next, outputs: { ...next.outputs, [event.nodeId]: stored } };
    return settle(next, diagnostics);
  }

  /**
   * #4 A13 — fold `externalWait.expired`: the parked `webhook` node's expiry alarm
   * fired before any callback, so FAIL it (`external_wait_pending` → `failure`) then
   * `settle` so its `failure` edge routes the timeout/default path (or the run fails
   * blaming it). Mirrors `onFailed`'s terminal branch — a bare status flip to
   * `failure` + `settle` IS the failure-recording path (`onFailed` records the same
   * way, the kind/code riding the EVENT, not the projection). Distinct from a
   * `node.failed` because an `external_wait_pending` node is NOT `LIVE_NODE`, so
   * `onFailed` (which guards on `LIVE_NODE`) cannot reach it. A timeout is a
   * PERMANENT failure by construction — this path never consults `policy.retry`, so
   * an expiry is never re-parked (the `failure` edge is the configurable escape
   * hatch, matching A7 `fail`'s permanence). Guarded on `external_wait_pending` at
   * the parked attempt: an at-least-once redelivery, or an expiry naming an attempt
   * the node has moved past (already completed / back-edge reset), is a no-op.
   */
  function onExternalWaitExpired(
    state: RunState,
    event: Extract<EngineEvent, { type: 'externalWait.expired' }>,
    diagnostics: string[],
  ): ReduceResult {
    const ns = state.nodes[event.nodeId];
    if (ns === undefined) return { state, commands: [], diagnostics };
    if (ns.status !== 'external_wait_pending' || ns.currentAttemptId !== event.previousAttemptId) {
      return { state, commands: [], diagnostics };
    }
    return settle(withNode(state, event.nodeId, { status: 'failure' }), diagnostics);
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
    let prepared: {
      preparedInput: Record<string, unknown>;
      resolvedConnectionId: string | undefined;
    };
    try {
      prepared = prepDispatch(next, nodeById.get(event.nodeId)!);
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
      commands: [dispatchNodeCommand(event.nodeId, attemptId, prepared)],
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
   * A `retry_pending` node is DELIBERATELY absent from mechanism (1), and this
   * is the one place that omission looks like a bug (§A.5). It matches neither
   * re-emit, so a held run recovers NOTHING here: `settle` cannot finish it
   * (held ⇒ non-terminal), and `reconcile`'s `dispatchedNodes()` does not select
   * it either. Its recovery path is S1's DURABLE ALARM ROW, which survived the
   * crash and re-fires on its own. That is why F2b hard-depends on F2c/S1:
   * without a live alarm clock a held run stays `running` forever.
   *
   * The omission is correct for a reason this docblock USED TO GET WRONG, and the
   * distinction matters to anyone editing here: it is NOT that re-deriving a
   * `scheduleRetry` would double-arm (`armWakeup` is upsert-if-absent and returns
   * the existing row whatever its status, so re-arming is free — that premise was
   * false and was inherited unchecked into five places). It is that this function
   * is PURE and cannot read the alarm table, so it cannot make the only check
   * that matters: does a row actually EXIST? A crash between the HOLD becoming
   * durable and the arm landing leaves a held node with NO alarm, and only a
   * caller that can SEE the table can tell that apart from a healthy hold.
   * `reconcile.ts` makes exactly that check and re-arms when the row is gone.
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
    // The `run.resumed` fold's own guards do not apply when `resume()` calls this
    // directly, so re-state the one that matters: a run that is not `running` has
    // nothing to re-derive, and re-emitting a dispatch for a settled run would
    // re-execute its side effects. `driveRun` already refuses a terminal LOG
    // (#443); this is the engine-side backstop for a caller that did not.
    if (state.status !== 'running') return { state, commands: [], diagnostics };

    const commands: EngineCommand[] = [];
    for (const id of [...nodeIds].sort()) {
      const ns = state.nodes[id]!;
      if (ns.currentAttemptId === undefined) continue;
      const node = nodeById.get(id)!;
      if (ns.status === 'ready') {
        const controlEvent = controlBranchEvent(node.type);
        if (controlEvent !== undefined) {
          // #4 A1/A2 crash recovery: a control `if`/`switch` folds to `ready` after
          // `tryDispatchNode` pushed `evaluateControl`, but `projectRunState` keeps
          // STATE, not COMMANDS — a crash between the predecessor's durable event
          // and `condition.evaluated`/`switch.evaluated` re-derives the node
          // `ready` with its command lost, and without this fork nothing re-emits
          // it, so the run hangs `ready` forever (the `waiting && node.call` branch
          // below re-emits `startChild` for the exact same reason). Recompute the
          // branch PURELY (deterministic over the logged state) and re-emit.
          // Idempotent: same `currentAttemptId`, and a duplicate durable event
          // folds as a stale/terminal no-op. Terminalize a condition/`on` that now
          // throws, the same verdict as the dispatch-prep branch below. Passes the
          // `foreach` item (as `tryDispatchNode` does, and as the `fail`/`filter`/
          // `wait` forks below do) so a `${item}`-bearing condition/`on` in a foreach
          // body re-resolves identically on recovery rather than throwing (#569).
          let branch: string;
          try {
            branch = evalControlBranch(node, state, foreachItemOf(state, id));
          } catch (err) {
            const failed = prepFailure(state, id, err, diagnostics);
            return { state: failed.state, commands: [failed.finish], diagnostics };
          }
          commands.push({
            type: 'evaluateControl',
            nodeId: id,
            attemptId: ns.currentAttemptId,
            branch,
            event: controlEvent,
          });
          continue;
        }
        if (node.type === FAIL_ACTIVITY_TYPE) {
          // #4 A7 crash recovery: a `fail` folds to `ready` after `tryDispatchNode`
          // pushed `failNode`, but `projectRunState` keeps STATE, not COMMANDS — a
          // crash between the predecessor's durable event and `node.failed` re-derives
          // the node `ready` with its command lost, and without this fork nothing
          // re-emits it, so the run hangs `ready` forever (the same reason the
          // control-event fork above and `waiting && node.call` below re-emit).
          // Recompute the message PURELY and re-emit. Idempotent: same
          // `currentAttemptId`, and a duplicate `node.failed` folds as a
          // stale/terminal no-op. Terminalize a `message` that now throws, the same
          // verdict as the dispatch-prep branch below. Passes the `foreach` item
          // (as `tryDispatchNode` does) so a `${item}`-bearing message in a foreach
          // body re-resolves identically on recovery rather than throwing.
          let error: string;
          try {
            error = evalFailMessage(node, state, foreachItemOf(state, id));
          } catch (err) {
            const failed = prepFailure(state, id, err, diagnostics);
            return { state: failed.state, commands: [failed.finish], diagnostics };
          }
          commands.push({ type: 'failNode', nodeId: id, attemptId: ns.currentAttemptId, error });
          continue;
        }
        if (node.type === FILTER_ACTIVITY_TYPE) {
          // #4 A8 crash recovery: a `filter` folds to `ready` after `tryDispatchNode`
          // pushed `succeedControl`, but `projectRunState` keeps STATE, not COMMANDS
          // — a crash between the predecessor's durable event and `node.succeeded`
          // re-derives the node `ready` with its command lost, and without this fork
          // nothing re-emits it, so the run hangs `ready` forever (the same reason
          // the control-branch/`fail` forks above and `waiting && node.call` below
          // re-emit). Recompute the filtered outputs PURELY and re-emit. Idempotent:
          // same `currentAttemptId`, and a duplicate `node.succeeded` folds as a
          // stale/terminal no-op. Terminalize `items`/`predicate` that now throws,
          // the same verdict as the dispatch-prep branch below. Passes the `foreach`
          // item (as `tryDispatchNode` does) so a `${item}`-bearing `items` in a
          // foreach body re-resolves identically on recovery rather than throwing.
          let outputs: Record<string, unknown>;
          try {
            outputs = evalFilter(node, state, foreachItemOf(state, id));
          } catch (err) {
            const failed = prepFailure(state, id, err, diagnostics);
            return { state: failed.state, commands: [failed.finish], diagnostics };
          }
          commands.push({
            type: 'succeedControl',
            nodeId: id,
            attemptId: ns.currentAttemptId,
            outputs,
          });
          continue;
        }
        if (node.type === WAIT_ACTIVITY_TYPE) {
          // #4 A6 crash recovery: a `wait` folds to `ready` after `tryDispatchNode`
          // pushed `scheduleWait`, but `projectRunState` keeps STATE, not COMMANDS —
          // a crash between the predecessor's durable event and `timer.waitScheduled`
          // (or between the alarm arm and that append) re-derives the node `ready`
          // with its command lost, and without this fork nothing re-emits it, so the
          // run hangs `ready` forever (the same reason the control-branch/`fail`/
          // `filter` forks above and `waiting && node.call` below re-emit). Recompute
          // `seconds` PURELY and re-emit; the driver's `armWait` is idempotent by the
          // alarm's `(kind, dedupeKey)`, so a re-arm returns the existing row and
          // keeps the ORIGINAL `dueAt`. Terminalize a `seconds` that now throws, the
          // same verdict as the dispatch-prep branch below. Passes the `foreach` item
          // (as `tryDispatchNode` does) so a `${item}`-bearing `seconds` in a foreach
          // body re-resolves identically on recovery rather than throwing (#569).
          let seconds: number;
          try {
            seconds = evalWaitSeconds(node, state, foreachItemOf(state, id));
          } catch (err) {
            const failed = prepFailure(state, id, err, diagnostics);
            return { state: failed.state, commands: [failed.finish], diagnostics };
          }
          commands.push({
            type: 'scheduleWait',
            nodeId: id,
            attemptId: ns.currentAttemptId,
            seconds,
          });
          continue;
        }
        if (node.type === WEBHOOK_ACTIVITY_TYPE) {
          // #4 A13 crash recovery: a `webhook` folds to `ready` after
          // `tryDispatchNode` pushed `scheduleExternalWait`, but `projectRunState`
          // keeps STATE, not COMMANDS — a crash between the predecessor's durable
          // event and `externalWait.created` (or between the alarm/row arm and that
          // append) re-derives the node `ready` with its command lost, and without
          // this fork nothing re-emits it, so the run hangs `ready` forever (the same
          // reason the `wait`/control/`fail`/`filter` forks re-emit). Recompute
          // `timeoutSeconds` PURELY and re-emit; `armExternalWait` is idempotent by
          // the alarm's `(kind, dedupeKey)` AND the correlation row's
          // `(runId,nodeId,attemptId)` uniqueness, so a re-arm returns the existing
          // row and DETERMINISTICALLY re-derives the same token, keeping the ORIGINAL
          // `dueAt`. Terminalize a `timeoutSeconds` that now throws, the same verdict
          // as the dispatch-prep branch. Passes the `foreach` item so a
          // `${item}`-bearing `timeoutSeconds` re-resolves identically (#569).
          let timeoutSeconds: number;
          try {
            timeoutSeconds = evalWebhookTimeoutSeconds(node, state, foreachItemOf(state, id));
          } catch (err) {
            const failed = prepFailure(state, id, err, diagnostics);
            return { state: failed.state, commands: [failed.finish], diagnostics };
          }
          commands.push({
            type: 'scheduleExternalWait',
            nodeId: id,
            attemptId: ns.currentAttemptId,
            timeoutSeconds,
          });
          continue;
        }
        let prepared: {
          preparedInput: Record<string, unknown>;
          resolvedConnectionId: string | undefined;
        };
        try {
          prepared = prepDispatch(state, node);
        } catch (err) {
          // TERMINALIZE, never swallow — the same verdict `tryDispatchNode`,
          // `onRetryDue` and `onRetryRequested` all reach from a prep throw. This
          // branch alone used to `continue`, emitting nothing and leaving the node
          // `ready`: non-terminal, so `settle` could not finish the run either,
          // and the run hung `running` forever. Tolerable while resume ran once
          // per boot; `driveRun` makes this the RUNTIME path for every retry AND
          // discards `onRetryDue`'s terminalize in favour of it.
          const failed = prepFailure(state, id, err, diagnostics);
          return { state: failed.state, commands: [failed.finish], diagnostics };
        }
        commands.push(dispatchNodeCommand(id, ns.currentAttemptId, prepared));
      } else if (ns.status === 'waiting' && node.call !== undefined) {
        let pvId: string;
        let callParams: Record<string, unknown>;
        try {
          const ctx = buildCtx(state);
          // Pass the `foreach` item (as `tryDispatchNode`'s call-dispatch does) so a
          // `${item}`-bearing `pipelineVersionId`/`params` in a foreach body
          // re-resolves identically on recovery rather than throwing (#569).
          const item = foreachItemOf(state, id);
          pvId = String(substitute(node.call.pipelineVersionId, ctx, 0, item));
          callParams = substitute(node.call.params, ctx, 0, item) as Record<string, unknown>;
        } catch (err) {
          // Terminalize for the same reason as the `ready` branch above, and to
          // match `tryDispatchNode`'s own call-prep throw (`prepFailure`).
          const failed = prepFailure(state, id, err, diagnostics);
          return { state: failed.state, commands: [failed.finish], diagnostics };
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
    // #4 A17 crash recovery: a `loop`'s timeout is armed at container-enter, but
    // `projectRunState` keeps STATE, not COMMANDS — a crash in the tiny window
    // between the enter settle and the arm+`container.timeoutScheduled` append
    // re-derives the loop `active` with its arm command LOST and no `timeoutDueAt`
    // stamp, so nothing would re-arm it and the loop would run wall-clock-unbounded
    // (the exact hang A17 prevents — an `until`-loop gated on a never-arriving
    // event has NO other bound). Re-emit ONLY for an `active` loop that has a
    // `timeout` but no `timeoutDueAt` yet — i.e. the arm was genuinely lost before
    // its append. A loop that DID arm has the marker set (the `container.timeoutScheduled`
    // fold stamped it) and is skipped here, so this never double-arms a healthy loop.
    // In the recovery case there is no surviving alarm row, so the re-arm arms FRESH
    // from resume-time `now` — the timeout restarts from resume rather than preserving
    // an original `dueAt` there is none of. (This is unlike the wait/webhook NODE forks,
    // whose row usually DID commit, so their idempotent re-arm returns the existing row
    // and keeps the original dueAt — see `armWait`.) A container arm is recovered here,
    // not in `reconcile.ts`, because it hangs off the container, not a node.
    for (const cid of [...containerIds].sort()) {
      const cc = containerById.get(cid)!;
      const ccs = state.containers[cid]!;
      if (
        cc.kind === 'loop' &&
        cc.timeout !== undefined &&
        ccs.status === 'active' &&
        ccs.timeoutDueAt === undefined
      ) {
        commands.push({ type: 'scheduleContainerTimeout', containerId: cid, seconds: cc.timeout });
      }
    }
    const settled = settle(state, diagnostics);
    return { state: settled.state, commands: [...commands, ...settled.commands], diagnostics };
  }

  // --- the pure reducer (the exact 2-arg contract) --------------------------

  function reduce(state: RunState, event: EngineEvent): ReduceResult {
    const diagnostics: string[] = [];

    if (event.type === 'run.started') return onRunStarted(state, event, diagnostics);

    // #5 S12 — handled BEFORE the `pending` early-return below, because it is the
    // one non-`run.started` event that legitimately folds into a `pending` seed.
    if (event.type === 'run.triggerContext') return onRunTriggerContext(state, event, diagnostics);

    // #5 S12 — a `run.interrupted` on a PENDING run terminalizes it, exactly as it
    // does on a running run (below). The reachable case: the driver faulted
    // between the `run.triggerContext` seed and `run.started`, and the interrupt
    // cleanup appends `run.interrupted` over a lone-seed (still `pending`) log.
    // Folding it to `interrupted` keeps the PROJECTION equal to the row the
    // cleanup persists — without this the fold would no-op and the two would
    // diverge (an event-sourcing invariant break). The identity check is REAL
    // here (unlike the no-op pending fallback below): the seed established
    // `state.runId`, so a foreign run's interrupt cannot terminalize this run — it
    // falls through to the no-op. Only `run.interrupted`: a `run.finished` before
    // start is genuinely impossible and stays an ignored no-op under the guard.
    if (
      state.status === 'pending' &&
      event.type === 'run.interrupted' &&
      event.runId === state.runId
    ) {
      return { state: { ...state, status: 'interrupted' }, commands: [], diagnostics };
    }

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
        // divergence between them is a latent `invalid_event` — `settle` emits
        // `finishRun{success}` while this handler calls that same finish
        // impossible, so the run ends `failure{invalid_event}` when settle judged
        // it a success (pre-#477 it stranded at `status:'running'`, which
        // `reconcile` re-drove; since #477 the driver folds first and terminalizes
        // it inline). Either way the run's outcome contradicts settle's verdict.
        // Measured, not theorised: changing one site alone reproduces exactly that.
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
      case 'activity.metered':
        // #2 L2 — INERT (like `node.output`): a per-response metering FACT is
        // telemetry, not run state. It never enters `outputs` or `${}`, so folding
        // it cannot change semantics; it lives in the log for the L6 cost
        // projection to SUM. Captured once at dispatch, never recomputed on replay.
        return { state, commands: [], diagnostics };
      case 'activity.captured':
        // #2 L9a — INERT (like `activity.metered`): a per-response prompt/completion
        // CAPTURE FACT (shape + latency) is debugging telemetry, not run state. It
        // never enters `outputs` or `${}`, so folding it cannot change semantics;
        // it lives in the log for the Monitor run-detail. Captured once at dispatch,
        // never recomputed on replay.
        return { state, commands: [], diagnostics };
      case 'activity.agentTelemetry':
        // #2 L11a — INERT (like `activity.captured`): an `agent_task` subprocess
        // TELEMETRY FACT (exitCode + summary + latency + stdout shape) is
        // observability, not run state. It never enters `outputs` or `${}`, so
        // folding it cannot change semantics; it lives in the log for the Monitor
        // run-detail. Captured once at dispatch, never recomputed on replay.
        return { state, commands: [], diagnostics };
      case 'node.dispatched':
        return onDispatched(state, event, diagnostics);
      case 'node.succeeded':
        return onSucceeded(state, event, diagnostics);
      case 'condition.evaluated':
      case 'switch.evaluated':
        return onControlBranchEvaluated(state, event, diagnostics);
      case 'node.failed':
        return onFailed(state, event, diagnostics);
      case 'call.returned':
        return onCallReturned(state, event, diagnostics);
      case 'node.retryScheduled':
        // Inert BY DESIGN (§A.2): the durable record that the driver armed this
        // node's retry alarm, carrying the `nextAttemptAt` the log/monitor needs.
        // The node is already `retry_pending` and the reducer must not read a
        // clock, so there is nothing to fold — the state change was `onFailed`'s.
        return { state, commands: [], diagnostics };
      case 'node.retryDue':
        return onRetryDue(state, event, diagnostics);
      case 'timer.waitScheduled':
        // #4 A6 — NOT inert (unlike `node.retryScheduled`): a wait has no prior
        // hold event, so this fold is what parks the node `ready` → `wait_pending`.
        return onWaitScheduled(state, event, diagnostics);
      case 'timer.due':
        return onWaitDue(state, event, diagnostics);
      case 'container.timeoutScheduled':
        // #4 A17 — NOT inert: stamps the loop's `timeoutDueAt` (audit + the
        // crash-recovery marker `onResumed` reads). Parks nothing.
        return onContainerTimeoutScheduled(state, event, diagnostics);
      case 'container.timedOut':
        return onContainerTimedOut(state, event, diagnostics);
      case 'externalWait.created':
        // #4 A13 — NOT inert (like `timer.waitScheduled`): a webhook has no prior
        // hold event, so this fold parks the node `ready` → `external_wait_pending`.
        return onExternalWaitCreated(state, event, diagnostics);
      case 'externalWait.completed':
        return onExternalWaitCompleted(state, event, diagnostics);
      case 'externalWait.expired':
        return onExternalWaitExpired(state, event, diagnostics);
      case 'node.retryRequested':
        return onRetryRequested(state, event, diagnostics);
      case 'run.resumed':
        return onResumed(state, diagnostics);
      case 'run.waiting':
        // #5 S3 — FORWARD-ONLY: a running run parked on an external event, so it
        // becomes `waiting` and records WHY. Reached only with `status ===
        // 'running'` (the guard above ignores it on any other status), so it is
        // structurally the running→waiting edge and nothing else. No command, no
        // clock read — the run stops advancing until the event lands; the reverse
        // edge (waiting→running) ships with the PRODUCER (#5 S4/S6), where
        // `onResumed`/re-dispatch clears `waitingReason`. Nothing EMITS this event
        // yet, so a real log never reaches here this fire (F2a/L14a-style model
        // slice); the fold is exercised by unit tests and is ready for S4/S6.
        return {
          state: { ...state, status: 'waiting', waitingReason: event.reason },
          commands: [],
          diagnostics,
        };
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
      waitingReason: null,
      nodes: {},
      outputs: {},
      containers: {},
      bounces: {},
      branches: {},
      sessions: {},
      triggerContext: null,
    };
  }

  function projectRunState(events: EngineEvent[]): RunState {
    let state = seedState();
    for (const event of events) state = reduce(state, event).state;
    return state;
  }

  return {
    seedState,
    reduce,
    projectRunState,
    // The SAME function `run.resumed` folds to — one derivation, two entry
    // points, so the boot path and the drive path cannot drift apart.
    resume: (state) => onResumed(state, []),
  };
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
