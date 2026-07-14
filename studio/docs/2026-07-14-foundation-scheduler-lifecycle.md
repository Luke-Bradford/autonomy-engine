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
| S1 | Durable-scheduler primitive (`scheduled_wakeups` + boot re-arm) — retry/wait/webhook re-point onto it |
| S2 | Recurrence model + compile (frequency/interval/advanced/timeZone) + cron escape-hatch |
| S3 | Per-pipeline concurrency admission (queue overflow) in the launcher |
| S4 | Run lifecycle status model + `waiting` sub-states + durable transitions |
| S5 | Run leasing/heartbeat + lease-expiry reclaim (on S1) + boot-reconcile formalization |
| S6 | Event/webhook trigger firing via the event bus + `externalWait` (with #4 A13) |
| S7 | Tumbling-window: window-state ledger + `${trigger.window*}` + single-fire-per-window |
| S8 | Tumbling-window: backfill (bounded) |
| S9 | Tumbling-window: self-dependency (offset/size) admission |
| S10 | Tumbling-window: per-trigger retry policy + concurrency cap |

## Non-goals

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
