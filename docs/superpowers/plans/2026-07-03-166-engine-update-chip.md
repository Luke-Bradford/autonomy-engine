# Plan — #166 slice 1: engine "update available" truth chip

## Problem

Merged engine changes to the two **thin shells** (`bin/supervisor.sh`,
`bin/dashboard.py`) are NOT live in a running process — bash function bodies
and Python imports bind at process start. After #193 the dashboard's *logic
modules* (`lib/dashboard_*.py`) and per-request assets (`lib/*.html`) hot-reload,
and the supervisor re-reads config + invokes `lib/*.py` as subprocesses per tick
— but each process's own shell/script body is frozen at its boot commit. So a
merged fix to a thin shell silently doesn't appear until someone restarts, which
looks identical to "the fix didn't work" (operator hit this 2026-07-03).

Slice 1 (this PR) = **truth only, no auto-anything**: each service records the
engine sha it booted from; the dashboard compares against the engine checkout's
current HEAD and shows a header chip when they diverge. Slice 2 (safe
self-refresh) is explicitly out of scope.

## Settled decisions / prevention log that apply

- **SD-4 fail-safe never fail-open**, **SD-9 dashboard is display + loopback**:
  the chip is *display-only* — no new control endpoint, no restart action here.
  Fail-safe display direction: if the current engine sha can't be read, show NO
  chip (never cry wolf on a false positive; a missing chip is the safe default).
- **SD-3 repo-agnostic bin/lib**: engine sha is read from `AUTONOMY_ENGINE_HOME`
  (the engine checkout), never a target repo. No target-specific values added.
- **SD-6 best-effort periphery**: writing the supervisor boot-sha file mirrors
  the `heartbeat()` contract — any failure swallowed, never perturbs the loop.
- Prevention-log #2 (`local x=$(cmd)` masks exit status) — the bash sha capture
  must not gate on a masked status; it's best-effort so this is moot, but keep
  the assignment and use separate.

## Intentional over-report (documented tradeoff)

The boot-sha comparison flips on ANY engine commit, even one that only touched a
hot-reloaded `lib/*.py` (already live). So the chip can suggest a restart that
isn't strictly needed. This is the fail-safe direction (better a redundant
restart hint than a hidden stale shell) and is exactly what the ticket specifies
for slice 1 ("just truth: running-sha != main-sha → chip"). Slice 2 refines.

## Design

### Engine-home contract (unified — Codex CP1 #4)

Both languages resolve the engine checkout the SAME way: the exported
`AUTONOMY_ENGINE_HOME` env var when set, else the path derived from the file
location. Bash already sets+exports it (`supervisor.sh:19-20`); Python uses
`os.environ.get("AUTONOMY_ENGINE_HOME") or dirname(dirname(abspath(__file__)))`.
Tests override the env var / pass an explicit arg.

### Boot-sha capture

