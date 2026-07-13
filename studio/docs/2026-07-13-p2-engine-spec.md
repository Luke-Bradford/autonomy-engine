# P2 — the pure event-sourced engine (spec)

*2026-07-13. The core of autonomy-studio: a PURE, deterministic run engine that
ports the prototype's hard-won pipeline semantics (`../autonomy-engine`
`lib/pipeline.py`) into TypeScript. NO I/O, NO connectors, NO executor (P3) — the
engine emits COMMANDS; a driver performs them and feeds EVENTS back. Builds on the
P1 data model (`packages/shared/src/schemas/*`, the `runs`/`run_events` tables +
repo). Lives in `packages/server/src/engine/` (pure) with its own test suite.*

## Why pure + event-sourced

Purity + durability + (future) live streaming reconcile via one boundary:
- **Engine = pure reducer:** `reduce(runState, event) → { state, commands[] }`.
  No clock, no random, no I/O, no DB. Deterministic → exhaustively unit-testable
  against the mined edge cases.
- **Driver** (a thin loop, tested here with a STUB executor; the real one is P3)
  performs each `command`, then feeds `events` back into `reduce`.
- **`run_events`** (append-only, from P1a) is the source of truth; run/node state
  is a materialized projection = folding `reduce` over the event log. Rebuildable
  from events; the monitoring feed (P6) is a live tail.

## Scope (P2) / non-goals

IN: the reducer + walk semantics + the `${}` parameter language + typed
params/outputs + a run-state projection + a boot reconciler + a stub-driver test
harness. OUT (later): real activity execution / connectors / subprocess
(P3), the scheduler + triggers firing (P4), `call_pipeline` CHILD spawning as real
runs (the reducer MODELS the call as a command + awaits a child-outcome event, but
spawning a real child run is P3/P4), the web monitor (P6).

## Run state (projection) + event/command vocab

`RunState` (in-memory projection, mirrors the `runs`/`run_events` rows):
`{ runId, pipelineVersionId, params, status, nodes: Record<nodeId, NodeState>,
containers: Record<id, ContainerState>, bounces: Record<edgeKey, number>,
outputs: Record<nodeId, Record<name, value>> }`. `NodeState.status ∈
pending|ready|dispatched|success|failure|skipped|waiting`. Run `status ∈
pending|running|success|failure|interrupted`.

