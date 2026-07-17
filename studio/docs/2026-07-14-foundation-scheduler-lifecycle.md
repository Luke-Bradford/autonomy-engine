# Foundation Spec #5 — Scheduler, triggers & run lifecycle

**Status:** proposed — brainstormed + ADF-grounded + engine-grounded 2026-07-14; pending Codex review.
**Scope:** the cross-cutting system the integration review pulled out of #1/#3/#4 — trigger types +
recurrence, the **one durable-scheduler primitive** (owns all time-based firing), concurrency/
admission, and the full **run lifecycle** (statuses, queueing, leasing, boot reconcile). This spec
**OWNS the scheduler primitive** that #1 (retry) and #4 (`wait`/`webhook`) consume — resolving the
"double-defined timer" finding.
**Non-goal:** the activities themselves (#4), the UI recurrence builder (UI U14b renders this).

## ADF grounding (MS Learn: `concepts-pipeline-execution-triggers`)

- **Schedule trigger** — wall-clock recurrence: `frequency` (Minute/Hour/Day/Week/Month) + `interval`
  + advanced `schedule` (hours, minutes, weekDays, monthDays) + `startTime`/`endTime`/`timeZone`.
  Many-to-many (a trigger → many pipelines, a pipeline ← many triggers). No backfill, no built-in retry.
- **Tumbling-window trigger** — periodic + **STATEFUL**: each window is an isolated run keyed by its
  interval; **backfill** (windows in the past from `startTime`); `WindowStart`/`WindowEnd` exposed as
  trigger outputs; per-trigger **retry policy**; **concurrency 1–50**; **self-dependency** (a window
  waits for prior windows to succeed); one-to-one pipeline.
- **Event-based trigger** — responds to an event.

## Current engine (verified)

- Modes: `manual | schedule | webhook | event | continuous`. Concurrency policy
  `queue | skip_if_running | parallel`. `schedule` = a raw cron string. `runWindows`.
- Scheduler (P4b): one `croner` `Cron` per eligible schedule-trigger; each tick funnels through the
  shared **RunLauncher** — which owns the load-bearing **"unbound never fires"** + **concurrency
  admission**. UTC. Freshness-over-caching (re-reads the trigger each tick). Never throws.
- Runs carry `leaseUntil`, `heartbeatAt`; boot reconciler (P2d) sweeps orphaned `running` → interrupted.

## Design

### S1 — The durable-scheduler primitive (SSOT; built FIRST)

A driver-owned **durable alarm**: `{ dueAt, kind, ref }` persisted (a `scheduled_wakeups` table),
survives restart, re-armed at boot. On `dueAt` the driver appends the domain event. **Every
time-based firing consumes it** — schedule ticks, **retry** (`node.retryDue`, #1), **`wait`**
(`timer.due`, #4), **`webhook` expiry** (`externalWait.expired`, #4), **tumbling windows**, and
**lease-expiry** reclaim. One clock, one persistence, one boot re-arm — NOT a per-feature timer.
(Reducer stays pure: it emits "schedule an alarm" commands; the driver owns wall-time.)

### S2 — Recurrence model (schedule triggers)

Replace the raw cron string with an ADF-style **recurrence**: `{ frequency, interval,
schedule?: { hours[], minutes[], weekDays[], monthDays[] }, startTime?, endTime?, timeZone? }`
compiled to fire times (croner under the hood; `timeZone` default UTC per the run-window contract).
**Cron string kept as an escape-hatch mode.** The UI recurrence builder (U14b) authors this.

### S3 — Tumbling-window trigger (NEW, stateful)

- **Window state** — each window `[windowStart, windowEnd)` is a distinct run keyed by `windowStart`
  (idempotent: a window never double-fires). A `tumbling_window_state` ledger tracks per-window
  status (waiting / running / succeeded / failed).
- **Backfill** — on create/enable, windows from `startTime` to now are enqueued (bounded, rate-limited).
- **`${trigger.windowStart}` / `${trigger.windowEnd}`** — exposed to the `${}` language (a new
  `trigger` namespace; validated at save).
- **Self-dependency** — a window run is admitted only after prior window(s) reach success (with an
  `offset`/`size` like ADF); otherwise it waits.
- **Per-trigger retry policy** + concurrency cap (1–N). One-to-one pipeline (mirrors ADF).

### S4 — Event / webhook triggers

`event`-mode + `webhook` triggers fire from the **event bus** (an inbound, authed, correlated
signal). Reuses #4's `externalWait` family for the inbound-HTTP case; a fired trigger enqueues a run
through the same launcher/admission path. (Event-source breadth — file/queue/etc. — is later.)

### S5 — Concurrency & admission (the launcher, one place)

The launcher owns admission, extended to TWO limits:
- **Per-trigger** concurrency `policy: queue | skip_if_running | parallel` + `max`.
- **Per-pipeline** `concurrency` (#1 D1 — max concurrent runs across all its triggers; overflow
  **queues**).
Plus the invariants: **"unbound never fires"** (refuse `pipelineVersionId === null`), run-window
gating, and **active-pointer resolve-once** (#3 — bind-to-active resolves to a concrete version at
create, never a live rebind). A refused/queued fire is a first-class outcome, not a drop.

### S6 — Run lifecycle & statuses

Formalize the status model (extends today's pending/running/success/failure/interrupted):
`pending → queued (admission overflow) → running → {success | failure | interrupted}`, plus a
**`waiting`** run sub-state with a reason: `waiting_timer` (wait), `waiting_external` (webhook),
`waiting_concurrency` (slot), `waiting_dependency` (tumbling self-dep). Each transition is a durable
event (Monitor timeline reads them). **Run leasing** (`leaseUntil`/`heartbeatAt`): a run is leased to
a worker, heartbeats; a **lease-expiry alarm** (S1) reclaims a dead worker's run; **boot reconcile**
(P2d) sweeps orphans → interrupted or resumes per the per-activity idempotency policy.

## How it hangs together

- **S1 is the corrected-build-order "generic scheduler primitive, one early ticket."** #1 retry and
  #4 wait/webhook are re-pointed to consume it (removing their standalone timer definitions).
- **S5 admission** is the single home for "unbound never fires" (#1/#3 immutability), per-pipeline
  concurrency (#1 D1), active-pointer resolve-once (#3).
- **S6 statuses + durable transitions** feed the **observability/read-model** interlock (#overview 11)
  and Monitor (UI U10–U12).
- **`${trigger.*}`** joins `${params/vars/nodes/run/global}` in the inert `${}` language (#1),
  validated at save.

## Ticket decomposition (S-series, ordered; each ≈ a fire)

| # | Ticket |
| --- | --- |
| S1 | **Durable-alarm OUTBOX** (`scheduled_wakeups` + at-least-once + dedupe keys + boot re-arm) + the consumer SEAM. **SHIPPED 2026-07-15** — see the S1 block below. **AMENDED: the original row said "+ ONE consumer (retry)"; that is the retry-first framing the integration review explicitly corrected** (overview: *"Scheduler primitive is ONE early abstraction, not retry-first-then-generalized"*, and its build order splits the primitive (item 5) from policy/retry (item 6)). Retry cannot ride along regardless: it needs F2a's `Node.policy` (does not exist), F2b, and the D4 HOLD-or-reopen reducer decision this spec's own spike block defers — see `reduce.test.ts`'s F0 scope-lock. First consumer = **F2b retry**. |
| S2 | Migrate `wait` (#4) + `webhook`-expiry (#4) onto S1 |
| S3 | Run lifecycle status model (`pending|queued|running|waiting|terminal` + reason) — all transitions durable events |
| S4 | Lease/slot release for `queued`+`waiting` runs (split execution-lease from lifecycle) |
| S5 | Recurrence model + croner-as-calculator producing wakeup rows + schedule catch-up (no-backfill, ≤1 late). **S5a SHIPPED** the croner-as-calculator + catch-up halves (durable `schedule_tick` rows replace in-memory crons — see the "S5a — SHIPPED" block below); the ADF **recurrence MODEL** is split out to **S5b**. |
| S6 | Admission: per-trigger + per-pipeline (both-must-pass) + fair queue (durable `queuedAt`, round-robin) |
| S7 | Lease-expiry reclaim with generation tokens (on S1) + boot-reconcile formalization |
| S8 | Event/webhook trigger firing via event bus + `externalWait` (with #4 A13) |
| S9 | Tumbling-window: window-domain EVENTS (`window.created/runCreated/…`) + projection + config-versioned window key + single-fire |
| S10 | Tumbling-window: bounded backfill (maxBackfillWindows + durable cursor, incremental via S1) |
| S11 | Tumbling-window: self-dependency (blocked windows in state, NOT runs) + per-trigger retry/concurrency + `${trigger.window*}` (context-scoped) |
| **S12** | **Trigger→pipeline PARAM BINDINGS + run-now override (T2, load-bearing):** the durable **`run.triggerContext` seed event**; **expression-valued trigger param bindings** (`{param: ${trigger.scheduledTime}}` / `${trigger.body.x}`) resolved fire-time; a **`POST /api/triggers/:id/fire` run-now param-override body**; precedence **pipeline-default < trigger-binding < run-now override**; save-time validation. Unblocks event/schedule/manual dynamic invocation. **S12a SHIPPED** the durable seam + the read surface: the `run.triggerContext` seed event (appended by the launcher/driver before `run.started`, folded into `RunState.triggerContext`) and the `${trigger.*}` expression ROOT (`triggerId`/`scheduledTime`/`body`, a closed `TRIGGER_FIELDS` set) so node configs read fire-time trigger context; the launcher/scheduler plumbing threads the fire-time context (schedule fires seed `scheduledTime` = the intended occurrence). The PARAM-BINDING layer is split out to **S12b**: expression-valued trigger param bindings resolved fire-time, the `POST …/fire` run-now override body, the pipeline-default < trigger-binding < run-now precedence, and save-time BINDING validation. (`body` is plumbed but has no production feeder until webhook/event fire — S8, blocked on #4 A13; schedule/manual fires carry `null`.) |

## Codex-hardened CORE (folded)

- **S1 = an at-least-once durable-alarm OUTBOX, not exactly-once.** Row `{id, kind, ref, dueAt,
  dedupeKey, status, claimedAt, firedAt, supersededBy?}`, **unique `(kind, dedupeKey)`**. Fire =
  append the domain `*.due` event + mark fired **in ONE SQLite txn**; duplicate delivery folds as a
  no-op (uniqueness). The **event log is the domain truth; `scheduled_wakeups` is driver infra.**
- **Typed `ref` + freshness predicate per kind** (runId/nodeId/attemptId/timerId/triggerId/
  windowKey/leaseToken) — every due event re-checks currency before it fires, so stale retries /
  expired leases / disabled triggers can't emit valid-looking events.
- **Croner is a RECURRENCE CALCULATOR, not a firing source.** It computes "next occurrence" →
  writes a durable wakeup row. On wakeup: re-read trigger state (no-op/`trigger.fireSuppressed` if
  disabled/unbound/out-of-window), fire through the launcher, persist the next occurrence.
- **Reducer command idempotency:** `scheduleRetry`/`scheduleWait` commands **upsert by deterministic
  key** (commands re-emit on replay) — the log's `node.retryScheduled`/`timer.scheduled` is the
  fact, appended atomically with the row.
- **Catch-up policy is explicit per kind:** schedule = **no backfill** (≤1 late fire then next
  future); tumbling = **bounded** backfill; retry/wait/webhook/lease = overdue fires on boot.
- **`waiting`/`queued` runs release the execution LEASE and (by default) the concurrency SLOT** —
  a run parked on a timer/webhook/dependency for hours must not occupy a worker or a slot. `running`
  = actively executing; resumption is event-driven. (`queued` = pre-admission; `waiting.reason` =
  timer/external/dependency, whole-run or node-scoped, defined per case.)
- **Every lifecycle transition is a durable event** (`run.queued/admitted/waiting/resumed/
  interrupted/finished`, `trigger.fireSkipped/Suppressed`) — no status-only DB mutation except
  event-derived projections.
- **Admission = BOTH per-trigger AND per-pipeline capacity;** overflow enters ONE admission queue
  ordered by durable `queuedAt` with per-trigger round-robin (no monopoly). `skip_if_running`
  applies before queueing.
- **Lease-expiry alarms carry a generation token** (`leaseToken`/expected `leaseUntil`); reclaim
  only if the current row still holds that token and is expired (heartbeats supersede old alarms).
- **Tumbling state = projection, not truth.** Window lifecycle is domain events; the
  `tumbling_window_state` table is a materialized projection with uniqueness. **Window key =
  `{triggerId, triggerConfigVersion, windowStartIsoUtc, interval}`** (editing a tumbling trigger
  mints a new config epoch). **Blocked/backfill windows live in window state, NOT as full runs**
  (avoid flooding the run table); exactly one run materializes per window when deps + capacity allow,
  pinned to the **trigger's version at materialization time** (never a later active pointer).
- **`${trigger.windowStart/End}`** — typed timestamps, inert, **allowed ONLY in
  tumbling-window-bound pipelines** (save-time context validation), not global to manual/schedule runs.
- **Late-alarm observability:** every due event carries `scheduledFor`, `firedAt`, `latenessMs`.

## Spike-hardened (validated in code, 2026-07-14 — throwaway outbox prototype, 11 tests green)

- **BIGGEST: D4 retry is NOT implementable without a reducer change — RESOLVED 2026-07-15, and it is
  NOT this spec's to own.** ~~Today~~ **(pre-F1b; F1b has since SHIPPED the drain — `settle` no
  longer short-circuits, and the outcome predicate is now the single `runOutcomeFailure`. The
  sentence is kept because it is why the fork existed.)** `node.failed` → `settle` →
  `firstUnhandledFailureTop` → `finishRun{failure}` **terminalized the run on the first unhandled
  failure**, and
  `node.retryRequested` only fires from a LIVE node — never a terminal `failure`. `node.retryDue`
  **isn't in `EngineEventSchema`** (the reducer rejects it). The fork — **(i) a retryable-failure HOLD
  state or (ii) a re-open event** — was settled as **(i) HOLD** by **#472**, and is specced in
  [`2026-07-15-foundation-run-outcome-and-retry.md`](./2026-07-15-foundation-run-outcome-and-retry.md),
  jointly with F1b (#442) because they are the same predicate (all five questions now settled there). **Ownership was the real defect:** this
  bullet said "spec it before F2b/F2c build" while spec #1 line 223 called the fork "#5's" — each spec
  deferred to the other, so nobody owned it and it slipped to the point where F2b was next in the
  build order with no semantics under it. The joint spec is now the SSOT; this spec keeps only the
  scheduler-side consequence: **S1's `scheduled_wakeups` row is the liveness mechanism for a held
  node** (`onResumed` re-emits only for `ready`/`waiting`, so HOLD has no other boot-recovery path) —
  which is why F2b must ship with F2c.
- **S1 fire = ONE `better-sqlite3.transaction()`** wrapping `appendEngineEvent` + `UPDATE …
  status='fired'`. Nesting works: `appendEngineEvent`'s own drizzle tx drops to a **SAVEPOINT** and
  rolls back together on throw — so S1 reuses it as-is (no refactor). The `seq = MAX+1` compute must
  sit inside that tx (single-writer SQLite backs it).
- **`dedupeKey` schema is a SPEC artifact, not impl detail:** `(kind, ref, discriminator)` where
  discriminator = **attempt-n** (retry) / **round-r** (loop) / **tick-epoch** (cron). `dedupeKey`
  alone is NOT globally unique; omitting the attempt number makes attempt-2's retry collide with
  attempt-1's already-`fired` row → it **silently never arms**. `nextRetryAt`/backoff is a STORED fact
  in `scheduled_wakeups.dueAt`, never recomputed at fold time (reducer stays clock-free; dispatch
  stamp on `run_events.ts`, replay-stable — proven by folding the log twice with `Date.now` shifted).
- **Exactly-once is fiction; the real contract is at-least-once + idempotent fold.** The unique
  `(kind,dedupeKey)` dedupes ARMING; **`attemptId` staleness dedupes DELIVERY** (a duplicate wakeup
  re-appends `node.retryRequested{previousAttemptId}`, folded as a no-op once `currentAttemptId`
  advanced). State both layers.
- **Croner → table-claim loop.** On boot, claim overdue rows (don't just rebuild in-memory crons);
  add an explicit **catch-up policy** for alarms whose `dueAt` passed during downtime (fire-once /
  coalesce / skip per kind). Pending wakeups survive restart because they are ROWS — the headline S1
  win, proven.
- **Multi-worker needs a LEASE column** (`claimed_by`, `claim_expires`) before the single-writer
  `MAX+1`/single-claim assumptions can relax — flag on any S-tier that scales the scheduler.

## S1 — SHIPPED 2026-07-15 (the decisions, as built)

The outbox + seam are live: `shared/src/schemas/wakeup.ts` (row + `buildDedupeKey` SSOT),
`server/src/repo/scheduled-wakeups.ts` (persistence), `server/src/scheduler/alarms.ts` (the clock).
What the hardened blocks above said, and what actually shipped:

- **Honoured as written:** UNIQUE `(kind, dedupeKey)` dedupes ARMING · `dedupeKey =
  (kind, ref, discriminator)` with the discriminator **required** (the spike's silent-never-arms
  regression is pinned by a test that fires attempt-1 then arms attempt-2) · fire = **ONE**
  `db.transaction()` wrapping handler + settle, with `appendRunEvent`'s own tx nesting as a
  SAVEPOINT (proven against the real append path, not asserted) · at-least-once + idempotent fold ·
  typed per-kind `ref`, validated at **arm** time via each handler's `refSchema` · `dueAt` a STORED
  fact · late-alarm `scheduledFor`/`firedAt`/`latenessMs` · rows survive restart (proven against a
  real file, closed and re-opened — not `:memory:`) · overdue-fires-on-boot needs no special code
  path (an alarm whose `dueAt` passed is simply due, and the first `tick()` claims it). **The boot
  PATH itself — a ticker, a `start()`, the `buildApp` wiring — lands with the first consumer (F2b),
  since a cadence with no handler has nothing to fire;** what S1 proves is that pending rows survive
  and a fresh clock fires them.
- **`kind` is an OPEN string, `status` a closed enum + CHECK.** No consumer exists yet, so a `kind`
  vocabulary would be speculative *and* a durable back-compat trap. The **handler registry is the
  runtime authority**: an unregistered kind is never claimed (the scan filters by registered kind),
  so its row stays `pending`, visible and recoverable rather than claimed-and-dropped or spinning.
- **AMENDED — the row ships the fields that have a WRITER; `claimedAt` and `supersededBy` are
  absent.** The Codex row shape is `{id, kind, ref, dueAt, dedupeKey, status, claimedAt, firedAt,
  supersededBy?}`. One rationale, applied consistently — **a column with no writer is unreachable
  surface**, the same defect this table avoids by keeping `kind` open rather than guessing a
  vocabulary:
  - `claimedAt` / a `claimed` status — the spike proved the fire is ONE transaction, which removes
    the suspension point a claim step exists to protect. A persisted `claimed` would exist only to
    be swept after a crash; a crash mid-fire already rolls back to `pending`, re-delivered next
    tick, which IS the at-least-once contract. The multi-worker claim lease
    (`claimed_by`/`claim_expires`) the spike flags for a later S-tier lands as one coherent change
    **if** this outgrows better-sqlite3's single writer. In-tick re-entrancy is an in-memory flag.
  - `supersededBy` + `supersede` (cancel-old + arm-new) — **S7 surface, deferred to S7** (#465).
    Its only spec anchor is *"heartbeats supersede old alarms"*, which the ticket table places at
    S7 (lease-expiry generation tokens). It was built here first and the pre-PR review found it had
    already produced a silent-lost-alarm: the guard compared the replacement KEY, but arming is
    upsert-if-absent, so a replacement colliding with any pre-existing row returned that spent row
    while the live alarm was still cancelled. Exactly what a primitive with no consumer to pin its
    semantics gets wrong. It lands at S7 via `ALTER TABLE ... ADD COLUMN superseded_by TEXT`
    (native in SQLite — not the table-recreate a CHECK change would need).
  - **Consequence, stated plainly:** an armed alarm is IMMUTABLE — there is no way to move a
    `dueAt`. A caller wanting a later alarm arms a NEW one under a new discriminator.
- **AMENDED — `isFresh` is not a separate registry predicate.** Freshness is `fire`'s discriminated
  return (`fired` | `suppressed{reason}`), because a suppression must be able to append its OWN
  durable event (`trigger.fireSuppressed`) in the same transaction as the settle — a boolean
  predicate + a status-only mutation would violate this spec's "no status-only DB mutation" rule.
- **NEW — handlers are synchronous and may touch only `db`; anything that SPAWNS work returns via
  `afterCommit`.** Found by the planning gate and verified in code, not theorised:
  `launcher.fire()` returns synchronously but its synchronous prefix already writes the `runs` row
  (`run/launcher.ts:219`), then appends `run.started` and publishes to the bus via the un-awaited
  IIFE at `run/launcher.ts:228-230` → `run/driver.ts:205-220`, all before the first suspension —
  so the obvious "fire a run from a handler" would, inside the fire tx, let a rollback erase a run
  row that a detached async drive kept appending against, after live WS subscribers had already seen
  its `run.started`. For the same reason the clock publishes handler events to the bus **after**
  commit rather than letting handlers pass the bus to `appendEngineEvent` (which publishes
  immediately after its append). **S5/S8 must use `afterCommit` to reach the launcher.**
  `afterCommit` is typed `() => void | Promise<void>` and the clock SETTLES the promise: TypeScript's
  void-return rule would make an `async` handler assignable to a bare `() => void`, and its rejection
  would then float past the tick's synchronous guard as an unhandled rejection — the fault
  `scheduler.ts:100-103` documents for croner and defends twice. Spawning work is overwhelmingly
  async, so that is the likely case, not the edge.
- **DEFERRED — the per-kind `catchUp` policy field** (`fire`/`coalesce`/`skip`). The *behaviour*
  this spec mandates for retry/wait/webhook/lease ("overdue fires on boot") ships and is tested; the
  *field* does not, because no consumer needs a non-`fire` policy yet and its semantics would be
  guesswork. It is a registry field — code, no migration, no durable format — so it costs nothing to
  add with the first kind that needs it: **schedule ticks (S5, "≤1 late fire")** and **tumbling
  backfill (S10)**. Filed as #463.
- **Retention — SHIPPED (#464).** `fired`/`suppressed`/`cancelled` rows are pruned once older than a
  floor (`WAKEUP_RETENTION_DAYS`, default 30 days; `0` disables): `pruneSettledWakeups` +
  `drainSettledWakeups` (bounded, oldest-first, drained to a fixpoint) run at boot and on an hourly
  `unref`'d sweep in `buildApp`, served by a partial `scheduled_wakeups_retention_idx` on `fired_at`
  over settled rows. Safe because every current kind's re-arm window (minutes–hours) is orders of
  magnitude inside the floor, so a fired key is never freed while it could still be re-armed (the full
  per-kind argument is in `repo/scheduled-wakeups.ts`). The sibling `webhook_deliveries` gap is now
  ALSO closed (#421): `WEBHOOK_RETENTION_DAYS` (default 30 days; `0` disables) drives
  `pruneWebhookDeliveries`/`drainWebhookDeliveries` on the same boot + hourly `unref`'d sweep, sharing
  the batching machinery (`repo/retention.ts`'s `drainByBatches`) but pruning by age across all
  outcomes (a `webhook_deliveries` row has no settled-resurrection invariant — see that repo's safety
  note). The two remain SEPARATE mechanisms over one shared batching primitive, not one merged sweep.
- **NOT wired into `buildApp`.** The clock is constructed by its first consumer (F2b), rather than
  this ticket shipping an inert boot path with an empty registry.

## S5a — SHIPPED (durable schedule ticks; the croner-as-calculator half of S5)

S5 as tabled bundles three things: (1) croner-as-CALCULATOR producing durable wakeup rows,
(2) schedule catch-up, (3) the ADF **recurrence MODEL** (`{frequency, interval, schedule?, …}`).
S5a ships (1)+(2) and defers (3) to **S5b** — a clean cut along a real seam: the calculator consumes
a cron *string* whether hand-authored or compiled from the recurrence object, and the object pairs
with the UI recurrence builder (U14b, already a non-goal here). What shipped:

- **Croner is now a CALCULATOR, never a firing source.** `scheduler/recurrence.ts:nextOccurrence`
  computes the next fire time (UTC, strictly-after); `scheduler/schedule-tick.ts` is the
  `schedule_tick` alarm HANDLER; `scheduler/scheduler.ts` is now a RECONCILER that seeds/cancels the
  durable `schedule_tick` rows. The old in-memory `Cron`-per-trigger (a restart silently lost its
  pending tick) is gone.
- **The chain = one pending row per trigger.** Reconciler seeds occurrence 1; the handler, INSIDE the
  clock's transaction, arms occurrence *n+1* atomically with settling *n*, then fires the launcher in
  `afterCommit` (spec line 250's mandate — `launcher.fire` spawns a run and must never run inside the
  fire tx). A crash between commit and the launcher fire still leaves the next occurrence armed.
- **≤1-late-fire / no-backfill is STRUCTURAL, so the `#463` catchUp field is NOT added here.** Because
  exactly one row per trigger goes overdue during downtime, boot fires it once and
  `nextOccurrence(firedAt)` returns the next FUTURE slot (missed slots skipped). `fire`/`coalesce`/
  `skip` only matters when a kind arms MULTIPLE overdue rows — that is **S10 tumbling backfill**, the
  field's real first consumer. **#463 is re-scoped to S10, not closed by S5a.**
- **`ref = {triggerId, schedule}`** — a safe superset of the spec's "cron ref = the trigger". Carrying
  the armed schedule string lets a schedule EDIT be detected at fire time (`schedule_changed`
  suppression, no re-arm — the reconciler seeds the new chain) and lets the reconciler tell a stale
  row from a current one. The `tick-<dueEpoch>` discriminator still supplies the anti-silent-never-arm
  guarantee.
- **AMENDED — the named `trigger.fireSuppressed`/`fireSkipped` events (lines 137, 152, 193, 237–240)
  are NOT emitted in v1.** There is no trigger-scoped event log to append them to (a run log only
  exists once a run is created). A suppressed tick's durable trace is the settled `scheduled_wakeups`
  row's persisted `status` + `firedAt` (lateness is derivable against its `dueAt`; `latenessMs` itself
  is a computed `WakeupDelivery` field, not a column); the same treatment the retry handler gives its
  own suppressions (settle-only, reason debug-logged). A trigger-lifecycle event log is deferred to
  **S6 / the observability read-model** (#overview 11). Recorded here rather than dropped silently.
- **S3 (lifecycle status model) / S4 (lease release) are NOT prerequisites** for S5a — a schedule fire
  routes through the existing launcher/manual-fire path and needs no `queued`/`waiting` status.
- **Known properties (inherent, acceptable, better than the in-memory status quo):** a closed run
  window still writes one settled `suppressed` row per skipped occurrence (retention is #464,
  unsolved for every kind); a crash or an `UnboundTriggerError` race between commit and the
  `afterCommit` launcher fire loses that ONE occurrence's run (at-least-once is on the *alarm*, not
  the *run*; spec line 250) — the schedule itself survives because the next occurrence is already
  armed. **S5b (recurrence object)** must additionally honour `startTime`/`endTime` bounds; v1 relies
  solely on croner returning `null` for a finite/exhausted cron.

## Non-goals

- The **ADF recurrence MODEL** (`{frequency, interval, …}`) — S5b (see the S5a note above).
- Broad event sources (file/queue/db-change) beyond HTTP/webhook — later.
- Cross-trigger dependency graphs beyond tumbling self-dependency — later.
- The UI recurrence/trigger builder (UI U14b renders this).

## Open questions (for Codex / review)

1. Tumbling-window is a big surface (S7–S10) — is it v1, or deferred behind schedule+event? (Given
   "full breadth" it's IN, but confirm it's the last-built cluster.)
2. `scheduled_wakeups` granularity vs the in-process croner: does S1 replace croner, or does croner
   drive the tick and S1 persist due-alarms for retry/wait/window? (Leaning: S1 persists; croner is
   one consumer for schedule ticks.)
3. Per-pipeline vs per-trigger concurrency interaction — precedence + queue fairness when both bind.
4. `waiting` runs holding a lease vs not (a run waiting on a timer for hours shouldn't hold a worker).
