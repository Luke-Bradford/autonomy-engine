# Foundation sub-spec (CX) — Run cancellation

**Status:** proposed 2026-09-26 (#1320). Written by the headless build loop. **CX1 built** (reducer + schemas); **CX2 built** (server producer); **CX4 built** (UI); **CX3 built** (children); **CX5 built** (consumer audit). The CX series is complete.
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
  switch over these enums also gains an arm, and TYPECHECK finds each of them. **TYPECHECK does NOT
  find a hand-written comparison**, such as `status !== 'failure' && status !== 'interrupted'`
  (`scheduler/tumbling.ts:512`, see D9). Such a check treats the new status as "still live" and
  hangs whatever waits on it. CX2 therefore greps every literal comparison against a terminal status
  value and pins each one it touches.

### D2 — The fact is `run.cancelRequested{runId, source}`. The run finishes when its in-flight work drains

A cancel takes two steps, because in-flight work can only stop cooperatively:

1. **`run.cancelRequested`** is folded. The run stays `running` (or leaves `waiting`/`pending`, see
   D5), and `RunState` records `cancelRequested: {source}`. From then on, `settle` **starts no new
   work**: it emits no dispatch command for any ready node, successor or failure-edge handler, starts
   no container iteration or loop round, spawns no child, arms no timer, and schedules no retry.
2. As in-flight dispatches abort they fold as `node.failed{kind:'cancelled'}`, and
   `activity.*` events are folded as usual. Once nothing is in flight, `settle` emits `finishRun`.

**Cancel mode blocks STARTING work, never the pure fixpoint.** `settle` keeps running every step that
only derives state from inputs that are already terminal. It still exits a container whose children
are all terminal (`stepContainers`, `reduce.ts:1744`, is the only site that does this), still
propagates `skipped` (`tryDispatchNode`'s `'skipped'` arm, `:1466-1471`), and still applies the doom
marks. These steps cost nothing and start nothing. Suppressing them would be wrong in two ways.
A container whose last child succeeded after the cancel would never exit, so `allTopLevelTerminal`
(`:1076`) would never hold and the run would never finish. And a node that is really `skipped` would
stay `pending`, which D3 below would misread as work the cancel prevented. In code, the rule is: a
node that is READY to dispatch stays `pending`, while everything else folds exactly as it does
without a cancel.

`source` is machine-set only, from a closed union: `{kind:'operator'}` ·
`{kind:'parent_cancelled', parentRunId}` · `{kind:'parent_terminal', parentRunId}`. **No free-text
reason from the request body.** An operator-typed string written into an append-only log that every
viewer renders adds a stored-content surface and gives the operator nothing (see Security model).

### D3 — The outcome is TRUTHFUL: `cancelled` only if the cancel actually prevented work

A cancel can race the run's own completion. The outcome when the run finishes under
`cancelRequested` is decided like this:

- **`cancelled`** if any node ended `failure{kind:'cancelled'}`, **or** any top-level node or
  container is still non-terminal after the D2 fixpoint has run (work the cancel stopped from being
  dispatched);
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

- **`pending`** (seeded but not started): folds straight to terminal `cancelled`, the same way
  `run.interrupted` is already accepted from `pending` (`reduce.ts:4225-4240`). No `run.started` is
  written.
- **`queued`** (held by admission) is different: it is a **row-only** status with no event log and
  no drive (`schemas/run.ts:6-15`; it is absent from `RunLifecycleStatusSchema`), so there is nothing
  to fold onto. It is cancelled by a **row patch**, the same kind `sweepPendingRuns` already uses for a
  run "with no event-sourced lifecycle to preserve". The patch is a conditional
  `UPDATE … SET status='cancelled' WHERE id=? AND status='queued'` inside one transaction. If it
  changes 0 rows, admission got there first and the run now has a log, so the route falls through to
  the D6 path. A cancelled row must never be admitted afterwards. The expectation is that admission
  selects `queued` rows only, but that is unverified here; CX2 pins it with a test.
- **`waiting`** (parked on a timer, an external wait, a retry alarm or a child): `run.cancelRequested`
  joins `UNPARK_EVENTS` (`reduce.ts:322`). Today `run.interrupted` is silently IGNORED on a waiting
  run (`:4256-4265`); repeating that for cancel would turn it into a no-op. Nothing is in flight, so
  the run finishes at once (under D3's rule). Its outstanding alarms and external-wait tokens resolve
  against a terminal log and are suppressed or refused (see CX5, which confirms every one).
- **Already terminal:** the route answers **409** with the current status and appends nothing.
- **Log unreadable** (the reconciler's `corrupt` bucket): the route answers **409 `log_unreadable`**
  and appends nothing. A fold needs a readable log. Writing a terminal fact without one would be
  manufactured, not derived, which is the disposition `durable-alarm-handler.ts` already takes
  (#642). **So CX does not close the RS spec's "known residual"**, where a corrupt R2 stays `running`
  and blocks reruns of R1. That still needs operator repair.
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

- A process-wide `CancelIntents: Map<runId, CancelSource>`. **An intent is consumed only at the
  moment it is FOLDED**: `get`, `delete` and the synchronous `appendAndFold` all run in one tick. Node
  is single-threaded, so the intent has **exactly one consumer**, and an intent that is not folded is
  still in the map.
- **The route always does three things:** `set` the intent, poke the live pump if there is one, and
  enqueue `drives.serialize(runId, …)`. Then it returns 202.
- **A live pump** reuses the machinery it already has rather than a new channel. `pump()`
  (`driver.ts:942`) already has a `pendingFolds` inbox and a `wake()` (its executor streams use both).
  The pump publishes a `poke` for its run into a registry while it holds the drive lock, and removes
  it before its teardown sets `dropped`. A poke pushes a MARKER into `pendingFolds`. When the pump
  shifts the marker, it consumes the intent and folds `run.cancelRequested` in its own log order. If
  teardown drops the marker instead, the intent was never consumed and stays in the map.
- **The serialized task** runs once the lock is free, meaning no pump is live for the run. If the
  intent is still present, it consumes it, appends and folds it, then drives. This is also the
  fallback for a marker dropped at teardown, which closes that race rather than merely accepting it.
  If the pump already folded the intent, the task finds nothing and does nothing.
- **A drive that is starting** (`drive()`, `driver.ts:1403`) consumes any intent AFTER projecting
  from the log and BEFORE `engine.resume` computes the first commands. So the initial queue comes from
  a cancel-aware state, and no dispatch command computed from a cancel-unaware projection can
  escape.
- The existing liveness signal, `RunDrives.activeRunIds()` (`drives.ts`), which S7's lease heartbeat
  already reads, is not a substitute for the poke registry. It reports live-or-QUEUED chains and
  exposes no inbox. The poke registry sits beside it.

**Abort follows the fold, never precedes it.** When a pump folds `run.cancelRequested` it calls
`executor.abortRun(runId)`. The executor keeps a `Map<runId, Set<AbortController>>` that each
dispatch adds itself to and removes itself from in `runAdapter`'s `finally`. So the reducer is already
in cancel mode when the first `node.failed{kind:'cancelled'}` arrives, and that failure can never be
routed down a failure edge.

**One fold hook.** Every site that folds `run.cancelRequested` calls a single `onCancelFolded(runId)`:
the pump's marker, the serialized task, a starting drive, and the D7 reconciler. That hook runs
`executor.abortRun(runId)` and then D8's child propagation. Nothing else calls either of them.

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

- **When a parent is cancelled**, D6's `onCancelFolded(parent)` fires at FOLD time, mid-run: the
  parent is not terminal yet, so the terminal tap below cannot carry this. It reads the parent's live
  children as `runs` rows with `parent_run_id = parent` (indexed, `runs_parent_run_id_idx`) and a
  non-terminal status. It skips a child the parent's log resolved with `call.detached`
  (`engine/types.ts:1247`). Each remaining child gets
  `{kind:'parent_cancelled', parentRunId}` through the route's own three steps from D6 (intent, poke,
  serialize). **Transitivity needs no recursion here**: each child folds its own `run.cancelRequested`,
  which fires its own `onCancelFolded` and reaches the grandchildren.
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
| Tumbling window (S11) | A cancelled window run marks the window `failed`, so it does **not** satisfy a dependent window. The window retry policy does **not** retry it, because a cancel is operator intent and an automatic retry would undo it. **This must land in CX2, not CX5.** `settleIfTerminal` (`scheduler/tumbling.ts:512`) completes a window only if `run.status` is `failure` or `interrupted`; any other status is treated as "still live". So a cancelled window run would leave its window `running` forever. |
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
| CX2 | **Server producer.** *Contract CX1 fixed (build it exactly):* a `dispatchNode` stream that has not STARTED when the cancel folds must still yield `node.failed{kind:'cancelled'}` for its attempt — never be dropped. The reducer counts a `ready` node as in flight, so a dropped stream leaves the run live forever. (A `ready` node whose command died with the PROCESS is different: `engine.resume` under a cancel folds it to `failure` itself.) `runs.status` CHECK rebuild migration. `CancelIntents` + pump waker registry + pump-start consumption + serialized out-of-band path (D6). `executor.abortRun(runId)` via the per-run controller set, called after the fold. `POST /api/runs/:id/cancel` (202 / 409 incl. `log_unreadable` / 404). The `queued` row-patch path (D5). The single `onCancelFolded` hook. Reconciler D7. `syncRunLifecycle` mapping the new status onto the `runs` row. **Every consumer that would HANG or mis-handle a now-producible `cancelled`, in the same PR:** `tumbling.ts:512` above all (D9), plus the literal-comparison grep from D1. |
| CX3 | **Children.** Parent-cancel propagation to live non-detached children (D8). The #1056 live parent-terminal path through the terminal-event tap. The #1053 boot guard moved onto `run.cancelRequested{parent_terminal}` + D7. |
| CX4 | **UI (U28's cancel-run half).** A Cancel control on the run detail page for a non-terminal run, with a confirmation that names what is in flight. A "Cancelling…" state while `cancelRequested` is folded but the run is not terminal. `cancelled` as a neutral status in chips, filters, timeline and cost. The node table renders a pending node of a cancelled run as "not run (cancelled)". `NodeActivityPanel`'s "no cancel" note is updated. e2e covers cancelling a live run and a waiting run. |
| CX5 | **Consumer audit (D9) for the consumers that do not hang.** Rerun-from-failed eligibility. The tumbling-window no-retry rule. External-wait completion refused on a cancelled run. A container `timedOut` or retry alarm arriving after a cancel is suppressed, walked through `durable-alarm-handler.ts`'s `containerActiveGuard`/`nodeParkedAtAttemptGuard` and not only its terminal-log arm. Each gets a test pinning it. |

Build order: CX1 → CX2 → CX4 (the operator-visible path, usable against a single run) → CX3 → CX5.
CX3 comes after CX4 on purpose. Cancelling a run the operator can see is the core path, while child
propagation stops spend the operator cannot see, and both need CX1+CX2.

### CX1 — as built

Decisions the reducer had to take that the D-sections left implicit:

- **`RunState.cancelRequested = {source, stoppedWork} | null`.** `stoppedWork` answers D3's "a node ended `failure{kind:'cancelled'}`": `NodeRunState` keeps no failure kind, so the fold records it when it happens. It is also set by a retry the cancel refused or cancelled, a lost `ready`/call-`waiting` node folded at resume, and a child returning `cancelled` under the parent's own cancel.
- **Where "start no work" is enforced:** `tryDispatchNode` (one guard covers dispatch, child, control, fail, filter, wait and webhook), top-level container entry, `startParallelItems`, the two `resetContainerRound` sites in `stepContainers`, and a within-cap back-edge bounce. A suppressed bounce persists NOTHING, not even its counted `bounces` entry, which would otherwise re-count on every walk until `capped` fired. It is reported so D3 calls the run `cancelled`.
- **A capped finish under a cancel that already stopped work** reports `cancelled` (D3), not `capped`.
- **`onRetryRequested` and `onResumed` bypass `settle`**, so each gets its own cancel arm: a `node.retryRequested` folds the node to `failure`, never re-dispatching it, and a resume re-derives nothing, folding a lost `ready` node or call-`waiting` node to `failure` (see the CX2 contract). `dispatched` nodes are left to D7.
- **Pending:** an EMPTY seed (runId `''`) accepts the cancel and adopts its runId, as `run.triggerContext` does. A `run.started` carries a folded cancel, so a start racing it finishes `cancelled` without dispatching.
- **`reason`** is `cancelled:<source.kind>` on every cancelled finish.
- **Web:** `cancelled` is a neutral pill and tone, and it is offered rerun-from-failed. The server's existing rule ("terminated and not `success`") already admits it, per D9.

### CX2 — as built

- **Where things live.** `run/cancel.ts` holds the intent map and poke registry (`RunCancels`), plus the ONE cancelled-failure builder (`runCancelledFailure`, code `run_cancelled`). `run/cancel-service.ts` holds the route's half. `driver.ts` holds `onCancelFolded` (never throws, so a failed abort cannot strand a fold without its finish), `foldPendingCancel` (used by `startRun`, `drive` and `reconcileOne`), and `driveCancelIntent`, the serialized task. It takes the lock, does nothing if the intent is gone, and discards the intent afterwards if the run had already ended.
- **The pump's poke puts its marker at the FRONT of the inbox**, so a queued `node.succeeded` cannot dispatch a successor before the cancel folds. The pump also pushes a marker at start if an intent is already pending. That covers the boot reconciler, which folds at the top of `reconcileOne` and can `await` before it pumps.
- **A cancelled attempt never waits for a global adapter slot.** The executor listens for the abort while the attempt is queued behind the global `p-limit`. It fails the attempt at once and skips the adapter, because the slot may belong to other runs' long adapters, and waiting would hold the cancelled run and its drive lock for as long as they take. An attempt aborted during its pre-flight fails without a `node.dispatched`. A stream still queued behind the per-run cap is replaced by the cancelled failure in the pump. A throw from an adapter after the run's abort reports `cancelled`, not `ADAPTER_THREW`.
- **D7 folds a still-pending intent first**, then finishes: each `dispatched` node fails `run_cancelled`, `resume` fails the lost `ready`/call nodes, and the run settles to D3's finish. A `pending` run whose cancel folded but whose `run.finished` was lost gets `cancelFinish` directly. The boot sweep routes a never-started row whose log holds `run.cancelRequested` into that branch rather than terminalizing it `interrupted`.
- **A `queued` run cancelled by row patch has no bus event**, so the canceller calls `onQueuedRunCancelled`. Production wires that to the tumbling service's `settleRunWindow`, the completion tap's own body, because a window links its run while the run is still queued.
- **`startRun` on a run a cancel already finished** returns the terminal state quietly instead of throwing "already has an event log".
- **D1 literal-comparison grep:** `scheduler/tumbling.ts` `settleIfTerminal` was the one hang, now fixed under D9, and window `runStatus` gained `cancelled`. `run/child.ts` maps a cancelled child to `failure` for the parent, which is deliberate and is CX3's to revisit (CX3 now passes it through as `cancelled`). `reseed.ts` already admits `cancelled`. The web had already been updated in CX1. Admission selects `queued` rows only, and a test pins that a cancelled queued row is never admitted.
- **Known until CX3, and not a hang (CLOSED by CX3, see below):** a parent parked on a live child counts that call node as in flight. Cancel mode never parks, so a cancelled parent becomes `running` with no pump until the child ends (or a lease reclaim runs D7). Until then it holds its admission slot. A `startChild` already queued behind the per-run cap when the cancel folds still spawns its child. CX3's propagation closes both, so CX4's UI must not promise an immediate stop for a run waiting on a child.
- **Deferred:** a queued run cancelled before admission counts as "served" in the S6b fairness order (#1326).

### CX4 — as built

- **Where things live.** `web/src/pages/runs/cancelAction.ts` holds the offer test (`canCancelRun`: `pending`/`queued`/`running`/`waiting`, D5) and the confirmation text. The page wires it the way it wires rerun: `window.confirm`, then `cancelRun` (`api/runs.ts`), with the server's `409` sentence shown verbatim.
- **"Cancelling…" is read off the LOG, never the `202`.** `deriveRunLifecycle` gained `cancelRequested`, set by a folded `run.cancelRequested`. A `requested` answer means only that the intent was accepted, and an intent lost with a crashed process leaves the run running (D6/D7). So the header says "Cancelling…" only once the fact is on the log, and the Cancel control is withdrawn at that point. A run whose node is waiting on a child also gets a hint that the child is being cancelled too (reworded by CX3).
- **Queued.** A `cancelled` answer is the D5 row patch, and no event will tail in, so the page re-reads the row. If that re-read fails, the page patches the row to `cancelled` itself, because the `202` already said so. It does not raise a "cancel failed" alert over a cancel that worked.
- **The node words depend on the run.** Under a `cancelled` run, a node or container left non-terminal keeps its live status in the log (D2/D4, and a parked node under D5). Its word changes, and (since #1329) so does its colour: the graph tone becomes `neutral` and the table/drill-in pill the muted `node-status-cancelled`, because the `holding`/`running` hue of a live status claims something is still advancing. It reads "not run (cancelled)" if it never started and "stopped (cancelled)" if it was live. `nodeStatusLabel`/`containerStatusLabel` take the run status (a `ready` node never began, so it reads "not run"), and the table, the drill-in panel and the graph all pass it, so the three surfaces keep one vocabulary (U25). #1329 extended the same run-awareness to the attempt timeline, for an OPEN span only (a closed span did end, even into a hold), and to the drill-in's duration sentence for a started attempt ("cancelled while this attempt was live", no "yet").
- **The confirmation** names every node in progress (dispatched, ready, retrying or parked) in the table's words. It always says that work already sent is not undone (open question 1), and it adds the child caveat when a call node is waiting on a child.
- **e2e** (`e2e/run-cancel.spec.ts`) cancels a real in-flight `agent_task` subprocess (`sh -c 'sleep 120'`) and a run parked on a one-hour `wait`. The first asserts that the run is `cancelled` well inside the subprocess's lifetime, so the kill is real. It also checks that the pill is the neutral muted colour, not red. Both assert the node words.

### CX3 — as built

- **One propagation function, two callers.** `cancelLiveChildren` (`run/cancel-service.ts`) cancels a parent's children through the route's own `RunCanceller.cancel` (intent, poke, serialized drive), so a child's cancel is delivered exactly as an operator's is. It is wired as `RunCancels.cancelChildren`, on the registry rather than as a new dependency, because every holder that folds a cancel already holds the registry. `onCancelFolded` calls it with `parent_cancelled`. The terminal tap in `subscribeChildReturns` calls it with `parent_terminal` for every run that ends (#1056's live path). A parent cancelled earlier already asked, and asking again records nothing.
- **Which children.** A child is reached only if its row is non-terminal, the parent's log ANNOUNCES it (`call.started`), and `detachVerdict` says the parent did NOT detach from it. A detached child and an undecidable one (announced, no `call.detached`, no parent doc) are left running, the reversible act. A parent log that cannot be read reaches no child. `detachVerdict` moved from `reconcile.ts` to `child.ts` so the reconciler and the propagation share it.
- **The unannounced child is caught at `kick`.** `ensure` creates a child's row before the parent's `call.started` is appended, so a cancel can fold between the two. Propagation skips such a child, because skipping it keeps the #1041 sweep able to start a detached child that was never kicked. Instead, `kick` checks the parent's log under the child's lock, where the announcement is already durable. If the parent has folded a cancel, or has ended, and has not detached from the child, `kick` records the intent and `startRun` folds it first. The child then finishes `cancelled` with no `run.started`.
- **A `startChild` still queued behind the per-run cap** when the cancel folds never creates its child. The pump answers it with `call.returned{childOutcome:'cancelled', outputs:{}}` (`childNeverStarted`, `cancel.ts`), since a `waiting` call node takes no `node.failed`.
- **A cancelled child is `cancelled` to its parent.** `ChildRuns.result` no longer flattens it to `failure`. The reducer still fails the call node, but under the parent's own cancel it counts as stopped work (D3). Without this, a parent whose cancel reached its child finished `failure`. The same holds when the child returns none of the call node's required outputs: the invalid-outputs arm marks stopped work too, and keeps its diagnostic.
- **The #1053 boot guard is now a cancel.** A started child of a terminal parent gets `run.cancelRequested{parent_terminal}` and the D7 finish, and is reported `finalized`. It is no longer `run.interrupted{parent_terminal:…}`, so a crash and the live path end the child the same way. An operator intent already pending for the child is folded first and keeps its source. The guard now needs the child's doc, so a child whose parent is over AND whose version is gone is frozen `doc_unresolvable:` instead. Old `interrupted` logs are untouched.
- **Wiring.** The canceller is built in `index.ts` before child execution and boot reconcile, since both can fold a cancel whose propagation calls it. A lazy closure over a later `const` would have hit its temporal dead zone and been swallowed by the propagation's catch.
- **A parent parked on its child finishes at once.** A parent with no live pump folds its cancel through the serialized drive, and `resumeCancelled` fails its `waiting` call node at once. So it finishes `cancelled` without waiting for the child, whose own cancel lands on its own drive (D8, best-effort). Only a parent whose pump is still draining a sibling waits for the child's `call.returned`. That is the one case where the run page's "child is being cancelled too" hint shows.
- **Out-of-band `call.returned` beside a live pump.** When a cancel reaches a child while the parent's pump is still draining a sibling, the child's result arrives through `returnToParent`'s out-of-band append (#1021). This is harmless in cancel mode. The pump cannot finish while its in-memory call node is still `waiting`, and the `driveRun` queued behind it finishes the run.
- **Not changed:** `sweepOne` still row-patches a never-started child of a terminal parent to `interrupted` (#1041). That child never ran, so no cancel fact is owed.

### CX5 — as built

Each D9 consumer that does not hang, walked and pinned:

- **Rerun-from-failed.** `reseed.ts` already admitted `cancelled` ("terminated and not `success`").
  Pinned server-side (`reseed.test.ts`, CX5): the strict-prefix frontier is copied and the node the
  cancel aborted re-runs. The web half was already pinned in `rerunAction.test.ts`.
- **Tumbling window.** Nothing new: CX2 landed the rule and its test (`tumbling.test.ts`, "a
  CANCELLED run fails its window and never retries, even with budget left").
- **External-wait completion.** Refused against the log's terminal fact, like any terminal run. The
  owner route answers **409** `external_wait_settled`, and the anonymous token route answers its one
  fail-closed **404**. Both append nothing (`external-wait.test.ts`, CX5, through the real cancel
  route).
- **Retry alarm mid-drain.** The cancel folds every `retry_pending` hold to failure (D4), so
  `nodeParkedAtAttemptGuard` refuses the alarm (`node_not_held_at_attempt`) even while a sibling is
  still draining. No `node.retryDue` is written (`retry-alarm.test.ts`, CX5).
- **Container timeout mid-drain: a defect, fixed here.** Measured before the fix: with a loop's child
  still in flight after the cancel, the timeout alarm was *fresh* (the loop is still `active`). It
  abandoned the child, exited the loop `failure/timeout`, and finished the run **`failure`** although
  the operator had cancelled it. Now both layers refuse it. `containerActiveGuard` answers
  `run_cancel_requested`, so nothing is appended, and `onContainerTimedOut` is a no-op under a
  cancel, so a replay stays total. The in-flight node's `node.failed{cancelled}` finishes the run
  `cancelled`.
  **Migration posture (#443):** this changes how an existing event folds, so it matters whether a
  log already holds a `container.timedOut` after a `run.cancelRequested`. Measured on the live
  service database when this landed: it had **no** `run.cancelRequested` at all, since CX2 shipped
  the same day. So no bound log changes meaning. A crash between such a timeout and its finish would
  leave the child `dispatched`, and D7 ends that (`node.retryRequested` folds it to failure under a
  cancel), so it cannot hang.
  **The trade-off, accepted by D9's "is suppressed":** a timeout kills nothing, but it does end the
  loop in the fold. An adapter that ignores its abort signal (the executor does not race
  `ctx.signal` once the adapter has started) therefore keeps a cancelled run live, where the timeout
  would have ended it. That failure belongs to the adapter's abort contract, and the crash path
  still has D7.
- **Wait and external-wait alarms mid-drain: deliberately NOT suppressed.** A `timer.due` completes
  its wait, and an expiry fails its webhook. Neither starts work under cancel mode, and the outcome
  stays truthful (D3), so refusing them would add a guard with nothing to protect (pinned in
  `run-cancel.test.ts`, CX5).
- **Cancelled `copy` (open question 2).** Already pinned at the adapter:
  `copy-delimited.test.ts` ("names the COPY when an already-cancelled dispatch aborts"). CX adds
  nothing.
- **Admission / cost / run list:** unchanged from CX2/CX4. A cancelled run frees its slot at
  terminal like any terminal, and a cancelled `queued` row is never admitted (CX2).

## Open questions (none block CX1)

1. **Confirmation copy for a run with an in-flight side-effecting node** (an `http` POST, a `copy`
   into a sink). A cancel cannot un-send a request. CX4 should say "work already sent is not undone"
   rather than imply a rollback. That is wording to settle in CX4, not a design fork.
   **Settled in CX4:** the confirmation always says *"Work already sent (a request made, rows
   written) is not undone."*
2. **Should a cancelled `copy` report `rowsWritten`?** The data-movement spec §10 already says a
   cancel must never leave a silent partial, and the copy adapter already implements that. CX adds
   nothing and only checks it end to end in CX5.
