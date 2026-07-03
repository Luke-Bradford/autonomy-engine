# W2 — Event bus (event triggers) — design spec

> Status: **operator-delegated design** (2026-07-03). Authored by the autonomy loop under the
> full-autonomy grant recorded in `2026-07-03-configurable-workflows-design.md` (the operator asked
> for the product flow to be built without gating each increment), following the same per-increment
> `spec → plan → PR` precedent that landed W1 (#85/#103/#104) and BYO-LLM (#78/#91). This is
> increment **W2** of the Configurable-Workflows umbrella (#83). Issue: #86.
>
> Depends on **W1 (scheduler, #85, merged 1fdb3fa)** — the event poll runs on the same supervisor
> loop iteration that W1 folded the cron check into. One decision (delivery semantics: at-least-once
> vs at-most-once, §Open questions) is flagged for operator veto; the recommended default is the
> fail-safe one and does not block the design.

## Goal

Let a role whose `trigger.type` is `event` wake when board/PR state changes — a Coder opens a PR and
QA reacts to it without either knowing the other exists. After this increment, `qa` (event, tests a
diff) fires on `pr.opened`/`pr.synchronize` instead of being inert config, and the
Researcher→PM→Coder→QA choreography becomes emergent from triggers + board state. The engine ships
the mechanism; each repo's `.autonomy/config.yaml` supplies which agents listen for which events.

## What already exists (do not rebuild)

- **The trigger schema** in `lib/roles.py`: `VALID_TRIGGERS = ("loop", "cron", "event")`;
  `validate_roles` already requires a non-empty `on:` list for an `event` trigger
  (`roles.%s: trigger type event requires a non-empty 'on' list`). `qa` is the roster's default
  event role (`DEFAULT_ROLES`, disabled by default).
- **The supervisor loop + dispatch path** (post-W1): each iteration holds the lifetime per-repo lock;
  `resolve_cron_due` is already called once per iteration (W1). W1 already generalised the original
  "one session per iteration" (settled-decision #12) to **one session at a time (sequential under the
  held lock, never concurrent)** — a cron role can fire an *additional* sequential session in the
  same iteration as a loop session. W2 inherits that generalised invariant (see Fail-safe below); it
  is the non-concurrency property that matters, not a per-iteration count. `run_session <role>`
  resolves account → sources the adapter → runs a scoped session.
- **`dispatchable_roles(config)`** (W1): loop roles + cron roles; `role_settings` resolves any of
  them. W2 extends this to also include **event** roles, so `run_session <event-role>` resolves
  rather than refusing (the exact bug W1's Codex checkpoint 2 caught for cron roles — do not
  reintroduce it for events).
- **The sole-writer marker precedent** (W1): `$VARDIR/cron/<role>.last_fire`, written only by the
  supervisor (reset-epoch-split generalised). W2 reuses the pattern for event cursors.
- **`gh` is already the board/PR interface** the supervisor uses (`gh issue list`, the merge gate's
  `gh pr` calls). No new dependency: gh-poll uses the CLI already required.

So W2 adds **an event poll (gh state → events) + a per-source cursor + a wake path** — not a new
trigger schema, not a new dispatch path, not a new lock.

## The design fork, and why the code resolves it

Issue #86 names it: "gh-poll first, webhook later." A webhook needs a public endpoint + a listener
process; the engine binds `127.0.0.1` only and its whole safety model is "no inbound network." So
**gh-poll is the only fit today** — the supervisor already calls `gh`, and W1 already established a
once-per-loop-iteration tick under the held lock. The event poll **folds into that same tick**,
exactly like cron: zero new process, zero new lock, zero new inbound surface. Webhooks stay a later,
optional acceleration (they would only shorten latency, not change the event model).

### Approaches considered

- **A. Fold an event poll into the supervisor loop (RECOMMENDED).** Each iteration, after the cron
  check, the supervisor polls gh for the events any enabled event role listens for, computes which
  are new since a per-source cursor, and fires the listening roles via `run_session`. Reuses the
  lock + `run_session` + the marker pattern; degrades safely; latency bounded by loop cadence (same
  tradeoff W1 accepted).
- **B. A separate webhook listener.** Ruled out for W2: needs an inbound-network endpoint, breaking
  the `127.0.0.1`-only / no-inbound safety posture, and a second process contends the lifetime lock
  (the same reason W1 ruled out a separate scheduler). Revisit only as a latency optimisation later.
- **C. Level-triggered reconcile with no cursor** (fire whenever the condition currently holds).
  Ruled out: without a cursor a role re-fires every tick for the same PR until the condition clears,
  a fire-storm. The cursor (Approach A) is what makes each event fire once.

## Architecture (Approach A)

```
supervisor loop iteration (holds autonomy-supervisor.lock):
  1. resolve_dispatch_roles + run_session   -> one loop session      (existing)
  2. resolve_cron_due                        -> due cron roles         (W1)
  3. resolve_event_wakes                     -> NEW: fire event roles whose
                                                on:[...] matched a new event
```

Two new units, each small and independently testable:

### 1. `lib/roles.py`: `event_roles(config)` + extend `dispatchable_roles`

- `event_roles(config)` mirrors `cron_roles`/`dispatch_roles` but selects effectively-enabled roles
  whose effective trigger type is `event`, returning `(name, on_list)` in the same stable order
  (standard roster first, then custom roles in config order). A role with an empty `on:` is skipped
  (defense in depth — `validate_roles` already rejects it).
- CLI `roles.py events <repo>` prints one `NAME<TAB>EVENT[,EVENT...]` line per event role — the same
  word-split-safe enumeration contract as `roles.py cron`/`dispatch`.
- `dispatchable_roles(config)` gains event roles (append after loop + cron), so `role_settings`
  resolves an event role's account/model/scope/prompt. Event roles are otherwise identical to any
  other session — only their *wake condition* differs.

### 2. `bin/supervisor.sh`: `resolve_event_wakes` + per-`(role,event)` cursors

- **The event vocabulary (v1, gh-poll).** Each event maps to a gh query keyed on a **monotonic
  number** wherever possible (numbers are stable regardless of open/closed state, so an item opened
  *and* closed between two polls is still detected — level-triggered `--state open` would miss it,
  the reason this spec uses `--state all`). Every list query passes an explicit `--limit` (default
  **200**); a burst larger than one page between ticks is the documented delivery bound (see §Open
  questions), not a silent loss.

  | Event | gh source (explicit `--limit`) | Cursor key (monotonic) |
  |---|---|---|
  | `issue.created` | `gh issue list --state all --limit 200 --json number` | highest issue number |
  | `pr.opened` | `gh pr list --state all --limit 200 --json number` | highest PR number |
  | `pr.synchronize` | `gh pr list --state open --limit 200 --json number,headRefOid` | per-open-PR head SHA |
  | `merge.done` | `gh pr list --state merged --limit 200 --json number` | merged-PR-number seen-set |
  | `session.done` | internal (loop/cron sessions ran this tick) | per-tick edge (no cursor) |

  JSON is parsed by a stdlib-`json` Python one-liner (no `jq`).

- **Cursor state is per `(role, event)` — not per event.** Each listening role advances its *own*
  cursor for each event it listens for, at `$VARDIR/events/<role>__<event>.cursor`, **written only
  by the supervisor** (sole-writer invariant, as W1's markers). This is deliberate: a single
  per-event cursor would let one listener's *successful* fire advance the cursor and thereby drop an
  event a *second, failed* listener never processed (Codex checkpoint-1 finding). Per-`(role,event)`
  cursors are independent, so a failed listener re-delivers without disturbing a successful one.
  The two non-scalar cursors carry a little more:
  - `pr.synchronize`: a per-PR SHA map `<role>__pr.synchronize.seen` (`NUMBER<TAB>SHA` lines),
    **pruned each poll to the currently-open PR set** so it stays bounded (closed PRs drop out).
  - `merge.done`: a seen-set `<role>__merge.done.seen` of merged PR numbers, pruned to the
    **most-recent `--limit` merged numbers** (a bounded window *aligned with the poll page*, NOT an
    intersection with the current page — so a merge still visible on the page is never dropped from
    the set and then re-delivered). Bounded, and no reappear-after-prune re-fire within the window.
    (Merge order ≠ number order and `mergedAt` can tie, so a number seen-set — not a max-timestamp
    scalar — is the correct dedup key.)

- **First-sight (no cursor) = intentional baseline reset, NOT delivery.** On the first tick a role
  listens for an event (fresh install, a newly-added listener, or after `$VARDIR` loss), its cursor
  initialises to the *current* max/state **without firing**. This deliberately does **not** replay
  the pre-existing board — it is a baseline reset, not a lost delivery. "At-least-once" (below) is a
  guarantee for events that occur *after* a role's cursor exists, not a promise to replay history.
  (This resolves the apparent tension with "never lost": the guarantee window opens at first-sight.)

- **Delivery = at-least-once within the guarantee window (advance the cursor AFTER a successful
  dispatch).** The deliberate *inverse* of W1's cron ordering, and the crux of the design: a cron
  slot is fungible (missing one waits for the next → advance *before* firing, under-fire); a
  real-world event is not (missing a `pr.opened` means QA never sees that PR → advance *after* a
  successful fire, at-least-once, tolerate a rare double-fire). A dispatch that fails
  (session refused/errored) leaves that role's cursor unadvanced, so the event re-delivers to *that
  role* next tick. Event agents are written to be **idempotent over board state** — QA's scope is
  "open PRs needing a QA verdict", so a re-delivery finds nothing new to do.

- **`session.done` reentrancy guard.** `session.done` is an internal per-tick edge, computed **once,
  before the event phase fires**, from a boolean the loop+cron dispatch set this iteration (`a
  loop/cron session ran`). Sessions that the *event phase itself* fires do **not** set that boolean,
  so a role listening for `session.done` cannot self-trigger a runaway chain within or across ticks.
  It fires at most once per tick and only for loop/cron work.

- `resolve_event_wakes` is called once per loop iteration after `resolve_cron_due`, under the held
  lock, and **never returns non-zero** — an event hiccup must not crash the loop.

## Fail-safe / invariants

- **Poll failure → no events this tick, never a fabricated one.** A `gh` error (or malformed JSON)
  leaves cursors untouched and fires nothing; loop dispatch stays byte-for-byte unchanged
  (best-effort, like `board.sh`). Fail-safe: a poll hiccup under-delivers for one tick, never
  over-delivers.
- **Sole-writer cursors:** only the supervisor writes `$VARDIR/events/*` — the reset-epoch-split /
  cron-marker invariant, generalised to event state. Adapters never persist event state.
- **At-least-once *within the per-tick page bound* (not exactly-once, not unbounded-history):** a
  role's cursor advances only after its listening session is dispatched, so a crash between fire and
  advance re-delivers (idempotent agents absorb it). The guarantee is scoped: it covers events
  visible within one `--limit` poll page per tick — a burst exceeding one page between ticks is the
  documented delivery bound (§Open questions), and first-sight is a baseline reset, not history
  replay. This is at-least-once (rare duplicates possible), never a claim of exactly-once.
- **A due event role that will not resolve refuses its session** — `run_session`'s existing
  fail-safe (account unresolvable / adapter unusable / prompt missing → REFUSE). No new fail-open.
- **Unknown `on:` token is fail-closed at VALIDATION, not use-time.** `validate_roles` gains a
  `VALID_EVENTS` enum and rejects any `on:` token outside it (an event role whose `on:` is entirely
  unknown tokens is a config error doctor surfaces before the loop runs) — accepting a role that can
  never wake would be fail-open config acceptance. The supervisor's `case` match is then
  defense-in-depth: an unknown token that somehow reaches it is skipped with a WARN, never executed.
- **Config-sourced strings re-validated at point of use (prevention-log #6):** the event role name
  reaches a `$VARDIR/events/<role>__…` path, so it is charset-gated before that use exactly like
  W1's cron marker; the `on:` token reaches a `case` match (above).
- **Cursor state is bounded:** scalar cursors are one small file per `(role, event)`; the two
  non-scalar cursors (`pr.synchronize.seen`, `merge.done.seen`) are pruned every poll to the
  open-PR / current-merged-page set, so `$VARDIR/events/` never grows without bound.
- **One session at a time (non-concurrency, the W1-generalised invariant):** event firing happens
  inside the loop iteration under the held lock. If a loop, a cron, and an event role are all ready
  in one iteration, they run **sequentially, never concurrently** — the property that matters is
  non-concurrency (one agent touching the worktree at a time), which W1 already generalised from the
  original per-iteration count (settled-decision #12).
- macOS bash 3.2.57; Python 3 stdlib only; source-guards; `shellcheck -S warning` clean; tests
  source the real scripts and stub only at the `run_session` / `gh` / `roles.py events` seam.

## Out of scope (later increments)

- **Webhooks** (latency optimisation) — needs the inbound-network rework; not W2.
- **The QA/Coder/PM/Researcher prompt rails** and the default workflow template — **W5 / #89**. W2
  only makes an *already-configured* event role fire; it ships no role prompts and does not touch
  `.autonomy/**` (the self-pack rails land in W5 under operator review, per the guardrail rule).
- **Explicit handoff edges** (agent A → agent B by name) beyond board-state choreography — the
  umbrella's `workflow:` block, a later increment.

## Testing (the seams)

- `tests/test_roles.py`: `event_roles` selects only enabled event roles in stable order; skips
  empty-`on:`; `dispatchable_roles`/`role_settings` resolve an event role; the `events` CLI verb
  emits `NAME<TAB>EVENTS`.
- `tests/test_event_bus.sh` (new, sourcing `bin/supervisor.sh`): `resolve_event_wakes` with a stubbed
  gh poll + a fixed cursor fires a role on a new `pr.opened`, does not re-fire on the same PR,
  initialises a first-sight cursor without firing, re-delivers when the prior dispatch failed, and
  leaves loop dispatch untouched when the poll fails. `run_session` stubbed to a capture file (the
  seam W1's `test_scheduler.sh` and `test_headless_dispatch.sh` established).

## Open questions (operator veto — non-blocking; recommended default is fail-safe)

1. **Delivery semantics — at-least-once (RECOMMENDED) vs at-most-once.** This spec advances the
   cursor *after* dispatch so a real-world event within the page bound is not silently dropped, at the cost of a rare double-fire on
   a crash (absorbed by idempotent, board-scoped agents). If the operator prefers at-most-once
   (never double-fire, may miss an event on a crash), flip the cursor advance to *before* dispatch
   (the cron ordering). The recommendation is at-least-once because losing a `pr.opened` (QA never
   reviews a PR) is worse than QA running twice and finding nothing new.
2. **v1 event set.** `issue.created` / `pr.opened` / `pr.synchronize` / `merge.done` /
   `session.done` cover the default-workflow choreography. `pr.review.approved` / `pr.closed` /
   `label.added` are easy follow-ons if a workflow needs them — deferred until one does.
3. **Per-tick delivery bound = the `--limit` page (default 200).** Between two loop ticks (up to
   `EMPTY_IDLE`≈30 min when the board is quiet), at most one `--limit` page of new items per event
   is observed; a larger burst is caught over subsequent ticks only for items still on the page.
   Number-keyed cursors make this rare (a monotonic cursor never regresses), and loop cadence keeps
   the window short under load. True pagination (loop `gh` pages until the cursor is covered) is a
   follow-on if a repo ever bursts >200 items of one kind inside one idle window; flagged, not built.
