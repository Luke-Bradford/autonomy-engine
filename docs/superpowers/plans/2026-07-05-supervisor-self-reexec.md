# #294 — supervisor self-re-exec at the session boundary

## Problem

A running supervisor's bash is frozen at process start; merged engine code is
inert until a manual restart. The #240 banner ("refresh at next session
boundary") is a display lie — there is no refresh anywhere.

## Fix (per the issue's proposed design)

At the top of the main loop — between sessions only, never mid-session — the
supervisor compares the engine checkout's current HEAD to the sha captured at
process start. If HEAD differs AND the engine tree is clean, it re-execs
itself: `exec /bin/bash "$ENGINE_HOME/bin/supervisor.sh" <original args>`.
Same pid → lock/pidfile continuity; PAUSE sentinel and `.last_usage_reset`
are on-disk state and survive.

## Pieces

1. **`engine_update_ready <home> <boot_sha>`** (new function, near
   `write_engine_boot_sha`). Prints the current HEAD and returns 0 ONLY when:
   HEAD is readable, non-empty, differs from `boot_sha`, and
   `git status --porcelain` both succeeds and is empty. Every failure path
   returns 1 (prevention-log #18: the "update ready" verdict is earned, never
   the fallback; a git hiccup means keep running — fail-safe). Assignments
   split from `local` declarations (prevention-log #2).

2. **`reexec_engine <home> <args...>`** (new function). Sets
   `shopt -s execfail` (bash's default for a NON-interactive shell is to EXIT
   the process when `exec` fails — execfail makes a failed exec return
   instead, satisfying "never die"), then
   `exec /bin/bash "$home/bin/supervisor.sh" "$@"`. If the exec returns:
   restore execfail to its prior state (never leave global shell semantics
   mutated in the surviving old process — CP1 finding), log one WARN
   ("self-re-exec failed -- continuing on the old code; restart to apply"),
   return 1. `log` needs `SUPLOG` — always set at runtime; tests set it.

2b. **`should_reexec <disabled> <session_ran> <home> <boot_sha>`** — the
   testable boundary decision (CP1: cover the loop-boundary invariant at the
   established function seam). Returns 0 (and prints the new sha, delegating
   to `engine_update_ready`) ONLY when: not disabled, AND `session_ran` is 0,
   AND an update is genuinely ready. The `session_ran` gate defers re-exec
   one tick after a loop session so `resolve_event_wakes` consumes the
   `session.done` edge BEFORE we exec (CP1 finding: exec would drop the
   in-memory edge and suppress the event). One-iteration latency, no lost
   edge.

3. **Loop wiring** (top of `while true`, before the pause check so a paused
   supervisor still adopts new code):

   ```bash
   if new_sha="$(should_reexec "$reexec_disabled" "$session_ran" "$ENGINE_HOME" "$ENGINE_BOOT_SHA")"; then
     log "re-exec onto $new_sha (was $ENGINE_BOOT_SHA) -- adopting new engine code"
     reexec_engine "$ENGINE_HOME" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"} || reexec_disabled=1
   fi
   ```

   - `ENGINE_BOOT_SHA` captured once at startup, explicitly next to the
     `write_engine_boot_sha` call (CP1: make the capture a named step):
     `ENGINE_BOOT_SHA="$(git -C "$ENGINE_HOME" rev-parse HEAD 2>/dev/null || echo)"`.
     Empty (unreadable) → gate never fires (`engine_update_ready` requires a
     non-empty boot sha) — gates closed, fail-safe.
   - Relaunch args are REBUILT from resolved values (`REEXEC_ARGS`), not the
     raw argv (Codex CP2 finding): the loop cd's around (preflight), so an
     originally-relative `--repo` would resolve wrong at exec time and the
     fresh image would exit with no process left. `--repo` uses the
     absolutized `$AUTONOMY_TARGET_REPO`; empty overrides mean "not passed"
     (the resolve_config_value contract) and are dropped, reconstructing the
     original semantics exactly. Indexed arrays + `+=` are bash-3.2-fine.
   - `reexec_disabled=1` after ONE failed exec — never loop-exec, never spam;
     the old code keeps running and the dashboard's update chip still shows.
   - Pause interplay (documented, accepted): a pause set in the same tick a
     loop session ended holds `session_ran=1` (the pause `continue` skips the
     consumer), so re-exec defers until resume. Rare, self-healing, and the
     safe direction.

4. **Lock continuity fix.** After a successful exec the SAME PID re-runs the
   startup: `mkdir "$LOCK"` fails, it reads its own pid from `$LOCK/pid`, and
   today's code would say "supervisor already running (pid <self>); exiting."
   — the re-exec would kill the fleet. Extract the inline lock block into
   `acquire_supervisor_lock <lock>` (returns 0 = acquired/kept, 1 = caller
   exits 0 — behaviour byte-identical for the existing cases) and add the
   identity case FIRST: pid from the lockfile == `$$` → our own lock carried
   across a self-re-exec → keep it and proceed (no rm/mkdir window, so no
   race). Prevention-log #10 satisfied: pid == $$ IS proof of identity.
   Extraction is what makes the test genuine (source + call the real
   function) instead of a copy of the logic. While extracting, validate the
   pidfile content is all-decimal BEFORE the identity/liveness checks (CP1:
   today a corrupt pidfile like `-1` or garbage reaches `kill -0`); malformed
   → treat as stale (rm + re-mkdir), same as a dead pid.

5. **EXIT-trap interaction** (no code change, must stay true): a successful
   `exec` does NOT fire the EXIT trap, so the lock survives and no false
   "stopped" heartbeat is written. A failed exec with execfail set also fires
   no trap — the shell just continues.

## Banner

With re-exec shipped, the #240 wording ("refresh at next session boundary")
becomes TRUE — no dashboard change. Conscious tradeoff: in the
exec-failed-once state the banner over-promises again; the WARN log line is
the honest record. Documented in the PR, not worth a new heartbeat phase.

## Tests (tests/test_supervisor_reexec.sh, engine-sha test pattern)

Sources the real `bin/supervisor.sh`; real temp git repos; no mocks.

- `engine_update_ready`: sha-differs + clean → rc 0 + prints new HEAD ·
  same sha → rc 1 · dirty tree → rc 1 · git-less home → rc 1 · missing args
  → rc 1 · empty boot sha → rc 1.
- `should_reexec`: disabled=1 + ready → rc 1 · session_ran=1 + ready → rc 1
  (the session.done edge gate) · disabled=0 + session_ran=0 + ready → rc 0 +
  prints sha · not-ready passthrough → rc 1.
- `reexec_engine` success: run in a subshell against a fake `<home>` whose
  `bin/supervisor.sh` writes a marker file with `$1 $2` and exits 7 — the
  subshell must become the fake script (marker written with the forwarded
  args, subshell exit status 7, and the `echo alive` after the call must NOT
  run — proving it really exec'd).
- `reexec_engine` failure: subshell against a home with NO
  `bin/supervisor.sh` — call returns 1, subshell still alive (prints a
  post-call marker), one WARN line logged.
- Lock continuity (`acquire_supervisor_lock`): lock dir exists with
  `$LOCK/pid` == the test shell's `$$` → rc 0, lock kept (the re-exec case) ·
  pid == a live OTHER pid → rc 1 (refuses) · dead pid → rc 0, lock re-taken ·
  malformed pid (`-1`, garbage) → rc 0, treated stale, lock re-taken · no
  contention → rc 0, pid file written.
- Tests set `SUPLOG` (and a temp `LOGDIR`) before exercising `log`-calling
  paths — `set -u` trips otherwise.

## Not in scope

- No dashboard changes (banner already worded for this behaviour).
- No launchd/plist changes — same pid, launchd job unchanged.
- Live fleet remediation (tonight's manual pause/kickstart) is operator-side.
