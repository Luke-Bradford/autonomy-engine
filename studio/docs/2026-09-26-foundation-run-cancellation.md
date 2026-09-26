# Foundation sub-spec (CX) — Run cancellation

**Status:** proposed 2026-09-26 (#1320). Written by the headless build loop; no CX code exists yet.
**Scope:** a cancel primitive that crosses a run boundary — an operator can stop a run, and a
`call_pipeline` child stops when its parent no longer wants it. This is the engine-semantics epic the
UI spec's U28 row and #1056 both name. The UI epic's pre-settled note (operator, 2026-07-23) forbids
the UI from crossing the "no engine execution-semantics changes" boundary to get cancel. So cancel is
built here, in the engine, and U28 consumes it.
**Foundation layer — engine + server + one UI surface.**

**Non-goals (v1):**
- **Cancel-ACTIVITY** (stop one node, let the run continue). What the run should do next has no
  obvious answer: does the node's failure edge fire, or does the run treat the node as skipped? It is
  a separate design question, and ADF itself offers cancel at run level only. Deferred. Nothing below
  prevents adding it later.
- **A per-node or per-run TIMEOUT.** `policy.timeoutSeconds` stays F3's (`FAILURE_CODES.TIMEOUT` is
  reserved there). CX builds the run-scoped abort registry a timeout would reuse, and stops there.
- **Force-kill of an adapter that ignores its signal.** Every shipped adapter honours `ctx.signal`
  (below). One that does not is breaking its contract, and that is the defect to fix. CX does not add
  a watchdog around it.

## The hole (measured on `main` at `ab8151b8`)

- **No route, no event, no status.** `routes/runs.ts` has the read routes,
  `POST …/external-waits/complete` and `POST …/rerun-from-failed`, and nothing that stops a run.
  `RunStatusSchema` (`shared/src/schemas/run.ts:5-24`), `RunLifecycleStatusSchema`
  (`engine/types.ts:263`) and `RunOutcomeSchema` (`types.ts:483`) have no `cancelled`.
- **The abort signal is unreachable.** Each dispatch gets its own `AbortController`
  (`run/executor.ts:1654`, passed as `ctx.signal`). The only `abort()` is in `runAdapter`'s `finally`
  (`:1263`), which runs after the adapter has already finished. Pump teardown does not abort in-flight
  work: it waits for it (`await adapterDone`, `:1786`). Shutdown reaps `agent_cli` subprocesses and
  nothing else (`index.ts:1051-1094`).
- **The consumers already exist.** HTTP and LLM (`http.ts:215-246`, `llm-shared.ts:221-262`) turn a
  run abort into `kind:'cancelled'`. `agent_cli` passes the signal to the process supervisor, which
  kills the tree with SIGTERM then SIGKILL (`process-supervisor.ts:388-415`). fs, lookup and every
  dataset reader and writer check `signal.aborted` at batch boundaries. `FailureKind` already has
  `cancelled` (`types.ts:502`), and `retryEligible` (`reduce.ts:3331-3345`) never retries it.
  **The adapter half of cancellation is built and has no producer.** CX adds the producer and the
  run-level semantics.
- **#1056:** a child whose parent terminalizes mid-flight runs to completion, bills every activity,
  and `returnToParent` discards the result (`run/child.ts:469`). The #1053 guard stops the crash path
  from re-dispatching (`reconcile.ts:1223-1238`), but only at boot or lease reclaim.

## Decisions

Each decision below was settled here on the merits. None is an irreducible fork: each has one answer
that the existing invariants force, and the reason is given with it.

### D1 — `cancelled` is a NEW terminal status and outcome, not a reuse of `interrupted`/`failure`

`run.finished{outcome:'cancelled', reason}`. `RunOutcomeSchema` gains `cancelled`, and so do
`RunLifecycleStatus`, `RunStatus` and `TERMINAL_RUN_ROW_STATUS`.

- **Not `failure`:** a failed run tells the operator something went wrong. A cancel means the
  operator stopped it on purpose, so reporting it as a failure is a wrong outcome, and "a run reports
  the wrong outcome" is what the correctness rule forbids.
- **Not `interrupted`:** that status means frozen and needs attention (a crash, a spent retry alarm,
  an unresolvable doc). Mixing an intentional stop into it would make "needs attention" mean less.
- **Cost:** a SQL CHECK change. `runs.status` has a closed CHECK list (`0002`, widened by `0015`) and
  SQLite cannot ALTER a CHECK, so the migration rebuilds the table the way `0015` did. Every exhaustive
  switch over these enums also gains an arm, and TYPECHECK finds each of them. That is the reason to
  keep those switches exhaustive.

