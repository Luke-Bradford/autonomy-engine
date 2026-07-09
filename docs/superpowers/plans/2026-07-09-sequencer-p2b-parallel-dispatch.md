# Sequencer P2b — bounded parallel dispatch + cron/event lift (#351)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** A pipeline's parallel-in-the-graph nodes actually OVERLAP: one
dispatch fans out up to the ENFORCED `caps.max_parallel` concurrent
node-sessions (SD-36, amending SD-12 per the operator's pre-authorized
split), each in an ephemeral worktree; cron/event roles drive multi-node
runs to completion within a fire.

**Architecture:** pipeline.py grows a `ready` verb (the ready SET) +
per-node brief/verdict paths + a relaxed record guard (any currently-ready
node). supervisor.sh's `run_session` becomes a dispatcher: ONE ready node =
today's path byte-identical; k>1 = k background sessions in ephemeral
worktrees, collected, recorded individually. Sequential pipelines and
wrapped legacy roles never take the parallel path.

## Global Constraints

P1/P2a constraints verbatim (bash 3.2 — regular arrays ONLY, no wait -n
[bash 4.3+]; stdlib; shellcheck incl. tests; fail-safe; repo-agnostic;
prevention-log #1/#2/#3/#6/#9/#12/#17/#18; TDD; safe_merge). Plus:

- **SD-36 rides this PR** (amendment to SD-12, operator pre-authorized).
- **SD-15 session-log contract**: parallel logs stay `session-<ts>.log`
  shaped — uniqueness via a per-node suffix INSIDE the ts token is NOT
  allowed; instead `session-<ts>.log`, `session-<ts>-2.log`? NO — the
  dashboard globs `session-*.log`; pattern kept by seconds-unique names:
  allocate per-session names `session-<ts>.log` with a bounded retry
  bumping <ts> by one second per collision (glob-compatible, ordering
  preserved). Role sidecars written per log as today.
- **No wall-clock concurrency assertions** (prevention-log #9): overlap is
  proven with a file barrier a serial executor cannot cross.

## Design decisions (locked)

1. **`caps.max_parallel`**: optional int 1..8, default 1 (validated;
   absent = sequential). The ENFORCED fan-out ceiling (v5 §2).
2. **Ready set**: `ready_set(doc, state, n)` = first n READY units in doc
   order, one current node per unit (a container contributes at most one
   node — its internal flow stays sequential). CLI
   `ready <state> --max <n> --brief-dir <dir> [--journal <p>]` prints per
   node a block `NODE=/KIND=/PROMPT=/VERDICT=/NODE_*=` terminated by
   `END`, or a single `DONE <outcome>` line (same finish/backstop
   semantics as `next`). `next` remains = `ready --max 1` (CLI kept for
   the sequential path + back-compat).
3. **Per-node files**: brief `<state-base>.<node>.brief.md`, verdict
   `<state-base>.<node>.verdict.json` (both lane-safe via the state base).
   The compiled loop/verdict footers name the per-node RELATIVE verdict
   path; the engine reads it relative to the SESSION'S working directory
   (main checkout or ephemeral worktree). Sequential single-node dispatch
   uses the same per-node names (one derivation everywhere; the P2a shared
   name retires — supervisor scrubs/reads per node).
4. **Explicit batch protocol — `dispatched` status (Codex CP1)**: `ready`
   MARKS the returned units `"status": "dispatched"` (atomic state write at
   ready time). Dispatched units are not ready again, cannot be SKIPPED by
   a sibling's failure record (skip rule touches pending only), and while
   ANY unit is dispatched the walk cannot finish or cap-finish (records of
   the batch land first). `record` accepts exactly: a dispatched unit whose
   expected node matches. New outcome `retry`: `record <state> <node>
   retry` returns dispatched→pending with NO nodes_done entry and NO
   session count (the supervisor maps usage_limit to it — the node re-runs
   after the reset; nothing advances around it). Crash recovery: `ready`
   RECLAIMS stale dispatched units (re-returns them) — a crash between
   mark and record re-runs at most one batch (duplicate work, safe
   direction) instead of stranding the run; the supervisor is the sole
   driver and operates the mark→collect→record cycle synchronously, so
   reclaim only fires after a genuine crash.
4b. **Cap clamp (Codex CP1)**: `ready --max n` clamps to
   `max_sessions_per_run - sessions`; a clamp to 0 takes the existing
   cap-finish path. The enforced run cap can never be overshot by a batch.
5. **Ephemeral worktrees**: fan-out sessions (k>1) each run in
   `git worktree add --detach <tmp> origin/main` (mirrors what preflight
   leaves the main checkout on), `materialize_planner` run per worktree
   (gitignored file, not shared), worktree REMOVED after collection
   (best-effort; `worktree_gc` is the backstop). k==1 dispatch runs in the
   main checkout exactly as today (zero new machinery on the hot path).
   Branch-level races between parallel sessions (both push one branch)
   are the briefs' concern (pull-rebase-push is instructable) — recorded
   honestly in the template README, not silently absorbed.
6. **Outcome aggregation** (fail-safe, Codex CP1 refinements): collect
   per-session `(rc, outcome)` via per-session result files; order:
   collect ALL → record ALL (usage_limit → `retry`) → remove worktrees
   (verdicts are read from each session's OWN cwd —
   `<cwd>/var/autonomy-logs/<per-node-verdict>` — so removal must follow
   records). Children NEVER persist reset epochs (SD-7: adapters extract,
   the supervisor persists); the dispatcher persists the MAX epoch across
   the batch's usage_limit outcomes (a smaller epoch must not overwrite a
   later one). Aggregate rc: 3 if any usage_limit, else worst error rc,
   else 0.
6b. **Log-name allocation is atomic** (Codex CP1): reserve
   `session-<ts>.log` with noclobber (`set -C; : > f`), bumping seconds on
   collision, bounded retries — check-then-bump would race two concurrent
   allocations. SD-15 glob shape preserved; sidecar written after reserve.
6c. **Worktree leak handling is explicit** (Codex CP1 — worktree_gc does
   NOT remove live directories): ephemerals live under
   `$VARDIR/autonomy-worktrees/<run>-<node>` (operator-visible); the
   dispatcher sweeps THAT NAMESPACE of leftovers before creating new ones
   and removes its own after records (`git worktree remove --force` +
   `prune`, failures logged loudly with the path).
7. **Cron/event lift — in-flight runs JOIN the main loop** (simpler than a
   drive-loop, Codex CP1): the main loop's dispatch list gains any role
   with an in-flight run state regardless of trigger type (extending the
   P2a empty-board in-flight logic to every tick), so a cron/event fire
   STARTS the run and the main loop advances it one dispatch per iteration
   with the loop's own limit/backoff/pause handling — no duplicated rc-3
   semantics at the resolver call sites. The P2a multi-node cron/event
   resolve refusal lifts.
8. **Honesty**: template ships `max_parallel: 1` (opt-in concurrency;
   README explains raising it and the branch-race caveat). S33's oracle
   lands as an engine test, not a template default.

## File structure

- Modify `lib/pipeline.py`: caps.max_parallel validation; `ready_set` +
  `ready` CLI; per-node verdict path in footers (`_verdict_rel(state,
  node)`); record guard relaxation.
- Modify `bin/supervisor.sh`: `resolve_pipeline_ready` (parses blocks),
  `dispatch_parallel` (worktrees + bg sessions + collection),
  `_drive_pipeline_run` at cron/event sites; per-node verdict scrub/read;
  unique log-name allocation.
- Modify `docs/settled-decisions.md`: SD-36.
- Modify template README (+ `max_parallel` doc line in pack config example).
- Tests: `tests/test_pipeline.py` (ready_set, per-node paths, record
  relaxation, max_parallel validation); `tests/test_pipeline_runner.sh`
  (parallel dispatch with barrier stubs proving overlap structurally,
  usage_limit mixing, worktree cleanup, cron drive-to-completion).

## Task-2 bash traps (adversarial-review findings, all folded)

- **No `$$` in backgrounded paths** (bash 3.2 has no BASHPID; `$$` is the
  parent) — every per-session temp name derives from the NODE id (unique
  within a batch) + the state base. Children never call
  persist_reset_epoch or any `.$$`-tmp helper.
- **Log-name allocation**: noclobber (`set -C`) atomic claim of
  `session-<date +%Y%m%dT%H%M%S>.log`; on collision `sleep 1` and re-stamp
  (real seconds — no GNU/BSD date math, SD-15 name shape byte-exact for
  the dashboard's parser). Max k-1 seconds of startup skew per batch.
- **Worktree removal**: `git worktree remove --force` (sessions leave WIP
  by design), fallback `rm -rf` + `git worktree prune`; the namespace
  sweep at dispatch start applies the same sequence to leftovers; every
  failure logs the PATH loudly. worktree_gc is NOT claimed as a backstop.
- **Dispatcher owns all shared-checkout work**: ONE preflight + ONE rules
  compose + worktree creation happen foreground; bg subshells only
  `cd <their worktree>`, run materialize_planner there, invoke, classify,
  write their result file. Nothing backgrounded touches the main checkout.
- **Collection is wait-per-pid**, never spin-on-files: `wait "$pid"` per
  child (3.2-safe) captures each rc; a killed child's missing result file
  reads as `error` (fail-safe). No `wait -n`.
- **TERM during the batch**: the trap kills the recorded child pids (and
  their process groups) BEFORE releasing the lock/exiting, so a KeepAlive
  relaunch never runs alongside orphans; the relaunch's first pick
  RECLAIMS the dispatched units (at-most-one-batch duplicate work, safe
  direction — decision 4).

## Tasks

1. **pipeline.py: max_parallel + ready_set + per-node paths + guard
   relaxation** (TDD; the `next` CLI stays as the --max 1 view; P2a tests
   keep passing with per-node verdict names threaded through the runner
   test only at task 3).
2. **supervisor.sh: parallel dispatcher** (bg subshells + result files +
   worktree lifecycle; k==1 short-circuits to today's path).
3. **runner test: structural overlap barrier** (stub adapter writes
   `<node>.inflight`, spins bounded for the sibling's marker, then
   completes; a serial executor times out the first stub -> test fails;
   plus mixed usage_limit/error collection + worktree removal asserts).
4. **cron/event drive-to-completion + lift the resolve refusal** (TDD via
   test_scheduler-style stubs).
5. **SD-36 + template README/config-example docs + gates + CP2 + PR.**
