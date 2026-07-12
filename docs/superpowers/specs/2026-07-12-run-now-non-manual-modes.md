# Run-now on non-manual trigger modes

> **Audience note (engineering record).** Session-internal spec for the
> SD-42/SD-43/SD-44-deferred slice "run-now on non-manual modes". Vocabulary:
> `SD-N` = docs/settled-decisions.md entry; `prevention-log #N` =
> docs/review-prevention-log.md entry; D1/D2/D3 = the Phase D slices (#383).

## Problem

The dashboard's ▶ run-now control and the supervisor's fire-marker channel
apply to MANUAL-mode triggers only. `resolve_manual_fires` WARN-removes a
fire marker naming a continuous/schedule/event trigger;
`trigger_fire_ready` refuses every non-manual mode, so the ⚡ card button is
disabled with "other modes are a D2 extension". D2 shipped; the extension is
this slice. The fail-safe frame (kickoff): a mode whose fire semantics are
ambiguous REFUSES loudly, never guesses.

## Decided semantics per mode (operator-veto items, listed on the issue)

1. **continuous — fire = one immediate start.** A fire marker starts ONE run
   through the exact dispatch path the round-robin uses (`run_session` with
   the trigger's enumerated kind), capacity-gated by the trigger's own
   concurrency policy (`skip`/`queue` clamp to 1, `parallel` up to max). At
   capacity the marker is KEPT (deferred — the marker itself is the queue;
   never a `queued/` marker, that namespace stays cron-owned). The
   interplay with the same tick's round-robin is bounded by construction:
   fire markers drain BEFORE the dispatch list is built, so a run-now
   consumes the slot and the round-robin's own capacity gate skips —
   run-now can never stack runs beyond the declared policy.
   *Alternative (veto): refuse as a no-op ("continuous already runs every
   tick"). Rejected: run-now is exactly how an operator jumps the
   round-robin or fires one run with payload param overrides — and the
   ADF-shaped model (operator direction, 2026-07-10) treats "trigger now"
   as universally available.*

2. **schedule — fire = one extra run now; the schedule is untouched.** The
   fire never reads or advances `var/cron/<name>.last_fire` (the supervisor
   cron resolver stays that file's sole author — the reset-epoch-split
   discipline). The next scheduled fire happens exactly when it would have.
   Accepted bound: an operator fire minutes before a scheduled fire yields
   two runs minutes apart — predictable, and what "run now" says.
   *Alternative (veto): consume the next due fire (advance the marker).
   Rejected: surprising (a 08:50 run-now silently swallowing the 09:00
   fire), and it would put a second writer on the cron marker.*

3. **event — fire REFUSES.** An event run's identity IS the event token
   (`firing.map` feeds params from the event payload; the seen-set dedups
   deliveries). A marker fire has no token: guessing (empty fields, payload
   standing in for the event) would mint a run the event machinery never
   saw. Refusal is loud at every layer: the button stays disabled with the
   honest reason, `trigger_fire_ready` refuses, the supervisor WARN-removes
   the marker naming the reason, and `start_run_trigger` keeps refusing
   `fire_params` on event mode.
   *Alternative (veto): a payload-as-event-fields channel. Deliberately NOT
   built — it invents an event; if wanted later it is its own decided
   slice.*

4. **shim triggers (continuous/schedule role shims) — empty-body fire only.**
   A shim fires through the role path (`run_session <tok> shim` — role
   prompt/scope/model apply, byte-identical to its loop/cron dispatch). A
   NON-empty body (params payload) is a deterministic refusal — the shim
   start path (`start_run`) has no params channel; the marker is removed
   LOUDLY with the reason naming the fix (materialise the trigger — D2's
   edit flow). `trigger_fire_ready` refuses overrides for shims on the
   write side, so such a marker can only be hand-made. For shims the dry
   `_resolve_run_params` is SKIPPED: `start_run` never resolves params, so
   dry-running the doc would compute a verdict the start path never reaches
   (a required-param doc would read "not fireable" while the loop happily
   dispatches it) — parity means parity with the actual start.
   Manual-mode shims cannot exist (shims are loop→continuous,
   cron→schedule, event→event), so the manual lane stays native-only as
   today.

5. **stop sentinel now defers fires (all modes, manual included).** Today
   `resolve_manual_fires` ignores `var/trigger-ctl/stop/` — a stopped
   trigger still fires on run-now, contradicting the stop control's
   documented "freeze: no new fires, no advance". Stop + fire are
   contradictory operator instructions → fail-safe side: the marker is
   KEPT with a NOTE and fires on resume (the disabled-marker discipline).
   Error BACKOFF keeps the existing behaviour (an explicit operator fire
   overrides machine caution — "I fixed it, run now"); documented, not
   changed.

6. **disabled / window-closed keep deferring (unchanged discipline,
   extended to the new modes).** Marker kept with a NOTE; fires on
   re-enable / window-open (SD-41's manual-marker deferral, now
   mode-generic).

## Implementation shape

**One verdict, shared (start-parity by construction):**

- `lib/triggers.py` CLI: the `manual` verb is REPLACED by `fireable` —
  same enumeration-derived gate (validity, collision, lane, enabled,
  `in_run_window`), now printing `name\tmode\tkind\tpolicy\tmax` for modes
  `manual|continuous|schedule`. It joins dispatch/cron/event as the
  dispatch-facing verbs (window-gated, `--now` seam). The `manual` verb is
  deleted in the same commit (sole consumer was `resolve_manual_fires`;
  keeping a twin verb is the SD-46 class).
- `lib/dashboard_state.py` `trigger_fire_ready`: mode gate widens to
  `manual|continuous|schedule` (event/junk modes refuse with the honest
  reason); `kind == "shim"` → overrides refuse, params dry-run skipped
  (decision 4), ready otherwise; natives keep the exact
  `_resolve_run_params` dry-run. `build_triggers_view`: `fire_params`
  projection (the typed overlay) extends to NATIVE manual/continuous/
  schedule triggers; shims never offer the form.
- `lib/pipeline.py` `start_run_trigger`: the `fire_params` mode gate widens
  to `manual|continuous|schedule`; event stays refused (decision 3).
  `fire_params_check` is already mode-agnostic (the supervisor only
  firechecks enumerated fireable triggers).
- `bin/supervisor.sh`: `resolve_manual_fires` → renamed
  `resolve_fire_markers` (honest name; all call/test/doc sites swept).
  Reads the `fireable` enumeration (5 fields); per marker: charset gate →
  row lookup → not-in-list fallback via `show` (manual/continuous/schedule
  disabled/window-closed → kept; event → WARN-removed with reason;
  anything else → WARN-removed) → junk enumerated kind → NOTE defer
  (never guess a kind — the cron resolver's rule; marker kept) →
  **payload classification BEFORE stop/capacity** (CP1: a deterministic
  refusal must be removed loudly even while the trigger is stopped or
  busy, never parked behind a defer arm): shim+body → WARN-remove
  (decision 4); native body → `firecheck` (rc 3 remove loudly / rc 1
  defer-keep / rc 0 thread) → stop sentinel → NOTE kept (decision 5) →
  capacity → defer → `run_session <tok> <kind> [params_file]`.
- **The not-in-list fallback can only KEEP or REMOVE, never fire** (the
  D1 discipline, now mode-generic): `show` is a bare file read with no
  enumeration context (lane/collision/refusals), so it never gates a
  fire — a kept marker fires only after the trigger re-enters the
  enumerated fireable list. A trigger the enumerator refuses for another
  reason while its file reads disabled keeps its marker and fires only
  once fixed AND enabled — the documented resumes-on-re-enable semantics.
- **Layering pin (CP1): the `pipeline.py start --kind native` CLI does
  not itself refuse event-mode triggers** — it is the event RESOLVER's
  own start path (mapless event starts are legal there; a mapping trigger
  already refuses without `--event-field`). Run-now-on-event refusal
  lives at the three run-now layers: the marker resolver,
  `trigger_fire_ready`, and `start_run_trigger`'s `fire_params` gate.
- **Tick-ordering pin (CP1, accepted bound):** `resolve_trigger_cron_due`
  runs before `resolve_fire_markers`, so a schedule fire coming due the
  same tick as a run-now can consume the only slot and defer the marker a
  tick (skip/queue policies clamp to 1). Reordering would merely flip
  which fire defers; the marker's deferral is visible (pending chip).
- `lib/pipeline_page.html`: header note + per-mode button titles
  (continuous "start one run now — ahead of the round-robin"; schedule
  "fire one extra run now — the schedule is untouched"; shim "fires
  through the role path"); the form/button fork already keys on
  `fire_params`/`fire_ready`, so the page mostly inherits the payload.
  **Form-not-gated-on-`fire_ready` is intentional D2 behaviour, kept**
  (CP1 flagged it as a bypass): `fire_ready` is the NO-overrides verdict,
  and the typed form exists precisely so a payload can FIX unresolvable
  saved params (`test_fire_ready_overrides_fix_missing_required`); the
  server re-validates every send via `trigger_fire_ready(overrides=)` —
  no marker lands unvalidated. Event triggers never render the form
  (the `fire_params` projection excludes them), so their only control is
  the disabled button with the honest reason.

**Docs in the same PR:** `docs/pipelines.md` (product layer — run-now
section), `.claude/skills/engineering/pipelines.md` +
`.claude/skills/dashboard/SKILL.md` (manual-only claims, the verb list,
"still deferred" lines), settled-decisions SD-47.

## Tests (TDD anchors)

- `tests/test_triggers.py`: `fireable` verb — lists the three modes with
  mode+kind columns, excludes event, window-gated, disabled excluded;
  `manual` verb gone (unknown subcommand).
- `tests/test_pipeline.py`: `start_run_trigger` accepts `fire_params` on
  continuous/schedule; still refuses on event.
- `tests/test_trigger_dispatch.sh`: the `always-on` continuous fire pin
  FLIPS (WARN-removed → fires native); schedule fire runs + cron
  `last_fire` marker byte-untouched; shim empty-body fires `tok:shim`;
  shim+payload marker removed loudly, no run; event marker removed with
  the new reason; stopped trigger's marker kept, no run; capacity /
  window-closed / disabled deferrals hold for the new modes.
- `tests/test_dashboard_state.py`: `fire_ready` true for native
  continuous/schedule (the `coder` shim pin flips true w/ no params
  form), false+reason for event; shim overrides refuse; `fire_params`
  projection for native continuous.
- CP1-added: shim+payload removed loudly WHILE AT CAPACITY (classification
  precedes the defer arms); native deterministically-bad payload removed
  at capacity; enumeration-refused-but-file-reads-disabled marker kept
  (fallback keeps, never fires); stopped trigger's marker kept across the
  classification pass; schedule due + run-now same tick defers the marker
  (accepted bound, pinned).

## Accepted bounds

- A fire that reaches `run_session` and fails keeps the marker and retries
  every tick with a WARN (pre-existing manual behaviour, now mode-generic)
  — a visible loop on the under-fire side.
- Backoff does not defer an explicit fire (pre-existing; decision 5).
- A schedule fire near its cron boundary can produce two runs (decision 2).
- Capacity deferral holds the marker indefinitely while the trigger stays
  busy — the operator sees the pending chip; removing the marker is the
  dashboard's existing stop/fire lifecycle.
