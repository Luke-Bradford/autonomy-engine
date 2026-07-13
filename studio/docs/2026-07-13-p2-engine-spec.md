# P2 — the pure event-sourced engine (spec v1)

*2026-07-13. v1 folds Codex CP1. The core of autonomy-studio: a PURE,
deterministic run engine porting the prototype's pipeline semantics
(`../autonomy-engine/lib/pipeline.py`) into TypeScript. NO I/O, NO connectors, NO
executor (P3). Builds on P1 (schemas + `runs`/`run_events` tables + repo). Lives in
`packages/shared/src/engine/` (the pure reducer + `${}` language, importable by
web + server) with persistence/driver wiring in `packages/server/src/run/`.*

## The invariant (CP1-hardened): commands out, state changes only on events

- **Reducer is pure:** `reduce(state, event) → { state, commands[], diagnostics[] }`.
  No clock/random/I-O. Deterministic → fully replayable.
- **A command NEVER changes state.** The reducer emits commands (requests to the
  driver). The DRIVER performs a command, then appends the resulting **event** to
  `run_events`; only folding that event through `reduce` changes state. So a crash
  between "command emitted" and "event appended" simply re-emits the command on
  replay — no lost/duplicated work.
- **`run_events`** (append-only, P1a) is the sole source of truth; `RunState` is a
  projection = fold `reduce` over the log. The monitor (P6) is a live tail.
- **Deterministic `attemptId`:** every dispatch mints `attemptId = \`${nodeId}#${n}\``
  where `n = NodeState.attempts` (count of prior attempts, from state — pure, no
  random). Every attempt-bearing event carries its `attemptId`; **an event whose
  `attemptId` is not the node's CURRENT attempt is ignored** (a stale pre-restart
  executor result can never fold into a re-dispatched node — the CP1 correctness fix).

## Scope (P2) / non-goals

IN: the reducer + walk + the `${}` language + typed params/outputs + the RunState
projection + fold-to-fixpoint driver loop (with a STUB executor for tests) + the
boot reconciler. OUT: real activity execution / connectors / subprocess (P3),
scheduler + trigger firing (P4), spawning a `call_pipeline` child as a REAL run
(P2 models the call as a `startChild` command + awaits a `call.returned` event; the
actual child run is created by the driver in P3/P4), the web monitor (P6).

## Event / command vocabulary

**Events** (durable facts appended by the driver/reconciler):
- `run.started`
- `node.dispatched { nodeId, attemptId, idempotent: boolean }` — the driver ACCEPTED
  the dispatch (idempotency is decided at dispatch time from the P3 catalog and
  PERSISTED here; boot-reconcile never recomputes it — CP1 Q4).
- `node.succeeded { nodeId, attemptId, outputs }`
- `node.failed { nodeId, attemptId, error }`
- `call.returned { callNodeId, attemptId, childRunId, childOutcome, outputs }`
- `run.resumed { reason: "boot_reconcile" }` + `node.retryRequested { nodeId,
  previousAttemptId, reason }` — boot reconcile appends these; the reducer then
  emits a fresh `dispatchNode` (retry is an ENGINE decision, kept distinct from the
  driver-accepted `node.dispatched` — CP1).
- `run.finished { outcome: success | failure, reason? }` — the TERMINAL fact
  (replay never depends on a side effect outside the log). `capped` is
  `failure{reason:"capped"}` (one terminal vocabulary — CP1).
- `node.output { nodeId, name, value }` — **observability/streaming ONLY**; a `${}`
  ref may read a node's `outputs` ONLY after that node's terminal
  `node.succeeded` (with typed-output validation). Partial outputs never feed
  substitution (CP1).

**Commands** (reducer → driver, no state change): `dispatchNode { nodeId, attemptId,
preparedInput }` · `startChild { callNodeId, attemptId, childRunId, pipelineVersionId,
params }` (childRunId deterministic from parent+callNode+attempt → idempotent child
creation — CP1 Q1) · `finishRun { outcome, reason? }` (asks the driver to append
`run.finished` + persist terminal `runs.status`).

**Fold-to-fixpoint (CP1 Q2):** after folding one event, the reducer re-evaluates
readiness and emits ALL newly-ready nodes' commands in a STABLE deterministic order
(sorted by nodeId); the driver owns concurrency, the reducer owns readiness.

## RunState (projection)

