# Plan — choreography feed (#177 piece 3)

Spec: `docs/superpowers/specs/2026-07-03-choreography-feed-design.md`.
Dashboard-only, read-only, additive. TDD throughout.

## Task 1 — `read_choreography` parser (TDD)

**Test first** (`tests/test_dashboard_state.py`, new cases sourcing the real
`dashboard_state`):

- cron fire line → one `{kind:"cron", role:"pm", event:None, refs:[], ts, at}`.
- each event kind (`pr.opened`/`issue.created`/`merge.done`) with numeric refs →
  `{kind:"event", role, event, refs:[...]}`; `pr.synchronize` token `NUMBER:SHA`
  preserved verbatim in refs.
- `session.done` wake → `{kind:"event", event:"session.done", refs:[]}`.
- `[lane-label] ` prefix between ts and `cron:`/`event:` tolerated — AND a label
  containing `]` still parses (uses `re.search`, not a `[^]]*` strip).
- **fail-open guard:** an event line with empty refs `(…woken by pr.opened ()`) or a
  non-numeric ref (`(abc)`) or a `pr.synchronize` token missing its `:SHA` → skipped
  (not rendered as a garbage entry).
- interleaved non-choreography lines (pacing, `session rc=…`, `session failed`,
  backoff) filtered out.
- missing file → `[]`; unreadable → `[]`.
- unparseable ts (garbage first token, body still valid) → entry returned with
  `ts=0` (never raises).
- more than `keep` matches → only the last `keep`, oldest-first.

**Implement** `read_choreography(path, scan=400, keep=12)` in
`lib/dashboard_state.py`:

- **Streamed bounded read:** `deque(fh, maxlen=scan)` inside `try/except OSError ->
  []` (add `deque` to the existing `from collections import …` line).
- Per line: `parts = line.split(None, 1)`; skip if `len<2` (no body). `ts_str,
  rest = parts`; `ts = iso_epoch(ts_str)` (already 0-safe).
- Three `$`-anchored `re.search` patterns on `rest` (search — NOT `^`-anchored — so
  any lane-label prefix, `]` included, is skipped over):
  - `cron: role '([^']+)' due \(schedule '.*'\) -- firing$`
  - `event: role '([^']+)' woken by session\.done$`
  - `event: role '([^']+)' woken by (pr\.opened|issue\.created|merge\.done|pr\.synchronize) \(([^)]*)\)$`
    → `refs = group(3).split()`; **validate**: require `refs` non-empty AND every
    token matches `\d+` (number events) / `\d+:[0-9a-fA-F]+` (`pr.synchronize`);
    else skip the line.
- Anything else → skip.
- Comment block citing the coupled emit sites `bin/supervisor.sh:511,564,591`, the
  ref-shape contract from `_event_poll`, and the fail-safe/read-only contract,
  mirroring `read_heartbeat`.
- Return last `keep`, oldest-first (`list(...)[-keep:]`).

Wire `"choreography": read_choreography(os.path.join(logdir, "supervisor.log"))`
into `build_repo_state`.

## Task 2 — render the Handoffs feed (`lib/dashboard_page.html`)

- New small panel (or a labelled block in the existing activity column) `#handoffs`.
- `renderHandoffs(repos)`: flatten `repo.choreography`, **sort by `ts` ascending**
  (stable; `ts===0` sorts oldest) so the global feed is chronological across repos;
  tag repo name when >1 repo has entries (voice panel's `many` pattern); map to lines:
  - cron → `<chip>role</chip> cron fired`
  - event (`session.done`) → `<chip>role</chip> ← woken by session.done`
  - event (other) → `<chip>role</chip> ← woken by <event> <#refs joined>`
    (refs rendered `#175 #176`; `pr.synchronize` `N:SHA` shown as `#N`).
- Relative time via existing `ago(nowS()-ts)` + `agox`/`data-t` tick class so it
  live-updates; skip the time when `ts===0`.
- Empty state: "No handoffs yet — cron/event roles appear here when they fire."
- Every field `esc()`'d; only digits reach `data-t`.
- Call `renderHandoffs` from the same place the other per-poll renderers run.

## Task 3 — verify + finalize

- `bash tests/run_all.sh`; `python3 -m py_compile lib/dashboard_state.py`.
- Browser verify per dashboard skill: seed a fixture `supervisor.log` with a couple
  of choreography lines, launch `python3 bin/dashboard.py --repo
  tests/fixtures/repo-alpha --port 8790`, drive `/`, assert the Handoffs feed
  renders, zero console errors, `/api/state` + `/api/stream` 200; assert empty state
  with a log that has no handoffs. Kill server.
- Update memory (control-room-status). PR per pr-authoring (security-model section).

## Invariants touched

- Read-only/best-effort (never blocks/error the render) — like `read_heartbeat`.
- Fail-safe parsing (unmatched → skipped, never guessed).
- Repo-agnostic (no target-repo values). stdlib only. No bash changed.
