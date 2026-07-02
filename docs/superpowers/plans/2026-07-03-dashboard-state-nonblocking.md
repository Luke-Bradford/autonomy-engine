# Plan — #80 dashboard `/api/state` non-blocking (perf)

## Problem

`GET /api/state` and the SSE stream both call `collect(repos)`, which builds
each repo's `git_in_flight` snapshot with **serial synchronous `gh` calls**
(`gh repo view`, `gh pr list --state open`, `gh pr list --state merged`;
timeouts 15–20s each) — and `collect` loops repos serially. The result is
cached (`_gh_cache`, TTL 15s), but every cold load / cache-expiry blocks the
page's data on N repos × 3 serial network round-trips. A single hung `gh` can
stall the whole render for up to 20s even though the page itself is a light
static shell served instantly.

## Fix (three independent, composable changes)

### 1. Parallelise the network `gh` calls inside `git_in_flight`

The three `gh` calls (repo_url, open PRs, merged PRs) are independent. Run them
concurrently via `concurrent.futures.ThreadPoolExecutor` (stdlib). Local `git`
calls (`rev-parse`, `status`) stay serial — they're local and fast, and drive
`head`/`sha`/`dirty`. Cold-per-repo cost drops from ~3×round-trip to ~1×.

### 2. Stale-while-revalidate in `git_in_flight`

- Fresh entry (`now - ts < TTL`) → return it (unchanged).
- **Stale** entry (entry exists, past TTL) → return the stale value
  **immediately**, and trigger **one** background refresh thread that recomputes
  and updates `_gh_cache`. A single-flight guard (`_gh_refreshing` set under
  `_gh_lock`) ensures concurrent stale callers spawn at most one refresh per
  repo; extra callers just serve stale.