### D2 — The fact is `run.cancelRequested{runId, source}`. The run finishes when its in-flight work drains

A cancel takes two steps, because in-flight work can only stop cooperatively:

1. **`run.cancelRequested`** is folded. The run stays `running` (or leaves `waiting`/`pending`, see
   D5), and `RunState` records `cancelRequested: {source}`. From then on, `settle` **dispatches
   nothing**: no ready node, no successor, no failure-edge handler, no container iteration, and no
   retry.
2. As in-flight dispatches abort they fold as `node.failed{kind:'cancelled'}`, and
   `activity.*` events are folded as usual. Once nothing is in flight, `settle` emits `finishRun`.

`source` is machine-set only, from a closed union: `{kind:'operator'}` ·
`{kind:'parent_cancelled', parentRunId}` · `{kind:'parent_terminal', parentRunId}`. **No free-text
reason from the request body.** An operator-typed string written into an append-only log that every
viewer renders adds a stored-content surface and gives the operator nothing (see Security model).

### D3 — The outcome is TRUTHFUL: `cancelled` only if the cancel actually prevented work

A cancel can race the run's own completion. The outcome when the run finishes under
`cancelRequested` is decided like this:

- **`cancelled`** if any node ended `failure{kind:'cancelled'}`, **or** any top-level node or
  container is still non-terminal (work the cancel stopped from being dispatched);
- **otherwise the normal outcome** that `settle` would have produced: `success`, or
  `failure{node_failed:…}`.

Consider a cancel that arrives while the last node is in flight, where that node then succeeds. The
run really did complete, so it finishes `success`. Reporting `cancelled` would claim that work was
prevented when it was not. The reverse case is covered too: a `failure{kind:'cancelled'}` caused by
the cancel produces `cancelled`, not `failure{node_failed}`. The failure is the cancel's effect, not
the pipeline's.

**A node that SUCCEEDS after the cancel keeps its success** (it happened, and it may have had side
effects). Its successors are not dispatched.

### D4 — Retry holds and containers under a cancel

- **A node in `retry_pending`** folds to `failure{kind:'cancelled'}` when `cancelRequested` folds.
  Its next attempt is what the cancel prevents. The alarm then finds a terminal log and is suppressed
  (`durable-alarm-handler.ts`, the terminal-log arm).
- **Containers** (`foreach`/`until`/loop): in-flight children abort like any other dispatch. No
  further iteration or round starts. A container left non-terminal keeps its live state in the log,
  and the run finishing `cancelled` is the terminal fact. This is the same shape as a `stalled` run
  that finishes with pending nodes, so the reducer does not need a new "abandoned" node state. A
  container `timedOut` alarm arriving after the cancel is suppressed by the terminal log.

### D5 — A cancel is legal from `pending`, `queued`, `running` and `waiting`; idempotent; refused on terminal

- **`pending`/`queued`** (never started, or held by admission): folds straight to terminal
  `cancelled`, the same way `run.interrupted` is already accepted from `pending`. No `run.started` is
  written. A cancelled row must never be admitted afterwards. The expectation is that admission
  selects `queued` rows only, but that is unverified here; CX5 pins it.
