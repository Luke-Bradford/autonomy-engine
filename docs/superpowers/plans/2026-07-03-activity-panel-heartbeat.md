# Plan — #177 piece 4: activity panel narrates the supervisor heartbeat between sessions

## Problem
The operator's complaint (#177): "sat idle for 5 minutes with no visibility." The NOW
*card* already narrates the heartbeat (slice 2, PR #182). But the large **activity panel**
(`renderActivity`, lib/dashboard_page.html:618-620) still falls back to a bare empty state —
`"No session activity right now…"` — whenever no repo has a live session with tool nodes.
So the main activity view is blank during preflight holds, limit backoff, pace waits, cron
checks, and event polls, even though the supervisor knows exactly what it is doing and why.

## Fix (presentational only — data already in state)
`r.heartbeat = {ts, phase, until, reason}` is already assembled per-repo in
`lib/dashboard_state.py` (`read_heartbeat`, line 940) and tested
(`tests/test_heartbeat.sh`, `tests/test_dashboard_state.py`). Reuse it.

In `renderActivity`, replace the bare empty branch: when no repo has session activity but
one or more alive supervisors have a heartbeat, render a **tick narration** block per alive
repo instead of the blank message:

- **Predicate (Codex-1 fix):** narrate only repos where `dispStatus(r)==="idle"` — the
  EXACT branch the NOW card renders heartbeat in (alive, between sessions). `!=="stopped"`
  was too broad (would include `needs-setup`/`missing`/`error` and show a stale heartbeat as
  live). `stopped`/`working`/`paused`/`stopping`/error states are all excluded, matching the
  card's semantics and the fail-safe/stale-liveness invariant.
- **Escape everything (Codex-1 fix):** `reason`, phase label, and role are repo-local FILE
  content, not trusted UI text — all pass through `esc()` before `innerHTML`.
- **Countdown (Codex-1 fix):** emit `.qreset` ONLY when `hb.until>nowS()` — byte-identical to
  the NOW card (lib/dashboard_page.html:414-416); `until` is an int from `read_heartbeat`
  (0/absent → `0>now` false → no countdown). The existing `.qreset` ticker (line 712) drives it.
- **Phase chip (Codex-1 fix):** the ACTUAL emitted phases are `preflight-hold`,
  `limit-backoff`, `pace-wait`, `polling-events`, `cron-check`, `session-running <role>`,
  `board-empty`, `idle` (grep of bin/supervisor.sh — there is NO `dispatching <role>` phase;
  drop it). Chip = the phase's leading token, humanized. A role chip is shown ONLY for
  `session-running <role>` (the sole role-bearing phase), scoped to data that exists.
- If NO idle repo has a heartbeat with a reason (fresh checkout, supervisor never started,
  torn/`{}` heartbeat), keep a refined empty message — the fallback stays reachable.

`renderFlat`/`renderTimeline`/`renderActivity` all key off `reposWithActivity(repos)`; the
new narration only occupies the `!ws.length` branch, so the live-session tree/timeline/flat
views are untouched. No view-toggle interaction change.

## Non-goals (kept for later slices)
- Piece 3's full handoff feed sourced from `$VARDIR/events` (event-bus lines like
  "QA ← woken by pr.opened #175") — that needs reading the events dir and is a separate slice.
  This slice surfaces only what the heartbeat already exposes (current phase + reason).
- No "fake motion": every element is backed by the real heartbeat phase or a real countdown
  (the ticket's explicit non-goal).

## Invariants / settled decisions
None changed. Read-only consumer of best-effort heartbeat state (a torn/absent heartbeat
already degrades to `{}` in `read_heartbeat`, so the render simply falls back to the empty
message). Repo-agnostic, no guardrail files touched.

## Verification
Dashboard browser verify loop (dashboard skill) against `tests/fixtures/repo-alpha` on a
non-default port: `/` renders, activity panel shows the heartbeat narration (fixture has a
heartbeat), zero console errors, `/api/state` + `/api/stream` 200. The heartbeat data
pipeline is already covered by the existing state/bash tests; this slice adds no new state.