`{ runId, pipelineVersionId, params, status: pending|running|success|failure|
interrupted, nodes: Record<nodeId, { status: pending|ready|dispatched|success|
failure|skipped|waiting, attempts, currentAttemptId? }>, outputs: Record<nodeId,
Record<name,value>> (populated ONLY on node.succeeded), containers: Record<id,
ContainerState>, bounces: Record<edgeKey, number>, sessions }`.

**Reducer totality (CP1):** an event for a DIFFERENT run or an obsolete node that
cannot exist in this pipeline version by construction → no-op. But a well-typed
event that is IMPOSSIBLE for the current state (e.g. `node.succeeded` for a
`pending` node) is NOT silently ignored — it appends a `diagnostics[]` entry and,
if it would corrupt the log's meaning, drives `run.finished{failure,
reason:"invalid_event"}`. Absence of evidence is never treated as success.

## Walk semantics — precise (CP1 truth table)

**Edges** `{ from, to, on: success|failure|completion, back?, maxBounces? }`.
`edgeKey = hash(from, to, on)` — STABLE across doc saves/reorders (never an array
index — CP1). Edge-less docs synthesize the implicit success-chain (one engine,
both shapes).

**Per-incoming-edge state** for a node: `satisfied` (predecessor reached a terminal
outcome matching this edge's `on`), `unsatisfied-terminal` (predecessor terminal on
a channel this edge does NOT match — will never satisfy), `pending` (predecessor not
yet terminal), `impossible` (predecessor `skipped`, or `unsatisfied-terminal` with
no other path). **Readiness:**
- `join: all` → ready when EVERY incoming edge is `satisfied`; if ANY is `impossible`
  → the node is `skipped`; else `pending`.
- `join: any` → ready when ≥1 incoming edge is `satisfied`; `skipped` only when ALL
  are `impossible`; else `pending`.

> Footnote: the impl's `join:all` "any dead → skipped" check treats `dead` as
> `impossible` ∪ `unsatisfied-terminal`, not `impossible` alone — an
> `unsatisfied-terminal` edge (predecessor terminal on a channel this edge does
> NOT match) can never become `satisfied` either, so `join:all` must skip on it
> too, or the node would wait on it forever (a deadlock). Read literally, the
> bullet above says "if ANY is `impossible`"; a future edit should not narrow
> the code to match that prose — `unsatisfied-terminal` skips `join:all` too.

**Skip propagation:** a `skipped` node makes its outgoing edges `impossible` for
successors (recurse). A node with NO incoming edges is a root (ready at start).

**Outcome routing:** a node's terminal outcome (`success`/`failure`) fires its
matching `on:` edges + any `on:completion` edge. An unhandled `failure` (no
`failure`/`completion` edge from a failed node, and it's not inside a container that
catches it) → the run fails.

**Back-edges** (`back: true`): traversal-only; `to` must be an ANCESTOR (loop/stage
container). Each traversal `bounces[edgeKey]++`; exceeding `maxBounces` →
`finishRun{failure, reason:"capped"}`. On traversal, the loop body's node states
RESET to `pending` (and their `outputs` are cleared — a re-run recomputes them);
the container's own accumulated outputs policy is specified per container kind below.

## Containers (loop | stage) — lifecycle

A container `{ id, kind, children[], exit_when?, join?, runs_as? }` owns a child
NAMESPACE (child node ids are unique within it; `${nodes.<child>.output}` refs are
resolved within the container's scope + its visible ancestors). Lifecycle:
- **enter:** container `active`; its root children become ready.
- **internal walk:** children walk by the same rules; a child `skipped` does NOT
  fail the container (it's an internal branch).
- **exit:** a `stage` exits when all children are terminal; a `loop` re-enters via
  its back-edge until `exit_when` (a `${}` boolean over child outputs) is true OR
  `max_rounds`/bounce cap hits. `exit_when` is evaluated only when the round's
  children are all terminal (never races still-running children — CP1).
- **outcome:** the container's terminal outcome (success/failure, from its exit
  node or an unhandled child failure) fires the container's OUTER edges. Container
  `outputs` = the declared `outputs` projected from its children's outputs at exit.

## `call_pipeline`

A call node emits `startChild{childRunId (deterministic), pipelineVersionId, params}`;
its state is `waiting` until a `call.returned{childRunId, childOutcome, outputs}`
event. `childOutcome` may be failure and STILL return projected outputs (the findings
loop). Depth ≤ N and call-cycle refusal are validated at pipeline-SAVE time
(`validateRefs`/`validateDoc`), not at run time. The reducer is NOT child-agnostic —
parent waiting is core control flow (CP1 Q1).

## The `${}` language (ported; in `shared`, no server imports — CP1 Q3)

Refs `${params.x}` · `${nodes.<id>.output.<name>}` · `${run.<field>}` (closed set) +
a CLOSED pure-fn allowlist (`default(x,fb)`, `concat(...)`, `slug(x)`, …; NO eval).
- **INERT single pass:** substitution NEVER rescans replacements (port the
  no-injection regression: a param value containing `${…}` is emitted literally).
- **Literal escape:** `$${` emits a literal `${` (port the prototype's rule).
  Malformed/unterminated `${` RAISES at validate time (never a silent literal).
- **Type preservation:** a WHOLE-string ref (`"${params.count}"`) preserves the
  native type (number/bool/object); an EMBEDDED ref (`"n=${params.count}"`) coerces
  to string. Arrays/objects recurse deterministically.
- **`validateRefs(doc)`** (pure, at save time, surfaced as P5 node badges): declared
  params only; secret-typed params refused anywhere; node-output refs validated by
  **availability/dominance** — a ref to a node reachable only on a `failure`/
  `completion` branch, or a not-guaranteed-available loop sibling, must be wrapped in
  `default(...)`; unconditional refs require the target to DOMINATE (be on every path
  to) the referencing node (CP1). Function arity checked. `brief`/prompt fields per
  node type.

## Typed params/outputs

`resolveRunParams(doc, overrides)` (pure) at run start: default < override, coerce to
declared type, refuse required-unset / type-mismatch. On `node.succeeded{outputs}`,
each output is validated against the node's declared output type; a bad-typed output
fails the node (`unvalidated data never crosses`).

## Boot reconciler + resume (the one impure boundary)

`reconcileOnBoot(db)` at startup (tested vs a real tmp DB): any `runs` row still
`running` and any node still `dispatched` after a restart could not have survived.
For each such node, read its PERSISTED `idempotent` flag (from its `node.dispatched`
event — never recomputed — CP1 Q4): idempotent → append `run.resumed` +
`node.retryRequested{previousAttemptId}` (the reducer then emits a fresh
`dispatchNode` with a NEW attemptId, so the stale executor result is ignored);
non-idempotent (LLM call, agent_cli) → mark the node/run `interrupted`
(needs-attention). Never silently resumes.

## Files

`packages/shared/src/engine/`: `types.ts` (Event/Command/RunState unions),
`params.ts` (`substitute`, `resolveRunParams`, `validateRefs`), `reduce.ts` (the
pure reducer + walk). `packages/server/src/run/`: `reconcile.ts` (boot),
`driver.ts` (the reduce↔executor fixpoint loop; a STUB executor for tests, the real
one is P3). Engine code is I/O-free; only `reconcile`/`driver` touch the repo.

## Testing (the ported-core bar)

Port each prototype edge case as a TS case + the event-sourcing invariants:
- **Replay determinism:** folding an event log twice yields the identical RunState;
  a stale-`attemptId` event is ignored (the pre-restart-result test).
- **`${}`:** every ref kind, allowlist arity, type-check + secret-ref refusal, the
  INERTNESS regression, `$${` literal, type-preservation (whole vs embedded),
  malformed-brace raise.
- **validateRefs:** undeclared param, self/downstream ref, failure-branch ref needs
  `default()`, dominance, loop-sibling availability — each accepted/rejected.
- **Walk:** the full join truth table (all/any × satisfied/unsatisfied-terminal/
  pending/impossible), skip propagation, success/failure/completion routing,
  unhandled-failure fails run, implicit success-chain.
- **Back-edge:** stable edgeKey across a doc reorder, bounce cap → capped, loop body
  reset on traversal.
- **Containers:** stage exit-when-all-terminal, loop exit_when/max_rounds, child-skip
  doesn't fail container, container outcome fires outer edges, child namespace.
- **call_pipeline:** waiting→call.returned, failed-child-still-returns-outputs,
  deterministic childRunId, depth/cycle refused at save time.
- **Reducer totality:** different-run event no-op; impossible same-run event →
  diagnostic / invalid_event failure (NOT silent).
- **Reconcile:** idempotent → retryRequested + new attempt (stale result ignored);
  non-idempotent → interrupted; against a real tmp DB.

## Resolved (was Open questions)

Q1 `call_pipeline` = startChild+call.returned WITH correlation ids + idempotent child
creation, reducer NOT child-agnostic. Q2 emit all ready nodes after fold-to-fixpoint,
stable order, driver owns concurrency. Q3 `${}` + validateRefs in `shared`, no server
imports. Q4 default non-idempotent, persist the decision in `node.dispatched`, never
recompute at boot.