**Events** (facts the driver feeds in): `run.started` · `node.dispatched` ·
`node.succeeded{outputs}` · `node.failed{error}` · `node.output{name,value}` ·
`call.returned{childOutcome, outputs}` (a `call_pipeline` child finished) ·
`run.interrupted` (boot reconcile).
**Commands** (the reducer's requests to the driver): `dispatchNode{nodeId,
preparedInput}` (run this activity) · `startChild{callNodeId, pipelineVersionId,
params}` (spawn a call_pipeline child) · `finishRun{outcome}` (persist terminal
state). The driver never decides control flow — it only executes commands + reports
events.

`reduce` is total: an event for an unknown/terminal node is a no-op (idempotent
replay); it never throws on a well-typed event.

## The `${}` parameter language (ported verbatim — the crown jewel)

Refs: `${params.<name>}`, `${nodes.<id>.output.<name>}`, `${run.<field>}` (closed
field set) + a CLOSED pure-function allowlist (`default(x, fallback)`,
`concat(...)`, `slug(x)`, … — extend deliberately, NO `eval`). Type-checked.
Secrets are refused anywhere in the language (a secret-typed param used in a
`${}` is a static error).
- **Values are INERT:** substitution is a SINGLE pass that NEVER rescans its
  replacements (the no-injection property — port the prototype's regression test:
  a param value containing `${…}` is emitted literally, not re-resolved).
- **Static ref-validation at pipeline SAVE time** (a pure `validateRefs(doc)`
  returning a list of errors, wired into the P1 pipeline-version create + surfaced
  in P5 as node badges): declared params only; node-output refs must be UPSTREAM
  (or an earlier sibling in a container) of the referencing node; function arity
  checked; `brief`/prompt fields are ref-free-or-substituted per node type.
- `substitute(value, ctx)` and `substituteDoc(doc, ctx)` are pure; the engine
  substitutes a node's input at `dispatchNode` command time from the run's
  params + upstream outputs.

## Walk semantics (ported — the P2a "semantic decisions")

- **Typed edges** `{from, to, on: success|failure|completion, back?, maxBounces?}`.
  A node's terminal outcome fires its matching edges; `completion` fires on either.
  Edge-less docs synthesize an implicit success-chain (one engine, both shapes).
- **Readiness / join:** a node becomes `ready` when its incoming edges are
  satisfied per its `join: all|any` (all = every required predecessor terminal on a
  matching edge; any = at least one). Ready nodes are emitted as `dispatchNode`
  commands (one per ready node; batching/parallelism is the driver's concern, the
  reducer just marks them dispatched).
- **Skip propagation:** a node with no satisfiable incoming edge (all preds failed
  on a channel it doesn't handle) → `skipped`; skip propagates downstream.
- **Back-edges:** traversal-only, target must be an ancestor (loop/stage); each
  traversal increments `bounces[edgeKey]`; exceeding `maxBounces` → the run
  `capped`/fails (mined). No infinite loops.
- **Containers** (loop/stage): children walk internally; the container's outcome
  (from its exit node / `exit_when`) fires the container's outer edges.
- **`call_pipeline`:** a call node emits `startChild`; its state is `waiting`
  until a `call.returned` event; a failed child still returns projected outputs
  (findings loop); depth-bounded + cycle-refused (validated at save time).
- **Run termination:** all top-level units terminal → `finishRun{success}` unless
  an unhandled failure → `finishRun{failure}`; a session/step cap → `capped`.

## Typed params/outputs

Ported from P1 schemas (`Param`, `Output`). At run START, `resolveRunParams(doc,
overrides)` (pure): pipeline default < caller override, coerce to the declared
type, refuse a required-unset or a type mismatch. Node `outputs` are validated
against the node's declared output types when a `node.succeeded{outputs}` event
folds in (a bad-typed output → the node fails, `unvalidated data never crosses`).

## Boot reconciler + resume policy

`reconcileOnBoot(db)` (the one impure boundary, at startup, tested against a real
tmp DB): any `runs` row still `running`/`dispatched` after a restart could not have
survived → apply the per-activity resume policy: an idempotent activity → re-emit
`node.dispatched` (re-run); a non-idempotent one (an LLM call, an `agent_cli`) →
mark the node/run `interrupted` (needs-attention). Emits `run.interrupted` events;
never silently resumes. (The activity-idempotency flag comes from the P3 catalog;
P2 threads a `NodeState.idempotent?` hint defaulting to non-idempotent = the safe
side.)

## Architecture / files

`packages/server/src/engine/`: `state.ts` (RunState + projection folder),
`reduce.ts` (the pure reducer + walk), `params.ts` (the `${}` language:
`substitute`, `resolveRunParams`, `validateRefs`), `types.ts` (Event/Command
unions). `packages/server/src/run/`: `reconcile.ts` (boot) + a `driver.ts` skeleton
that loops reduce↔executor with a STUB executor for tests (the real executor is
P3). All engine code is I/O-free; only `reconcile`/`driver` touch the repo.

## Testing (the bar for a ported core)

A test suite MIRRORING the prototype's edge cases — port each as a TS case:
- `${}` language: every ref kind, the closed fn allowlist + arity, type-check
  failures, secret-ref refusal, and the INERTNESS regression (a `${}` inside a
  param value is emitted literally, single-pass, never re-resolved).
- `validateRefs`: undeclared param, downstream/self node-output ref, bad arity,
  earlier-sibling legality — each rejected/accepted correctly.
- Walk: success/failure/completion routing; join all vs any; skip propagation;
  back-edge bounce cap; container outcome edges; implicit success-chain synthesis;
  unhandled-failure fails the run; caps.
- `call_pipeline`: waiting→call.returned, failed-child-still-returns-outputs,
  depth/cycle refusal (save-time).
- Reducer totality: unknown/terminal-node events are no-ops; full replay of an
  event log reconstructs the same RunState (event-sourcing invariant).
- Reconcile: a `running` row → interrupted (non-idempotent) or re-dispatched
  (idempotent), against a real tmp DB.

## Open questions for CP1

1. Is modelling `call_pipeline` as a `startChild` COMMMAND (child spawning deferred
   to P3/P4) the right P2 boundary, or should the reducer stay child-agnostic
   until then?
2. Batch vs one-at-a-time ready-node dispatch — keep the reducer emitting ALL
   ready nodes as commands (driver decides concurrency), matching the prototype's
   batch protocol?
3. `validateRefs` lives in `shared` (so P5's canvas can call it client-side too)
   or `server`? It's pure + needed both sides — lean `shared`.
4. The reconciler's idempotency source: default non-idempotent now (safe), wire the
   real per-activity flag in P3 — confirm that's the right sequencing.
