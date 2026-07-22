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
  `trigger` namespace; validated at save). *(As SHIPPED by S11b the surface is the tumbling
  trigger's PARAM BINDINGS only, not node configs — see the S11 row's conscious-deviation note.)*
- **Self-dependency** — a window run is admitted only after prior window(s) reach success (with an
  `offset`/`size` like ADF); otherwise it waits. *(As SHIPPED by S11d a blocked window waits IN
  WINDOW STATE — no run row, so no run-level `waiting_dependency` state; see the S11 row.)*
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
`waiting_concurrency` (slot), `waiting_dependency` (tumbling self-dep — *superseded by S11d as
shipped: a dependency-blocked window holds in WINDOW STATE with no run row, per the codex-hardened
"blocked windows live in window state, NOT as full runs", so this run-level reason never arises*).
Each transition is a durable
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
| S2 | Migrate `wait` (#4) + `webhook`-expiry (#4) onto S1. **SATISFIED BY CONSTRUCTION (verified 2026-07-22)** — there was never a standalone timer to migrate: both consumers were BUILT on S1's durable-alarm clock from their first commit (#4 A6's `scheduler/wait-alarm.ts` → `timer.due`, #4 A13's `scheduler/external-wait-alarm.ts` → `externalWait.expired`, both via the shared `createDurableAlarmHandler` skeleton, #585). No code ships under this row. |
| S3 | Run lifecycle status model (`pending|queued|running|waiting|terminal` + reason) — all transitions durable events |
| S4 | Lease/slot release for `queued`+`waiting` runs (split execution-lease from lifecycle) |
| S5 | Recurrence model + croner-as-calculator producing wakeup rows + schedule catch-up (no-backfill, ≤1 late). **S5a SHIPPED** the croner-as-calculator + catch-up halves (durable `schedule_tick` rows replace in-memory crons — see the "S5a — SHIPPED" block below); the ADF **recurrence MODEL** is split out to **S5b**. |
| S6 | Admission: per-trigger + per-pipeline (both-must-pass) + fair queue (durable `queuedAt`, round-robin). **S6a SHIPPED 2026-07-21** (durable admission queue: `queued` run rows + `queued_at` FIFO + boot `recoverQueued`; #631 live-capacity re-check; #629 bus-hook drain on ANY terminalization). **S6b SHIPPED 2026-07-22** — the per-PIPELINE half: `Pipeline.concurrency` (positive int, `null` = uncapped) lives on the **MUTABLE `pipelines` row, NOT the immutable version doc** (a live operational gate read fresh per admission, #631's precedent; a version-doc cap would be unrepairable and would race across triggers bound to different versions — the domain spec's D1/F8a row is annotated to match). `fire()` is both-must-pass for every policy; **per-pipeline overflow QUEUES** (durable, bounded by the per-trigger depth cap), with `skip_if_running`'s trigger-level skip applying first (a queued row counts as its outstanding fire). The drain is **pipeline-scoped** (`drainPipelineQueue`, keyed off the settling run's version→pipeline) at all three sites (settle `finally`, #629 bus hook — which now also drains for a trigger-LESS `call_pipeline` child, `recoverQueued`), admitting while BOTH live capacities have room. **Fairness = least-recently-ADMITTED trigger first** (never-served first, then oldest `queuedAt`, then `triggerId`; strict `queuedAt` FIFO within a trigger) — a durable round-robin derived from admission-re-stamped `started_at`, no rotation pointer, restart-safe; a trigger at its own cap is skipped, never stalling others. Read-lenient/write-strict cap schema; launcher fails CLOSED to a single slot on a corrupted stored cap. Remaining S6 slice: the `waiting_concurrency` RE-admission gate on resume. |
| S7 | Lease-expiry reclaim with generation tokens (on S1) + boot-reconcile formalization. **SHIPPED 2026-07-22** — see the S7 block below; supersedes **#465** (the `supersede` primitive landed here with its consumer, as that ticket planned). |
| S8 | Event/webhook trigger firing via event bus + `externalWait` (with #4 A13). **SHIPPED 2026-07-22.** The `externalWait` half was ALREADY live (#4 A13: the per-trigger HMAC webhook endpoint `routes/webhooks.ts` + the mid-run `routes/external-wait.ts` family). This ticket landed the two remaining halves: **(a) the webhook `${trigger.body}` production feeder** — the delivery body (the exact HMAC-verified bytes: valid JSON → parsed, non-JSON → the raw string failing deep-addresses safe, empty → null) now seeds the S12a `run.triggerContext`; **(b) `event`-mode firing = the named-event ingestion channel** — `Trigger.event: {name} | null` (nullable `event` column; write rules: `event` config ⇒ mode `event`, enabled event trigger ⇒ config present) + first-party authed `POST /api/events {name, payload?, idempotencyKey?}` fanning out OWNER-scoped to every subscriber of the name through the one shared launcher, payload seeding `${trigger.body}`; per-subscriber independent outcomes (gate skips record nothing; a claimed key rides the trigger-scoped `webhook_deliveries` ledger for opt-in dedup; no key = no dedup, documented). This is the spec's "inbound, authed, correlated signal" v1 — later event-source breadth (file/queue/db-change, still a non-goal) becomes additional PUBLISHERS onto the same fan-out. Guarded by the #547 boundary at both feeders (`assertJsonReplaySafe` on the fire body in `launcher.fire`; a 400 up-front on the events route). `SCHEMA_VERSION` bumped 1→2 with a v1→v2 trigger-envelope upgrader backfilling `recurrence: null` (healing S5b's missed bump) + `event: null`. |
| S9 | Tumbling-window: window-domain EVENTS (`window.created/runCreated/…`) + projection + config-versioned window key + single-fire. **SHIPPED 2026-07-22.** New `tumbling` mode + `Trigger.window` `{frequency: minute\|hour\|day, interval, startTime, endTime?}` (fixed-duration UTC windows anchored at `startTime`; month/week excluded — variable length; SCHEMA_VERSION 2→3 backfills `window: null`). **Events are the truth**: `window_events` (append-only, trigger-scoped, CASCADE) + `tumbling_window_state` projection (UNIQUE window key, written same-tx with each append, rebuildable — `foldWindowStatus` in shared is the pure fold, pinned projection==fold). **Window key** `(triggerId, configEpoch, windowStart)` with `configEpoch = sha256(frequency\|interval\|startTime)` — the PINNED geometry tuple, NEVER a whole-object hash; **`endTime` is a BOUND, not identity** (it rides the alarm REF for freshness — the S5b-2 bounds-in-ref discipline — so an `endTime` edit stales the pending row and `sync()` re-seeds; an extension never re-keys fired windows). **Chain mirrors `schedule_tick`**: one pending `window_due` row per trigger, `dueAt = windowEnd` (a window fires when it CLOSES), handler arms window n+1 in-tx (SAVEPOINT) before the fire decision, materializes via the launcher in `afterCommit` only; ≤1-late/no-backfill STRUCTURAL (missed windows are S10's). **Single-fire = 3 layers** (wakeup UNIQUE key · projection PK, `window_already_exists` suppression · partial UNIQUE `window.created` index) **+ link-before-fire reconcile** for the fire↔link crash gap: started rows now PERSIST `triggerContext` and a `queued` FireResult now reports `runId` (both launcher additions), so `findUnlinkedRunForWindow` (frozen `scheduledTime == windowEnd`, excluding already-linked runs) LINKS the orphan instead of firing twice — S10 must epoch-scope this join before arming past windows (flagged in-code). **Completion** = the #629-shape bus tap (run-terminal → `window.succeeded`/`failed`, derived from the run ROW) + boot `reconcile()` (settles missed taps; folds a vanished run CLOSED as `failed{missing}`; re-materializes stranded `waiting` windows oldest-first, `interrupted` ⇒ `window.failed` — S11's retry policy re-drives, no hold-open). **Write rules**: `window` ⇒ mode `tumbling`; enabled tumbling ⇒ `window` present; **concurrency policy `queue`-only in v1** (skip_if_running would strand a window forever; per-window concurrency is S11). Routes reach both reconcilers through ONE composite `fastify.scheduler.sync()` seam. **Conscious v1 tradeoffs (documented in `scheduler/tumbling.ts`):** overflow windows DO materialize into the S6 durable queue (the codex "blocked windows live in window state, not runs" line is about S10/S11 BULK, where materialize-on-capacity needs S11's hook); `runWindows` do NOT gate tumbling fires (a suppression would silently lose the window); a stranded window of an endTime-EXHAUSTED chain heals at boot only, and stale-epoch `waiting` rows are permanently inert until S10/S11 dispositions them. Poison-trigger-row handler throw (shared with `schedule_tick`) → #637 — **FIXED 2026-07-22** (lenient `getParsedTrigger` + `trigger_unparseable` settle in both handlers; boot `reconcile()` + completion tap skip-and-warn). |
| S10 | Tumbling-window: bounded backfill (maxBackfillWindows + durable cursor, incremental via S1). **SHIPPED 2026-07-22.** **Opt-in** via `WindowConfig.maxBackfillWindows` (optional int, write-cap 1000) — a CONSCIOUS deviation from this spec's per-kind line ("tumbling = bounded backfill" as the default): an UPGRADE must never surprise-fire past windows for an existing trigger, so absent = exact S9 forward-only behavior. A BOUND like `endTime`, not geometry (not in the epoch; not in the alarm ref — it never affects the pending forward row's eligibility). **Bound = lookback**: the MOST RECENT N fully-closed windows of the CURRENT epoch; older missed windows are permanently skipped — the durable cursor (`tumbling_backfill_cursors`, PK `(trigger, epoch)`, MONOTONIC `MAX()` upsert) jumps past them with a WARN naming the count (no-silent-caps), and raising the bound later recovers nothing (one-way ratchet, documented). **Backfill NEVER arms wakeup rows** — `sync()`'s pass creates `origin:'backfill'` window rows directly (+ cursor advance, one tx; projection PK dedupes forward-chain-owned windows), so the S1 retention-floor argument ("only future-ending `window_due` keys are ever armed") was RE-VERIFIED and holds verbatim; "incremental via S1" = the forward chain remains the S1 outbox. UNBOUND triggers are skipped entirely (unlike forward seeding's eligibility-ignores-binding): running the pass unbound would accrete rows every sync with the bound never engaging — the cursor lags instead, so the bounded lookback applies at BIND time, symmetric with disable→re-enable. **Materialize = two origin-scoped scans**: `live` keeps S9's ungated batch semantics exactly (rehoming live blocking into window state stays S11's); `backfill` fires AT MOST ONE per pass and only with ZERO `running`-status windows trigger-wide (any epoch) — the codex "blocked/backfill windows live in window state, NOT as full runs" line, honoured for bulk without S11's capacity hook. Drain liveness = completion-tap kick (settle → next fire, serial) + boot reconcile + every forward fire; known v1 hole: a skipped backfill fire under a distant/exhausted forward chain waits for the next write/boot. **Epoch-scoped link join** (the S9 flagged prereq): window fires freeze `windowEpoch` into `run.triggerContext` (internal linkage fact — NOT in `TRIGGER_FIELDS`, pinned by a negative test; `${trigger.windowStart/End}` stays S11); `findUnlinkedRunForWindow` matches it STRICTLY — a pre-S10 epoch-less orphan is no longer link-healed (one narrow at-least-once duplicate at the upgrade boundary, chosen over a NULL-tolerant join that could silently mislink an old-epoch run onto a backfilled boundary-sharing window). Boot-overdue race decided: with backfill on, a window that closed during downtime is created by the sync pass (backfill origin) and the overdue alarm suppresses `window_already_exists` (chain re-arms) — S9's "≤1-late live fire" becomes a gated backfill window for opted-in triggers only. `window.created` events + the projection carry `origin` (optional in the schema — absent pre-S10 = live, never manufactured on read). **#463 closed won't-do** per its own closing condition: S5a is structurally ≤1-late and S10 is cursor machinery, so no kind needs a non-`fire` catch-up policy. |
| S11 | Tumbling-window: self-dependency (blocked windows in state, NOT runs) + per-trigger retry/concurrency + `${trigger.window*}` (context-scoped). **SPLIT a/b/c/d** (the S5a/b, S6a/b, S12a/b precedent): **S11a = per-window concurrency — SHIPPED 2026-07-22.** **Opt-in** `WindowConfig.maxConcurrentWindows` (write-cap 50 — ADF's `maxConcurrency` range; stored shape lenient, gate HONORS an over-cap row; a BOUND like `endTime`/`maxBackfillWindows` — not in the epoch, not in the alarm ref; absent = exact S9/S10 semantics, the upgrade-never-surprises rule). When set, `materializeCapped` runs ONE oldest-first scan over BOTH origins until `cap` windows are `running` trigger-wide (ANY epoch — S10's gate rationale kept). Three decided semantics, pinned by test: (1) **the window SLOT is held until window-terminal** — a window whose run is run-level `queued` or parked `waiting` still counts; a DELIBERATE divergence from the codex line "waiting runs release the concurrency slot" (that stays true of the RUN-level slot): the cap bounds windows-in-flight, ADF's semantic, and S11c/d build on it. (2) **Live queues BEHIND backfill — a conscious REVERSAL of S10's two-scan split** (the split kept an ungated live window from starving behind the batch bound; under a cap nothing is ungated, so strict oldest-first is the ADF order; reserve-a-slot-for-live was considered and rejected; opt-in ⇒ no shipped trigger changes ordering). (3) **The scan is bounded by CAPACITY, not `MATERIALIZE_BATCH`, with NO truncation warn** — waiting-in-state is the designed steady state under a cap ("blocked windows live in window state, NOT as full runs" — now honoured for LIVE bulk too, completing the S10 line). The launcher's per-trigger admission reads the SAME cap (`admissionCapacity` + `fire()`'s queue branch, mode-gated to `tumbling`) so materialized runs actually run in parallel under the still-mandatory `queue` policy (policy = overflow DISPOSITION, cap = slot count; `skip_if_running` stays refused). `sync()` pass 3 now also kicks cap-only triggers (cap-raise liveness) — `backfillPass` stays strictly backfill-opted. No over-cap EXECUTION exists even around a crash orphan (the launcher counts the orphan's run; the oldest-first scan link-heals it first). **S11b = `${trigger.windowStart/End}` — SHIPPED 2026-07-22.** The surface is the tumbling trigger's **PARAM BINDINGS only** — a CONSCIOUS deviation from this spec's "exposed to the `${}` language" narrative (L55) as read most broadly: a pipeline doc does NOT know its triggers at save (triggers reference pipelines, are created later, change mode), so "allowed ONLY in tumbling-window-bound pipelines / save-time context validation" (the codex line, L152) is enforceable ONLY where the tumbling context is a known save-time fact — the trigger's own param bindings. This is ADF's own scoping (`@trigger().outputs.windowStartTime` is usable only in the trigger's parameter mapping); window facts reach a pipeline as declared PARAMS. Mechanics: `TriggerContext` gains optional `windowStart`/`windowEnd` (absent = non-window fire/pre-S11b row, never manufactured; `windowEpoch` stays internal, pinned); the tumbling `materializeOne` (BOTH origins) freezes them via `FireContext`; `TRIGGER_WINDOW_FIELDS` + `ScanScope.windowFieldsInScope` context-scope the static check (a node config gets a message naming the binding surface, NOT accepted-then-null); the FIELD-level write schema is window-lenient (it cannot see `mode`) and the MODE half is the route's cross-field `assertWindowBindingsConsistent` (effective post-write state) via the shared set-difference primitive `windowBindingErrors` (pre-gate binding noise cancels); the import path REFUSES a hand-crafted mode-inconsistent envelope (params cannot be forced consistent like `event`/`window` — refusal avoids a row whose every PATCH, incl. the mandatory rebind, 400s). Run-time `triggerRoot` carries both unconditionally (null when absent — the scheduledTime-on-manual fail-soft); the durable `run.triggerContext` EVENT (and so `RunState`/`buildCtx`) deliberately does NOT carry them — like `windowEpoch`, they are launcher-context/run-ROW facts; bindings resolve in the launcher and freeze into `run.started.params`. **S11c = per-trigger window retry — SHIPPED 2026-07-22.** **Opt-in** `WindowConfig.retry {count, intervalInSeconds}` (ADF's tumbling `retryPolicy`; write caps count ≤ 100 / interval 30–86400s, stored shape lenient — the S10/S11a precedent). A BOUND like `endTime`: not in the epoch, not in the `window_due` ref (it never affects the forward row's eligibility — it only governs the settle-time decision). ABSENT = exact prior semantics (`window.failed` terminal on first failure). Mechanics: new window status **`retry_pending`** + events **`window.retryScheduled`** (`running → retry_pending`; runId CLEARED — no run in flight; `nextAttemptAt` a STORED fact mirrored into the alarm's `dueAt`) and **`window.retryDue`** (`retry_pending → waiting` — the window re-enters the normal oldest-first materialize scan and links a fresh run via a second `runCreated`); projection columns `attempt` (== count of retryScheduled events, pinned) + `next_attempt_at_ms`; both CHECK lists widened via a seq-preserving table-recreate (0021). The decision lives in `settleIfTerminal` (every settle path funnels through it) and retries ONLY a **KNOWN failure** (`failure`/`interrupted`; **`missing` NEVER retries** — a vanished run row's outcome is unknown, it may have succeeded), ONLY for a **CURRENT-epoch** window (an old-epoch window folds terminal — a retry there would strand `retry_pending` forever since the heal is epoch-scoped; stale-epoch disposition stays S11d's), ONLY with a readable trigger row (corrupt = policy unknown = terminal, the #637 lenient discipline), atomically with arming the **`window_retry`** alarm (discriminator `attempt-<n>` — the codex-hardened collision rule; retention-floor argument extended in `repo/scheduled-wakeups.ts`). The alarm handler mirrors `window_due`'s suppressions (unparseable/not-tumbling/unbound/epoch-stale/window-moved-on); a suppression cannot strand the window: the **state-driven OVERDUE HEAL** (`driveOverdueRetries` — sync pass 3 for EVERY eligible trigger + boot reconcile; state-driven because a scheduled retry survives policy REMOVAL, the committed event is the authority) flips any current-epoch `retry_pending` row whose stored due instant passed. **AMENDS S11a's decided semantic (1):** "slot held until window-terminal" is now "slot held while a run is LINKED" — a `retry_pending` window (non-terminal, no run in flight) releases its concurrency slot and does not close the S10 backfill gate (an up-to-86400s hold would idle capacity); the phrase stays true of every linked state. The single-fire join was RE-SHAPED: "unlinked" is now an event-log fact (`runCreated` set, key-scoped subquery) — the projection `run_id` exclusion would have resurrected a consumed failed attempt as a "crash orphan" and link-healed a stale outcome (pinned by test). **S11d = self-dependency + stale-epoch disposition — SHIPPED 2026-07-22. S11 COMPLETE.** **Opt-in** `WindowConfig.selfDependency {offsetInSeconds (strictly negative), sizeInSeconds? (default = window size)}` (ADF's self-`TumblingWindowTriggerDependencyReference`; cross-trigger graphs stay a non-goal). Write caps: interval wholly in the past (`offset + size ≤ 0` — self-overlap is a structural deadlock, refused) + reach/length each ≤ 100 windows (`MAX_DEPENDENCY_SPAN_WINDOWS`, bounds the per-materialize scan); stored-lenient, gate honors (worst case blocks the trigger's OWN windows — visible, not corrupting). A BOUND like the other four (not in the epoch, not in any alarm ref; absent = exact prior semantics). **A blocked window waits IN WINDOW STATE — no run row** (the codex-hardened line; the ticket title's own mandate) — so the S6 narrative's run-level `waiting_dependency` reason never arises (annotated there, a conscious deviation). Predicate (`dependencySatisfied`, gate in `materializeOne` AFTER the link-heal — an orphaned run already consumed the dep): every same-epoch window intersecting `[start+offset, start+offset+size)` must be `succeeded`, with the **disposition rule** — a window the trigger itself permanently dispositioned satisfies vacuously (pre-grid k<0; no-row with `startMs < backfill cursor` for opted-in triggers, `null` cursor = nothing dispositioned; no-row CLOSED window for forward-only — race-free because the ≤1-late chain creates rows strictly in window order; and `superseded` rows, which matters post-revert). `failed` blocks until a retry re-drives (ADF's rerun-wait; the retry policy is the healing mechanism — no rerun surface until RS). The no-row check is ARITHMETIC (grid count vs rows + one boundary test on the largest missing position — vacuity is monotone), not an O(span) walk. **Both materialize scans became KEYSET walks** (`windowStartGt` cursor; the uncapped bound is now on FIRES): a blocked front larger than `MATERIALIZE_BATCH` would otherwise rescan/starve the ready tail forever (pinned by regression test), and the capped refetch would infinite-loop. A blocked OLDEST backfill window deliberately holds the serial backfill drain (its deps are below it — a persistent hold means a failed dep, designed visible). Liveness rides existing kicks (completion tap / sync pass 3 stranded probe / boot reconcile) — no new alarms, no new events for blocking. **Stale-epoch disposition:** new terminal status `superseded` + event `window.superseded {currentEpoch}` (fold mirrors the guarded flip: `waiting|retry_pending → superseded`; `running` old-epoch rows settle via their live run; migration 0022 CHECK-widening ×2, copy carrying 0021's retry columns — pinned by migration test). Runs in sync pass 3 for every eligible trigger — placed BEFORE the early-continue and unbound skip (old-epoch debris is invisible to the current-epoch stranded probe; disposition spawns no run) — and in boot reconcile ENABLED-AGNOSTIC (a disabled trigger still has an epoch; a pause defers nothing, the settle-path posture). PERMANENT: a revert does not resurrect (projection uniqueness; the cursor's one-way rule) — post-revert a superseded row satisfies dependents as dispositioned. Old-epoch cursor rows stay inert (they gate nothing). |
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
  *(S11b shipped this as trigger-param-BINDINGS-only — the one save-time surface where the tumbling
  context is a known fact; a pipeline doc does not know its triggers at save. See the S11 row.)*
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
  - `supersededBy` + `supersede` (cancel-old + arm-new) — **S7 surface, deferred to S7** (#465);
    **NOW LANDED there** (migration 0017, `supersedeWakeup` — see the S7 block below).
    Its only spec anchor is *"heartbeats supersede old alarms"*, which the ticket table places at
    S7 (lease-expiry generation tokens). It was built here first and the pre-PR review found it had
    already produced a silent-lost-alarm: the guard compared the replacement KEY, but arming is
    upsert-if-absent, so a replacement colliding with any pre-existing row returned that spent row
    while the live alarm was still cancelled. Exactly what a primitive with no consumer to pin its
    semantics gets wrong. It landed at S7 via `ALTER TABLE ... ADD COLUMN superseded_by TEXT`
    (native in SQLite — not the table-recreate a CHECK change would need), guarding on what the
    arm RESOLVED TO (`created === false` → refuse + roll back), exactly as #465 prescribed.
  - **Consequence, restated for the S7 era:** an armed alarm is immutable BY RE-ARMING; the one
    sanctioned way to move a `dueAt` is `supersedeWakeup` — an explicit cancel-old + arm-new in
    one transaction. A caller without a supersede claim arms a NEW alarm under a new discriminator.
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
- **RESOLVED (S10, 2026-07-22) — the per-kind `catchUp` policy field is NOT needed; #463 closed
  won't-do.** The *behaviour* this spec mandates for retry/wait/webhook/lease ("overdue fires on
  boot") shipped at S1 and is tested. The two candidate consumers both turned out not to need the
  field, exactly the closing condition #463 itself set: schedule ticks are STRUCTURALLY ≤1-late
  (one row per trigger, S5a), and tumbling backfill is CURSOR machinery
  (`maxBackfillWindows` + `tumbling_backfill_cursors`, S10) — not a row-level catch-up policy. A
  future kind that genuinely arms MULTIPLE overdue rows re-opens this with real semantics to
  design against.
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

## S7 — SHIPPED 2026-07-22 (lease-expiry reclaim + heartbeats + the reconcile formalization)

One module owns the whole lease lifecycle: `scheduler/lease.ts` (`createLeaseService` → the
heartbeat `sweep` + the `run_lease` alarm handler + the reclaim), because the three share the
in-flight-reclaim set and the alarm-identity scheme. What the hardened lines above said, and what
shipped:

- **The unifying invariant:** every `running` row holds a `leaseUntil` and (within one 60s sweep
  interval) a pending `run_lease` alarm due at it. The lease is *"when to next VERIFY liveness"*:
  a live-drive run is renewed by the sweep and its alarm never fires; a run alive on its OWN
  durable node alarm (a retry hold, a crash-gap parked wait) gets its lease RENEWED by the
  reclaim's `held` verdict (a self-perpetuating check, never a churny interrupt); a genuinely
  stranded run (drive gone) is reclaimed. `waiting`/`queued`/terminal rows keep `leaseUntil =
  null` (S4) and are out of scope — their liveness is their own alarm / the admission queue.
- **Generation token, honoured verbatim:** the alarm's ref carries the `leaseUntil` it was armed
  against (`{runId, leaseUntil}`, discriminator `lease-<leaseUntil>` — vacuous like retry's, the
  ref pins the occurrence); the handler reclaims ONLY if the row still holds that exact value
  (else `lease_renewed` suppression — reachable via a park→resume re-stamp, since
  `syncRunLifecycle` stamps a fresh lease on every real status change to `running`). Expiry
  (`leaseUntil <= now`, the one comparison) is structural at fire time: `dueAt === leaseUntil`.
  Further verdicts: `run_not_found` / `not_running` / `reclaim_in_flight` / `drive_live` (a live
  drive with an expired lease means the SWEEP stalled — never reclaim under a live drive).
- **"Heartbeats supersede old alarms", mechanically:** the sweep stamps `heartbeatAt` (the
  S4-deferred half — live-drive EVIDENCE, written nowhere else) + `leaseUntil = now + TTL` and
  supersedes the previous generation's alarm to the new one, all in ONE transaction (the repo tx
  nests as a SAVEPOINT), so row-lease and alarm generation cannot diverge across a crash.
  `supersedeWakeup` (#465, built as specced): arm-new FIRST, refuse+roll-back on
  `created === false` (trap 1: check what the arm resolved to, not the key), old cancelled with
  `supersededBy` provenance only if still pending (a missing/settled old still arms the
  replacement — the post-boot renewal case; settled is FINAL, never rewritten). Churn is one
  cancelled row per sweep per live run, ACCEPTED — bounded by #464 retention; a lazy-supersede
  optimization is a follow-up if volume ever matters.
- **The reclaim IS the boot-reconcile policy — the "formalization":** `reconcileOne` is now
  exported with a two-entry-point lock contract (reconcile.ts's header): boot (lock-free by
  proof) and the lease reclaim, which wraps it in `drives.serialize` and re-checks the row under
  the lock (status still `running`, lease still expired — anything can happen between the fire's
  commit and lock acquisition). Its `run.resumed`/`node.retryRequested` facts carry
  `reason: 'lease_reclaim'` (the event union's closed reason enum grew its second value — each
  value names a sanctioned resumer). Idempotent in-flight → resumed under a new attempt;
  non-idempotent → frozen `interrupted` — identical policy, per-activity, unchanged.
- **At-least-once closes through the sweep:** the reclaim spawns `afterCommit` (the clock
  contract), so a fault between settle and reclaim would lose it — the sweep's third branch bumps
  the generation of any no-drive expired-lease (or spent-current-generation) row to a strictly
  advancing `leaseUntil` and arms it immediately due, so the #465 discriminator trap cannot bite
  and a lost reclaim is retried within one sweep. Branch 2 arms the missing alarm for a
  no-drive still-live lease (the drive-dropped-before-first-sweep window). In-memory
  `reclaimsInFlight` keeps the sweep from stamping `heartbeatAt` off a reclaim's own `serialize`
  registration (registration ≠ drive); a crash empties it and the durable self-heal re-arms.
- **Boot order is load-bearing:** reconcile → lease sweep → alarm interval + boot tick. The sweep
  BEFORE the tick so it observes only the reconciler's final states, never a boot-fired reclaim's
  registration. A boot-resumed run does NOT re-stamp its lease (running→running is
  `syncRunLifecycle`'s early-return), so a held run's stale pre-crash lease converges by one of
  two paths depending on downtime: still-live lease → the pre-crash alarm's token MATCHES and
  fires into a reclaim whose `held` verdict renews; already-expired lease (the long-downtime
  case) → the boot sweep's branch 3 BUMPS the generation first, the pre-crash alarm suppresses
  `lease_renewed`, and the reclaim comes from the new generation's immediately-due alarm. Either
  way the run lands on the renewal chain.
- **Self-cleaning tails, accepted:** a completed run's pending lease alarm fires up to TTL late
  into a `not_running` suppression (one settled row per run; #464 prunes); `LEASE_TTL_MS` stays
  5 min (the heartbeat-miss budget: five missed 60s sweeps) — the S4 "S7 tunes it" note resolves
  to keeping it.

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
