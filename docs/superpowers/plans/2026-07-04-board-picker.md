# Plan — #170 config page board picker (populate project_title from `gh project list`)

## Goal
Stop free-text-typing `board.project_title`. Populate it from the owner's live Projects v2
boards (`gh project list --owner <owner> --format json`), select-with-suggestions (datalist —
same deliberate free-text-capable pattern as the #82/#146 model field), and show a subtle
warning row when the current value matches no listed board ("board not found — status sync is
skipping"). Doctor already warns on missing boards; this is the operator-visible page mirror.

## Settled decisions / prevention log that apply
- **SD 6 (best-effort periphery)** + **SD 25 (GitHub is the only board)**: the new read path is
  best-effort — any `gh` failure ⇒ empty list, never breaks the page. board.sh behaviour is
  UNCHANGED (still the merge/status seam); this is read-only display enrichment.
- **SD 23 (labels are the routing contract; Projects v2 is display-only)**: this only enriches a
  display field, changes no routing.
- **SD 9 (dashboard loopback + token)**: new endpoint is a GET *read* like `/api/config` and
  `/api/state` (not token-gated — only POST `/api/control` is). Loopback-only already enforced.
- **Prevention log 6 (config/user strings re-validated before argv)**: the `owner` query param is
  user-supplied and flows into `gh ... --owner <owner>` argv — validate it (`^[A-Za-z0-9][A-Za-z0-9._-]*$`,
  reject empty/leading-dash) BEFORE calling gh; invalid ⇒ empty list, no gh call.
- **Prevention log 3 (silent widen = fail-open)**: not applicable in the fail-open direction — a
  gh failure must NOT invent boards; it returns empty (the field stays free-text, operator can
  still type). The warning is advisory only, never blocks a save.
- **Python 3 stdlib only**: uses `json` + the existing `_run` subprocess helper. No new deps.

## Backend — `bin/dashboard.py`
1. `board_list(owner)` → `{"boards": [<title>, ...], "error": <str|None>}`.
   - Validate `owner` against `^[A-Za-z0-9][A-Za-z0-9._-]*$`; invalid/empty ⇒
     `{"boards": [], "error": "invalid owner"}` with NO gh call.
   - `_run(["gh", "project", "list", "--owner", owner, "--format", "json"], timeout=15)`.
   - None (gh failed/timeout) ⇒ `{"boards": [], "error": "gh project list unavailable"}`.
   - Parse JSON `{"projects":[{"title","closed",...}]}`; keep titles of non-closed projects,
     de-duplicated, order preserved. Bad JSON ⇒ empty + error. Never raises.
   - Cache briefly per-owner (short TTL, mirrors the existing `_gh_cache` intent — a small
     dedicated dict+lock keyed by owner; SSE does not hit this, so a plain TTL cache suffices).
2. Route `GET /api/boards?owner=<owner>` in `do_GET`: parse `owner` from the query string,
   `self._send(200, json.dumps(board_list(owner)))`. Always 200 (payload carries the error).

## Frontend — `lib/config_page.html`
3. `board.project_title` becomes a datalist-backed input (new `cfgFieldBoards` helper, keyed to a
   per-owner datalist id `cfg-boards-<encoded-owner>`) + a hidden-until-triggered warning row.
4. After `renderCfg`, collect distinct non-empty `board.owner` values, fetch
   `/api/boards?owner=` for each, fill that owner's datalist `<option>`s, and — if the repo's
   current `project_title` is non-empty and matches none of the returned boards (and the fetch
   returned at least one board) — reveal the warning row. Fetch failure ⇒ no datalist, no false
   warning (best-effort; the field still works as free text).

## Tests — `tests/test_dashboard_control.py` (python, real module import; mock `_run`/`gh`)
- `board_list` returns titles (closed filtered) from good gh json.
- `board_list` returns `{[], error}` when `_run` returns None (gh failure) — fail-safe, no invented boards.
- `board_list` rejects an invalid owner (`-x`, empty) WITHOUT calling gh (assert gh not invoked).
- `board_list` tolerates malformed json ⇒ empty + error, no raise.
- `GET /api/boards?owner=...` returns 200 with the payload (server test).

## Codex checkpoint 1 resolutions (all accepted)
1. `_send` needs bytes (`len(body)`); JSON routes `.encode("utf-8")` first — do the same.
2. `board_list` lives in `bin/dashboard.py` ⇒ tests go in `tests/test_dashboard_server.py`
   (the file that `import dashboard`), NOT `test_dashboard_control.py`.
3. Warning keys on `error === null && !boards.includes(title)` (successful fetch, no match) —
   NOT `boards.length > 0`; an owner with zero open boards + a set title must still warn.
4. Add `--limit 200` to `gh project list` so a many-board owner doesn't get false "not found".
5. Owner regex tightened to GitHub login grammar `^[A-Za-z0-9](?:[A-Za-z0-9-]*)$` (rejects
   leading dash = argv-option injection, and `_`/`.` which are not valid logins).
6. Filter returned titles through the SAME save contract (`dcx._valid_text`, resolved at call
   time so hot-reload #166 picks up changes) so a suggestion is always savable.
7. After a successful `board.*` `config_set` save, the config page re-fetches boards + re-evals
   the warning for that repo (cfgSave gains a targeted post-save refresh for board keys).
8. `board_list` cache is a module-level `_board_cache` dict+lock keyed by owner with a short TTL;
   tests clear it per-case for determinism.

## Out of scope
- board.sh changes (unchanged; SD 6/25). #171 owner-derive, #169 Priority sync, #90 onboarding
  create-or-pick are separate tickets — no overlap here.