- **`waiting`** (parked on a timer, an external wait, a retry alarm or a child): `run.cancelRequested`
  joins `UNPARK_EVENTS` (`reduce.ts:322`). Today `run.interrupted` is silently IGNORED on a waiting
  run (`:4256-4265`); repeating that for cancel would turn it into a no-op. Nothing is in flight, so
  the run finishes at once (under D3's rule). Its outstanding alarms and external-wait tokens resolve
  against a terminal log and are suppressed or refused (see CX5, which confirms every one).
- **Already terminal:** the route answers **409** with the current status and appends nothing.
- **Already cancel-requested:** **202**, and nothing is appended. The reducer also ignores a second
  `run.cancelRequested` as defence in depth, so replaying a log with a duplicate is total.

### D6 — Delivery: the fact is appended by whichever holder owns the run's in-memory state

This is the load-bearing server rule. **A live pump holds `RunState` in memory and never re-reads the
log** (`driver.ts:942`). If the route appended `run.cancelRequested` out-of-band (`foldOutOfBand`)
while a pump was live, the pump would not see it. It would keep dispatching from stale state (success
edges, failure handlers). Its later appends would land after the cancel in the log, so a replay would
fold a different history from the one that actually ran. That breaks the invariant that a run's
state is the fold of its own log.

So the cancel is delivered as an **intent**, and exactly one holder turns it into the durable fact:

- A process-wide `CancelIntents: Map<runId, CancelSource>`. The route does `set` and returns 202.
  Node is single-threaded, so `get`+`delete` is atomic and the intent has **exactly one consumer**.
- **A live pump** registers a waker for its run (created inside the drive lock). The route calls it
  after `set`. On wake, the pump consumes the intent and pushes `run.cancelRequested` into its own
  `pendingFolds` (the inbox its executor streams already use), so the fact takes its place in the
  pump's log order.
- **A pump that is starting** consumes any intent before its first dispatch. That covers a pump that
  took the lock between the route's check and its enqueue.
- **No live pump:** the route enqueues `drives.serialize(runId, …)`. Under the lock, if the intent
  is still there, it consumes it, appends and folds it, then drives. If a pump got there first, the
  intent is already gone and the serialized task does nothing.

**Abort follows the fold, never precedes it.** When a pump folds `run.cancelRequested` it calls
`executor.abortRun(runId)`. The executor keeps a `Map<runId, Set<AbortController>>` that each
dispatch adds itself to and removes itself from in `runAdapter`'s `finally`. So the reducer is already
in cancel mode when the first `node.failed{kind:'cancelled'}` arrives, and that failure can never be
routed down a failure edge.

**Crash window, accepted:** an intent held only in memory is lost if the process dies before it is
consumed. The live and out-of-band paths both consume on the next tick, so the window is tiny. It
also fails SAFE: the run resumes on boot exactly as it would have without the cancel, the monitor
does not show it as cancelling, and the operator can cancel again. The route's 202 means "requested",
never "done".

### D7 — Crash after the fact: the reconciler FINISHES the cancel, it never resumes it

On boot or lease reclaim, `reconcileOne` finds a `running` run whose log has `run.cancelRequested`
folded. It must not append `run.resumed` + `node.retryRequested`, because that would re-dispatch work
the operator stopped. It also must not append `run.interrupted` for a non-idempotent in-flight node:
the run is not frozen, it is being cancelled. Anything that was in flight died with the process, so
the reconciler folds `node.failed{kind:'cancelled'}` for each `dispatched` node and then the D3
`finishRun`. **No resume and no interrupt.**

### D8 — Children: cancel propagates to LIVE, NON-DETACHED children, transitively; best-effort

- **When a parent is cancelled**, every live, non-detached child gets
  `CancelIntents.set(child, {kind:'parent_cancelled', parentRunId})`, delivered by D6. A child is
  identified by `parentRunId`; `callDepth` already walks that chain (`child.ts:105-120`). Propagation
  is transitive because the child's own cancel propagates in turn.
- **#1056, the live path:** when a parent run reaches ANY terminal fact while a non-detached child is
  still live, the child gets `{kind:'parent_terminal', parentRunId}`. The hook is the existing
  terminal-event tap (`subscribeChildReturns`, `child.ts:400`), which already watches every terminal
  event. That closes the gap #1053 left: a live child whose result will be discarded stops spending.
- **Detached children (`wait:false`, #796) are NOT cancelled** by either route. They exist precisely
  to outlive the parent ("the child runs to its own end, including across a restart after the parent
  finished", #1297). An operator who wants one stopped cancels that run directly.
- **Best-effort, not awaited.** The parent's terminalization does not wait for its children, so a
  slow child adapter cannot delay the parent's outcome. The child finishes `cancelled` on its own
  drive. Its `returnToParent` is already a no-op against a terminal parent (`child.ts:469`).
- **Cancelling a child DIRECTLY** is an ordinary run cancel. The child finishes `cancelled`,
  `returnToParent` delivers it, and the parent's call node fails `kind:'cancelled'` (the existing
  mapping at `child.ts:338-342`). The parent treats that like any other failure: an operator who
  cancels a child has not cancelled the parent. The parent's failure edges may handle it, and with
  `retryEligible` a cancelled call is never retried.
- **The #1053 boot guard moves to the same fact.** `reconcileOne` finishes a live child of a
  terminal parent with `run.cancelRequested{parent_terminal}` + D7, instead of
  `run.interrupted{parent_terminal:…}`, so the crash path and the live path produce the same status.
  Logs that already carry the old `interrupted` fact stay valid (see Migration posture).

### D9 — Downstream consumers of a `cancelled` terminal

| Consumer | Rule |
| --- | --- |
| Rerun-from-failed (RS) | **Allowed** on a cancelled run. `canRerunFromFailed` gains `cancelled`, and the RS frontier's strict prefix is unchanged. A cancelled in-flight node is not `success`, so it re-runs. |
| Tumbling window (S11) | A cancelled window run marks the window `failed`, so it does **not** satisfy a dependent window. The window retry policy does **not** retry it, because a cancel is operator intent and an automatic retry would undo it. |
| Trigger concurrency / admission (S6) | A cancelled run frees its slot at terminal, the same as any terminal. A cancelled `queued` run held no slot. |
| External-wait callback (A16) | Completing a wait on a cancelled run is refused, as on any terminal run (CX5 confirms the status code). |
| Cost (U27) | A cancelled run's cost is what it spent. Completeness is unchanged, and no "may be partial" caveat is needed beyond the status itself. |
| Run list / timeline / filters (U26/U29) | `cancelled` is a first-class status with a NEUTRAL chip, not red. It is filterable. |

## Security model

- **Authorization:** `POST /api/runs/:id/cancel` resolves the run through
  `requireOwned(getRun(db,id), principal, 'run', id)` (`routes/util.ts:18-28`), the same as every
  `/api/runs/:id*` route. Another owner's run and a missing run both answer 404. Child propagation
  only follows `parentRunId` links, and a child row inherits `parent.ownerId` (`child.ts:249`), so it
  never crosses owners.
- **No request body.** The source is set by the server (D2), so no stored-content injection surface
  is added.
- **No new egress.** Cancel stops outbound work and never starts any.
- **Secure nodes (F4):** `run.cancelRequested` carries no node values. `node.failed{kind:'cancelled'}`
  goes through the existing `Engine.redact` seam like any other failure.
- **Fail-safe polarity:** every lost-intent or crash path resolves to the run continuing exactly as
  if nobody had cancelled it (D6, D7), never to a state it could not otherwise have reached.

## Migration / authority posture (#443)

The change is additive to the event union. Existing logs never contain `run.cancelRequested`, so
re-folding every bound run log under the CX reducer gives the same state as today. The one existing
fact CX stops producing, `run.interrupted{parent_terminal:…}`, is still a legal event and folds as it
always did, so historical children keep their `interrupted` status. The `runs.status` CHECK rebuild
is a forward-only migration that widens the list, so every existing row satisfies the new CHECK.

## Tickets (CX-series)

| # | Ticket |
| --- | --- |
| CX1 | **Reducer + schemas.** `run.cancelRequested{runId, source}` in `EngineEventSchema`. `cancelled` in `RunOutcome`/`RunLifecycleStatus`/`RunStatus`/terminal sets. `RunState.cancelRequested`. `settle`'s cancel mode (D2: no dispatch, drain, then finish). D3 truthful outcome. D4 retry-hold and container rules. D5 legality from `pending`/`waiting` (joins `UNPARK_EVENTS`), duplicate ignored. Pure and unit-tested. Every exhaustive switch gains its arm. |
| CX2 | **Server producer.** `runs.status` CHECK rebuild migration. `CancelIntents` + pump waker registry + pump-start consumption + serialized out-of-band path (D6). `executor.abortRun(runId)` via the per-run controller set, called after the fold. `POST /api/runs/:id/cancel` (202 / 409 / 404). Reconciler D7. Row sync for the new status. |
| CX3 | **Children.** Parent-cancel propagation to live non-detached children (D8). The #1056 live parent-terminal path through the terminal-event tap. The #1053 boot guard moved onto `run.cancelRequested{parent_terminal}` + D7. |
| CX4 | **UI (U28's cancel-run half).** A Cancel control on the run detail page for a non-terminal run, with a confirmation that names what is in flight. A "Cancelling…" state while `cancelRequested` is folded but the run is not terminal. `cancelled` as a neutral status in chips, filters, timeline and cost. The node table renders a pending node of a cancelled run as "not run (cancelled)". `NodeActivityPanel`'s "no cancel" note is updated. e2e covers cancelling a live run and a waiting run. |
| CX5 | **Consumer audit (D9).** Rerun-from-failed eligibility. Tumbling-window status mapping and the no-retry rule. External-wait completion refused on a cancelled run. Admission never admits a cancelled row. Each gets a test pinning it. |

Build order: CX1 → CX2 → CX4 (the operator-visible path, usable against a single run) → CX3 → CX5.
CX3 comes after CX4 on purpose. Cancelling a run the operator can see is the core path, while child
propagation stops spend the operator cannot see, and both need CX1+CX2.

## Open questions (none block CX1)

1. **Confirmation copy for a run with an in-flight side-effecting node** (an `http` POST, a `copy`
   into a sink). A cancel cannot un-send a request. CX4 should say "work already sent is not undone"
   rather than imply a rollback. That is wording to settle in CX4, not a design fork.
2. **Should a cancelled `copy` report `rowsWritten`?** The data-movement spec §10 already says a
   cancel must never leave a silent partial, and the copy adapter already implements that. CX adds
   nothing and only checks it end to end in CX5.