- **Cold** (no entry at all) → compute synchronously (with the parallel gh from
  #1) and return, so the first-ever load still yields real data.

Effect: after the first load, every render is instant (in-memory) even if `gh`
is slow/hung — the page shows slightly-stale data and updates when the refresh
lands. No always-on `gh` polling: a refresh is only ever triggered by a request
touching a stale entry, preserving on-demand semantics.

### 3. Parallelise repos in `collect()`

Build the per-repo states via a bounded `ThreadPoolExecutor` so N repos don't
serialise. Output order preserved (`executor.map`). Each repo's work already
touches shared caches under their existing locks (`_gh_lock`, `_issue_lock`,
`_acct_lock`), so concurrency is safe. Self-loop (1 repo) is unaffected; the
control-unit / registry (#4, multi-repo) is the beneficiary.

## Invariants / settled decisions checked

- **Stdlib only** (decision 2): `concurrent.futures` + `threading` are stdlib.
  No new dependency.
- **Repo-agnostic** (decision 3): no target-repo values introduced.
- **Best-effort periphery / never blank the page** (existing `git_in_flight`
  contract): background refresh swallows all exceptions exactly like the sync
  path; a failed refresh leaves the last good (or stale) cache entry, never
  raises into a request. Serving stale is strictly a fail-*safe* direction (show
  last-known, never crash).
- **Dashboard loopback-only + token** (decision 9): untouched — no endpoint,
  auth, or control-path change. Read path only.
- Fail-safe never fail-open (decision 4): N/A to a read cache, but the refresh
  path never widens behaviour — on failure it keeps the prior snapshot.
- Prevention-log #2 (`local x=$(cmd)`): Python, N/A. #6 (re-validate config
  strings): no new config-sourced argv.

## TDD (real `dashboard` module sourced; stub only `_run`)

`tests/test_dashboard_state_nonblocking.py` — import `dashboard`, monkeypatch
`dashboard._run` with a fake that sleeps + records call concurrency/timing, and
manipulate `dashboard._gh_cache` directly:

1. **parallel gh** — a `_run` that sleeps per gh call and records max in-flight
   count; assert the three gh calls overlap (max concurrency ≥ 2), and total
   wall-clock < serial sum. Local git calls still resolve.
2. **cold blocks + returns real data** — empty cache → `git_in_flight` returns
   a populated snapshot synchronously (parses the fake PR JSON).
3. **stale served instantly + background refresh** — seed `_gh_cache` with a
   stale entry whose `_run` would block; assert the call returns the stale value
   without blocking, then (after joining the spawned refresh) the cache holds
   the fresh value.
4. **single-flight** — two concurrent stale callers spawn exactly one refresh
   (count `_run` invocations / refresh-thread starts).
5. **collect parallelises repos** — `collect` over 3 repos with a per-repo
   sleeping `git_in_flight` completes in ~1× not ~3× the sleep; output order
   preserved.

Each test drives the real functions; the only stub is `_run` (the established
subprocess seam) and, where needed, `ds.build_repo_state` for the collect test.

## Revisions after Codex checkpoint 1

- **Single-flight guard cleared in `finally`** (High). `_refresh_worker` clears
  the repo from `_gh_refreshing` in a `finally`, so a refresh that raises can
  never permanently pin a stale entry.
- **`_gh_lock` never held during `gh`** (High). The lock only guards the
  in-memory `_gh_cache` read, the guard-set add/discard, and the cache write.
  `_compute_in_flight` (the git+gh work) runs entirely outside the lock, so one
  slow/hung refresh cannot block cache readers.
- **Timestamp taken at cache write** (Medium), via a fresh `time.time()` after
  compute completes — not the pre-compute `now` — so a long refresh doesn't
  write an already-expired entry and churn.
- **Bounded staleness** (Medium, the fail-open concern). `_GH_MAX_STALE`
  (75s = 5×TTL): within `[TTL, MAX_STALE)` serve stale + background-refresh;
  **at/after `MAX_STALE` fall back to a blocking synchronous refresh** so the
  render path can never show data older than the bound. Note the operator never
  acts on a dashboard chip directly — `safe_merge.sh` independently re-verifies
  CI + review at merge time (the real gate, fail-safe); the SSE stream also
  replaces any served-stale value within one 2s tick once `gh` responds.
- **Snapshot the repos list** (Medium): `collect` does `repos = list(repos)`
  before dispatching to the pool, so a concurrent `Handler.repos` mutation
  (`_refresh_repos`) can't skip/dup a repo mid-map.
- **Shared `_compute_in_flight(repo)` helper** (Low): the synchronous snapshot
  builder, called by BOTH the cold/too-stale path and the background refresh —
  one code path, one lock boundary. `git_in_flight` becomes the cache/staleness
  policy wrapper around it.
- **Scoped claim**: non-blocking applies to the stale `git_in_flight` PR/repo
  `gh` calls. `_issue_focus` (60s cache) and `_account_usage` (45s cache) keep
  their existing short caches — they still block on a cold miss, but that is
  rare and bounded; out of scope here.
- **Extra test**: a refresh whose `_compute_in_flight` raises clears the guard
  and a later stale call spawns a fresh refresh (the permanent-pin race).

## Revisions after Codex checkpoint 2 (on the diff)

Codex flagged concurrent-write hazards in the first cut (a stale background
refresh and a too-stale blocking compute could both write `_gh_cache`, risking a
lost update / older data stamped fresh; `Thread.start()` failure leaving the
guard pinned; `collect`'s pool with no fallback). Resolved by collapsing to a
**single-writer** design:

- `git_in_flight` NEVER writes the cache. All writes funnel through one
  `_refresh_worker` per repo. `_ensure_refresh` is single-flight keyed on a
  `repo -> Thread` dict and **returns the in-flight thread**, so cold/too-stale
  callers `join()` the one running refresh instead of starting a second compute
  (also coalesces the cold `/api/state` + first-SSE-tick double compute). One
  writer per repo ⇒ no concurrent/out-of-order writes.
- The thread is `start()`ed under `_gh_lock` (so a joiner can't observe an
  unstarted thread) and `start()` failure returns None + leaves the guard clear
  (serve stale/empty — best-effort).
- Cold refresh that fails/times out → `_empty_in_flight()` well-formed fallback,
  never a raise into the request. `_GH_JOIN_TIMEOUT` (25s) bounds the wait.
- `collect` falls back to a serial build if the `ThreadPoolExecutor` itself
  fails to spin up.

New test `test_cold_callers_coalesce_to_single_compute` locks the single-writer
guarantee.

## Out of scope

Front-end first-paint changes (page already renders shell instantly). Shortening
gh timeouts (stale-while-revalidate removes the blocking cost that made the long
timeout hurt). Both were listed as alternatives in the issue; not needed once
the render path never blocks on gh.
