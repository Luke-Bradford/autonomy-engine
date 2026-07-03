# Choreography feed — #177 piece 3

**Date:** 2026-07-03
**Issue:** #177 (always-on liveness), piece 3 of 4 (pieces 1/2/4 shipped as #181/#182/#194).

## Problem

The supervisor already *logs* the org's choreography — cron fires and event wakes —
to `supervisor.log`:

- `cron: role 'X' due (schedule '…') -- firing`
- `event: role 'X' woken by pr.opened (175 176)`
- `event: role 'X' woken by session.done`

The dashboard surfaces these only as flat grey text inside the **Supervisor voice**
panel, indistinguishable from pacing/backoff chatter. Piece 3 of #177 asks that
these handoffs become **first-class feed lines with role chips** — the operator
should see "QA ← woken by pr.opened #175", "PM cron fired" as choreography, not
bury it in the voice log.

## Scope (this slice)

- A structured **handoff feed**: cron fires + event wakes + session-done handoffs,
  parsed into `{ts, kind, role, event, refs}` entries, rendered with a role chip.
- Empty state ("No handoffs yet — cron/event roles will show here when they fire").

**Out of scope (noted for follow-ups):** the roles-roster row pulse/highlight when
its role is acting (sub-bullet 2 of piece 3) — a separate, smaller slice; and any
supervisor-side change (this slice is read-only/dashboard-only).

## Approach — decision

Two candidate data sources were weighed:

- **(A) Parse the existing `supervisor.log` choreography lines** (dashboard-only,
  read-only). No new files, no supervisor change; the emit-strings already exist
  and are stable. Cost: couples the dashboard to a free-text log format.
- **(B) A structured "twin" file** the supervisor appends per handoff (mirrors the
  #177-slice-1 heartbeat pattern). Robust contract, but adds a second growing file
  needing rotation and a supervisor.sh change (more surface, near the loop core).

**Chosen: (A).** It is the smaller, lower-risk, additive change; supervisor.log is
already read and bounded-at-read by the dashboard. The free-text coupling is
contained by parsing **server-side in Python** (unit-testable against real log
lines) and documenting the coupling back to the supervisor emit sites
(`bin/supervisor.sh:511,564,591`) so a future edit that changes the strings breaks
a test rather than silently blanking the feed.

## Components

### `lib/dashboard_state.py`

`read_choreography(path, scan=400, keep=12)` — read-only, best-effort (mirrors
`read_supervisor_voice`):

- **Streamed, bounded read** — `deque(fh, maxlen=scan)` keeps only the last `scan`
  lines in memory (choreography is sparse; a wide window so real handoffs don't
  scroll off behind pacing chatter). A multi-MB log never loads whole.
- Each `log()` line is `<ISO8601Z> [optional [LABEL] ]<body>`. The `ts` is always
  the first whitespace-delimited token (the writer always prefixes it via
  `date -u +%FT%TZ`); `iso_epoch(ts)` → epoch (`0` if unparseable — never raises).
- Match the three choreography shapes with **`$`-anchored `re.search`** on the
  remainder (search, not `^`-anchor: any ts+lane-label prefix — including a label
  containing `]` — is simply skipped over, never mis-parsed):
  - `cron: role '<r>' due (schedule '…') -- firing$` → `{kind:"cron", role, event:null, refs:[]}`
  - `event: role '<r>' woken by session.done$` → `{kind:"event", role, event:"session.done", refs:[]}`
  - `event: role '<r>' woken by <event> (<tokens>)$` where `<event>` is one of the
    four v1 kinds and `<tokens>` is `([^)]*)` → `{kind:"event", role, event, refs:[…]}`.
- **Fail-safe ref validation** (the emit site only fires with non-empty new tokens,
  so anything else is noise): require ≥1 ref token, and each token must match its
  event's shape — `\d+` for `pr.opened`/`issue.created`/`merge.done`, `\d+:[0-9a-f]+`
  (number:sha) for `pr.synchronize`. A ref that fails → the whole line is skipped,
  never rendered as a garbage handoff.
- Each entry carries `ts` (epoch int) and the raw ISO `at` string for display.
- Return the last `keep` entries, oldest-first. `[]` on missing/unreadable file or
  when nothing matches. Non-choreography lines (pacing, backoff, `session rc=…`,
  `session failed`) are ignored.

Wired into `build_repo_state` as `"choreography": read_choreography(...)`.

### `lib/dashboard_page.html`

A **Handoffs** feed rendered from `repo.choreography` across repos: one line per
entry — role chip + a human phrasing ("← woken by pr.opened #175", "cron fired",
"← woken by session.done") + relative time (client-side `ago`, reusing the
existing `agox`/`data-t` countdown-tick pattern). Entries from all repos are
flattened and **sorted by `ts` ascending** (stable) so the global feed reads
chronologically regardless of repo order; `ts===0` (unparsed) sorts oldest. All
fields `esc()`'d (log content is repo-local, not trusted UI text). Empty state when
no repo has handoffs.

## Error handling / invariants

- **Read-only + best-effort** — a missing/torn/huge log degrades to `[]`; the
  choreography feed never blocks or errors the render (matches `read_heartbeat`,
  `read_supervisor_voice`).
- **Fail-safe parsing** — a line that does not match a known shape is skipped, never
  guessed. Unknown event kinds are ignored (only the four v1 events render).
- **Repo-agnostic** — no target-repo values; role/event/refs come from the log.
- **XSS** — every rendered field escaped; only digits reach `data-t`.

## Testing

- `tests/test_dashboard_state.py`: `read_choreography` against real log-line
  fixtures — cron fire, each event kind, session.done, `[LABEL]`-prefixed lines,
  interleaved non-choreography noise (asserts it is filtered), missing file → `[]`,
  malformed ts → entry with `ts=0` (no raise), `keep` bound respected.
- Browser verify (dashboard skill): fixture repo on a non-default port; the Handoffs
  feed renders with a seeded choreography log, zero console errors, `/api/state` +
  `/api/stream` 200; empty state when the log has no handoffs.
