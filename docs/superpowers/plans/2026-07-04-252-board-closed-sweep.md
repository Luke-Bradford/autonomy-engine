# Plan: board.sh closed-issue → Done sweep (#252)

## Problem
GitHub ProjectV2's built-in "item closed → set Status Done" workflow cannot be
enabled via API (GraphQL exposes only `deleteProjectV2Workflow`; the toggle is
UI-only). So closed issues freeze in their old column (Blocked/Todo/In Review)
and the board lies. Operator caught 3 today on the eBull board.

## Deliverable
An idempotent per-iteration sweep: for every project item whose linked issue is
`CLOSED` and whose Status is not already the Done option, set Status → Done.

## Design (repo-agnostic, best-effort, fail-safe — SD #6)
Revised after Codex checkpoint 1 (pagination, CLI decomposition, PID-scoped
scan, rate-limit gate scope, int-sanitized floor, optionId comparison).

### bin/board.sh
1. `SWEEP_RATELIMIT_FLOOR` — read from env, **sanitized to a non-negative int**
   (`*[!0-9]*|'' → 100`) so a bad value can never misgate or emit arith errors.
   `SWEEP_MAX_PAGES=20` runaway guard (≤2000 items/pass).
2. New function `board_sweep_scan(pid, done_opt)` — PID is a global node id, so
   **no user/org fallback and no title ambiguity** (Codex): query
   `node(id:$pid){ ... on ProjectV2{ items(first:100, after:$cursor){
   pageInfo{hasNextPage endCursor} nodes{ id
   fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ optionId } }
   content{ ... on Issue{ state } } } } } } rateLimit{ remaining }`.
   - **Paginates in bash**: loop the gh call threading `endCursor` until
     `hasNextPage=false` or `SWEEP_MAX_PAGES` (warn if capped — no silent cap).
     Two query literals (first page has no `after`; paginated page passes
     `after:$cursor`) to avoid the null-cursor variable ambiguity.
   - Python (stdlib) parses each page → first line `remaining<TAB>hasNext<TAB>endCursor`,
     then one **item id** per line for items whose content is an Issue with
     `state==CLOSED` and whose Status `optionId != done_opt`.
   - **Idempotent** via optionId: an already-Done item yields no id; a closed
     issue with no/other Status yields its id (a closed issue SHOULD be Done).
   - Drafts (`DraftIssue`) and PRs never match `... on Issue` → skipped.
3. New `sweep` command — decomposed BEFORE the issue-required usage check
   (Codex): `sweep` needs no `<issue#>`. Shares OWNER/PROJECT_TITLE resolution +
   owner validation via a small `resolve_board_target` helper reused by
   status/add.
   - Read `board.done_status` (overlay key `board_done_status`), default `Done`.
   - `board_resolve_field owner title "Status" "$DONE_NAME"` → `PID FID DONE_OPT`
     (one user→org pass). Skip (warn, exit 0) if project / Status field / Done
     option not resolved.
   - `board_sweep_scan "$PID" "$DONE_OPT"` → read remaining + ids.
   - **Rate-limit gate scope**: the floor gates the N-mutation *batch* (the
     expensive part); the single scan read is unavoidable. If
     `remaining >= 0 && remaining < FLOOR`, warn + exit 0 without mutating.
   - For each id: `set_single_select PID id FID DONE_OPT`; count successes;
     warn a one-line summary. Every failure warns + continues. `exit 0`.

### bin/supervisor.sh (engine-side wiring — the issue's "or loop preflight")
- Helper `sweep_board()`: `( cd "$AUTONOMY_TARGET_REPO" &&
  "$ENGINE_HOME/bin/board.sh" sweep ) >>"$SUPLOG" 2>&1 || true`.
- Call it once per loop iteration after the pause/resume block (so a paused
  loop skips it), before cron. Repo-agnostic, no guardrail file touched
  (`.autonomy/loop_prompt.md` is guardrail — barred; the supervisor is not).
  board.sh is best-effort (exits 0); `|| true` is belt-and-suspenders so a
  sweep can never perturb dispatch.

## Tests (real scripts sourced; stub only the gh / board.sh process seam)
1. `tests/test_board_resolve.sh` (+): `board_sweep_scan` with a mocked `gh`
   function — closed+non-Done → id; closed+already-Done(optionId==done) →
   skipped; open → skipped; draft/PR content → skipped; remaining parsed;
   **two-page pagination** (page 1 all-Done/hasNext=true, page 2 has a closed
   non-Done issue → its id is returned, proving the tail is reached);
   page-cap warn path.
2. `tests/test_board_cli.sh` (+): `board.sh sweep` as a subprocess with fake gh
   on PATH — Done mutation written for the closed non-Done item only; gh-fail →
   exit 0, no mutation; rate-limit-low response → exit 0, no mutation;
   `sweep` runs WITHOUT an `<issue#>` arg (no usage error).
3. `tests/test_supervisor_sweep.sh` (new): source supervisor.sh, point
   `ENGINE_HOME` at a temp dir with a fake `bin/board.sh` — `sweep_board`
   invokes `board.sh sweep`, returns 0, and STILL returns 0 when the fake
   exits 1 (best-effort). Loop *placement* (after the pause `continue`, before
   cron) is verified by inspection — consistent with how cron-fire placement is
   not position-unit-tested (the main loop body is guarded, not factored).

## Invariants honored
- Best-effort periphery (SD #6): every board.sh path warns + exits 0; supervisor
  wrapper `|| true`.
- Fail-safe (SD #4): a `gh`/parse failure yields no ids (no wrong Done write); an
  unknown rate limit does not falsely block, but each mutation is independently
  fail-safe.
- Repo-agnostic: owner/title/done-status all from config (+ overlay); default
  `Done`; no hardcoded board values in bin/.
- bash 3.2 / stdlib-only python. Reset-epoch split untouched.

## Post-CP2 hardening (Codex checkpoint 2)
- **All-or-nothing scan**: a mid-pagination `gh`/parse failure marks the scan
  incomplete and emits NO ids (the tail is retried next pass) rather than a
  partial target set built from only the pages that loaded. A deliberate page
  cap is distinct — it keeps the ids it did scan and warns.
- **Early command validation**: `cmd` is checked against `status|add|sweep`
  before any resolve/issue-view/add/priority side effect, so an unknown command
  can never mutate the board on its way to the usage warning (a latent
  pre-existing behavior, fixed while decomposing the dispatch).