- **Supervisor** (`bin/supervisor.sh`): new function
  `write_engine_boot_sha [engine_home] [logdir]` (defaults to globals
  `$ENGINE_HOME` / `$LOGDIR`) so tests can pass a temp git repo + temp dir
  (Codex CP1 #6). Called once at boot after `LOGDIR` exists + lock held. Writes
  `git -C "$home" rev-parse HEAD` to `$logdir/engine_sha`, best-effort (swallow
  all errors), single line, atomic tmp+mv like `heartbeat()`. Under
  `var/autonomy-logs/` → already gitignored.
- **Dashboard** (`bin/dashboard.py`): capture `DASHBOARD_BOOT_SHA =
  ds.engine_head_sha()` once at import time (module constant).

### dashboard_state primitives (pure, unit-tested)

- `engine_head_sha(engine_home=None) -> str` — `git -C <home> rev-parse HEAD`;
  `""` on any failure. Default home = env `AUTONOMY_ENGINE_HOME` else
  `dirname(dirname(abspath(__file__)))`.
- `read_engine_boot_sha(logdir) -> str` — read `<logdir>/engine_sha`, first line
  stripped. **Returns `""` unless the value matches a full 40-char lowercase
  hex sha** (`^[0-9a-f]{40}$`) — a torn/corrupt/manual file is treated as absent
  so it can never manufacture a false stale (Codex CP1 #1, fail-safe).
- `engine_commits_behind(running, current, engine_home=None) -> int | None` —
  count of commits reachable from `current` but not `running`:
  `git rev-list --count <running>..<current>`. `None` when unknowable (either
  sha empty, git fails). This is "how many new commits the running process is
  missing"; it is valid even for divergent shas, so NO ancestry precondition is
  needed (Codex CP1 #2 — dropped the non-ancestor claim rather than add a check).
  Staleness is decided by the string compare below, not by this count; the count
  is display sugar only. Never raises.
- `engine_status(dashboard_boot, repos, head_reader=engine_head_sha,
  behind_reader=engine_commits_behind) -> dict` — composition, injectable
  readers for tests. Returns:
  ```
  {
    "current": "<sha|''>",
    "dashboard": {"sha": "<boot>", "behind": N|None, "stale": bool},
    "supervisors": [ {"repo": name, "sha": "<boot>", "behind": N|None,
                      "stale": bool}, ... ],   # LIVE supervisors with a valid recorded sha
    "stale": bool,                             # OR of every service's stale
    "behind": N|None                           # MAX behind across stale services (Codex CP1 #5)
  }
  ```
  `stale` for a service = `current != "" and boot != "" and boot != current`.
  When `current == ""` (unreadable) every `stale` is False → no chip (fail-safe).
  `behind` (top-level) = `max` of the non-None per-service `behind` among stale
  services, else `None`. Aggregation rule is explicit so page + state agree.

### Wiring

- `build_repo_state` gains `"engine_boot": read_engine_boot_sha(logdir)` so the
  aggregator sees each supervisor's recorded sha without re-deriving the path.
- `collect()` (dashboard.py) adds `"engine": ds.engine_status(DASHBOARD_BOOT_SHA,
  out)` to the payload, where `out` is the per-repo list. A supervisor becomes a
  `supervisors` entry when its `lifecycle.pid` is truthy (a LIVE process —
  running OR paused; a paused loop is still booted from old code, Codex CP1 #3)
  and its `engine_boot` is a valid sha.

### Page (`lib/dashboard_page.html`)

- Header chip, rendered only when `state.engine.stale`. Text:
  `engine updated (N commits) — restart to apply` where N = `engine.behind`;
  drop the `(N commits)` when `behind` is None or 0. `title=` tooltip lists which
  services are behind (`dashboard` / `supervisor:<repo>`). Neutral/info styling —
  a pending restart is informational, not an error (healthy=boring).
- All shas/repo names `esc()`'d (file-sourced content).

## TDD order

1. `tests/test_dashboard_state.py` (extend): `engine_commits_behind` (real temp
   git repo → count; empty sha / git-fail → None), `read_engine_boot_sha`
   (valid 40-hex → returned; absent / torn / non-hex / short → ""),
   `engine_status` (all-fresh → stale False; dashboard-behind → stale True +
   behind; a LIVE-but-paused supervisor counts as stale; a STOPPED supervisor
   with a stale file is ignored; current unreadable → stale False everywhere;
   top-level `behind` = max across stale services). Inject readers — no real git
   in the composition test.
2. `tests/test_heartbeat.sh` or a new `tests/test_engine_sha.sh`: source
   supervisor.sh, call the boot-sha writer against a temp LOGDIR + a temp git
   repo, assert the file contains HEAD; assert a git-less ENGINE_HOME leaves no
   file and returns cleanly (best-effort).
3. Implement to green; shellcheck + run_all; browser-verify the chip via the
   dashboard skill (fixture repo, chip shows when boot sha forced stale).

## Out of scope (slice 2, ticket #166)

Supervisor `exec`-self at the session boundary; dashboard `launchctl kickstart`
/ one-click restart control. This PR only tells the truth.
