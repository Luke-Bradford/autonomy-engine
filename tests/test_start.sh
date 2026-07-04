#!/usr/bin/env bash
# tests/test_start.sh -- the single root entrypoint (issue #45).
# ./start detects whether this machine needs setup (nothing registered ->
# guidance, optionally chaining quickstart on a given target) or can just
# run the app (state summary + the control-room dashboard). --no-launch
# prints the dashboard command instead of binding; nothing here ever runs
# launchctl (loop go-live stays with control.sh).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_HOME="$(cd "$HERE/.." && pwd)"

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

tmp="$(mktemp -d)"
tmp="$(cd "$tmp" && pwd -P)"
trap 'rm -rf "$tmp"' EXIT

export HOME="$tmp/home"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.config/autonomy"

# Write the shared repos registry, (re)creating its parent dir first. Content is
# passed as a single verbatim arg (use $'...' for the newlines/blanks) so the
# blank-line/whitespace fixtures survive exactly and no pipeline masks the write's
# exit status. Why the mkdir: on CI (Linux, under load) this test's scratch
# $HOME/.config/autonomy dir has intermittently vanished mid-suite, failing the
# next `>` redirect with "No such file or directory" (#121). ./start only ever
# *reads* this dir (its writers -- control.sh/quickstart -- mkdir -p themselves),
# so the loss is external to the product; making the test's own writes self-heal
# is the right layer.
write_repos() { mkdir -p "$HOME/.config/autonomy"; printf '%s' "$1" > "$HOME/.config/autonomy/repos"; }

# launchctl + gh shims: launchctl must NEVER fire; gh keeps any doctor call offline
shim="$tmp/shim"
mkdir -p "$shim"
export SHIM_LOG="$tmp/launchctl.log"
cat > "$shim/launchctl" <<'SH'
#!/bin/sh
echo "launchctl $*" >> "$SHIM_LOG"
exit 0
SH
cat > "$shim/gh" <<'SH'
#!/bin/sh
exit 1
SH
chmod +x "$shim/launchctl" "$shim/gh"
export PATH="$shim:$PATH"

# --- sourcing: functions only, opts untouched ----------------------------------
opts_before="$-"
# shellcheck source=/dev/null
source "$ENGINE_HOME/start"
check "sourcing leaves shell options untouched" "$opts_before" "$-"
check "sourcing defines start_mode" "0" "$(type start_mode >/dev/null 2>&1 && echo 0 || echo 1)"

# --- mode detection --------------------------------------------------------------
check "no repos file -> setup" "setup" "$(start_mode)"
write_repos ''
check "empty repos file -> setup" "setup" "$(start_mode)"
write_repos $'   \n\n'
check "whitespace-only repos file -> setup" "setup" "$(start_mode)"
write_repos "$tmp/somerepo"$'\n'
check "registered repo -> app" "app" "$(start_mode)"
rm -f "$HOME/.config/autonomy/repos"

# regression (#121): write_repos re-creates a vanished parent dir instead of
# failing the redirect, so a transient CI scratch-HOME dir loss can't flake the
# suite. Content is still written verbatim.
rm -rf "$HOME/.config/autonomy"
write_repos "/re/created"$'\n'
check "write_repos recreates a removed parent dir" "0" "$([ -f "$HOME/.config/autonomy/repos" ] && echo 0 || echo 1)"
check "write_repos writes content verbatim after re-create" "/re/created" "$(cat "$HOME/.config/autonomy/repos" 2>/dev/null)"
rm -f "$HOME/.config/autonomy/repos"

# --- ./start status: read-only live-health report (#81) --------------------------
check "sourcing defines start_status_report" "0" "$(type start_status_report >/dev/null 2>&1 && echo 0 || echo 1)"
check "sourcing defines dashboard_pids" "0" "$(type dashboard_pids >/dev/null 2>&1 && echo 0 || echo 1)"

# the REAL dashboard_pids escapes the checkout path so `pgrep -f` treats it
# literally, not as a regex -- a '.' or '+' in the path must not become a
# metacharacter (run before the seam is overridden below)
pgrep() { echo "PAT:$*"; }
_eh_save="$ENGINE_HOME"; ENGINE_HOME='/x/a.b+c/eng'
pat_out="$(dashboard_pids)"
ENGINE_HOME="$_eh_save"; unset -f pgrep
check "dashboard_pids regex-escapes metachars in the path" "0" "$(grep -qF 'a\.b\+c' <<<"$pat_out" && echo 0 || echo 1)"

# dashboard process line via the pgrep seam (override the function after sourcing)
dashboard_pids() { echo 4242; }
out="$(start_status_report 2>&1)"
check "status: dashboard running (pid) reported" "0" "$(grep -q 'dashboard running (pid 4242' <<<"$out" && echo 0 || echo 1)"
dashboard_pids() { :; }
out="$(start_status_report 2>&1)"
check "status: dashboard not running reported" "0" "$(grep -q 'dashboard not running' <<<"$out" && echo 0 || echo 1)"
check "status: not-running hint points at the service" "0" "$(grep -q 'background service' <<<"$out" && echo 0 || echo 1)"

# _with_timeout caps a hung command so `./start status` can't wedge on a slow
# network `gh` (macOS bash 3.2 has no timeout(1), so this is our own wrapper)
_with_timeout 5 true;  check "_with_timeout passes rc of a fast success" "0" "$?"
_with_timeout 5 false; check "_with_timeout passes rc of a fast failure" "1" "$?"
t0="$(date +%s)"
_with_timeout 1 sleep 5; rc=$?
t1="$(date +%s)"
check "_with_timeout kills a command past the deadline (non-zero)" "0" "$([ "$rc" -ne 0 ] && echo 0 || echo 1)"
check "_with_timeout returns promptly (< 4s)" "0" "$([ "$((t1 - t0))" -lt 4 ] && echo 0 || echo 1)"

# gh auth: shadow gh at the seam (the sanctioned mock for an unavoidable
# network tool) so the branch is deterministic, not PATH/hash-dependent.
# NB: grep the captured report via a HERE-STRING (`grep -q PAT <<<"$out"`), not
# `printf '%s\n' "$out" | grep -q PAT`. Under `set -o pipefail` a `grep -q` that
# matches exits before the producer finishes, SIGPIPE-ing it (rc 141), and
# pipefail makes the whole pipeline non-zero even though grep succeeded -- a
# CI-timing flake (prevention-log #7). A here-string has no producer process, so
# there is nothing to SIGPIPE: the check is deterministic.
gh() { return 1; }
out="$(start_status_report 2>&1)"
check "status: gh not authenticated reported" "0" "$(grep -q 'gh auth not authenticated' <<<"$out" && echo 0 || echo 1)"
gh() { return 0; }
out="$(start_status_report 2>&1)"
check "status: gh ok reported" "0" "$(grep -q 'gh auth ok' <<<"$out" && echo 0 || echo 1)"
unset -f gh

# repos registered vs none (same capture-then-grep discipline)
rm -f "$HOME/.config/autonomy/repos"
out="$(start_status_report 2>&1)"
check "status: no repos -> warn" "0" "$(grep -q 'no repos registered' <<<"$out" && echo 0 || echo 1)"
write_repos "$tmp/somerepo"$'\n'
out="$(start_status_report 2>&1)"
check "status: repos registered -> ok" "0" "$(grep -q 'repo(s) registered' <<<"$out" && echo 0 || echo 1)"

# --- #81: local (BYO-LLM) endpoint reachability in the health report --------------
# The report enumerates openai_compatible accounts (start_local_accounts) and
# probes each (start_endpoint_model_count). Both are seams, shadowed here the
# same way dashboard_pids/gh are, so each OK/WARN branch is deterministic.
check "sourcing defines start_local_accounts" "0" "$(type start_local_accounts >/dev/null 2>&1 && echo 0 || echo 1)"
check "sourcing defines start_endpoint_model_count" "0" "$(type start_endpoint_model_count >/dev/null 2>&1 && echo 0 || echo 1)"

# no local accounts -> the report stays silent about endpoints (no noise for
# operators who never configured BYO-LLM)
start_local_accounts() { :; }
out="$(start_status_report 2>&1)"
check "status: no local endpoint -> silent" "1" "$(grep -q 'local endpoint' <<<"$out" && echo 0 || echo 1)"

# a configured, reachable endpoint -> OK with the model count
start_local_accounts() { echo "localbot"; }
start_endpoint_model_count() { echo 3; }
out="$(start_status_report 2>&1)"
check "status: reachable local endpoint -> OK with count" "0" "$(grep -q "OK   local endpoint 'localbot' reachable (3 model(s))" <<<"$out" && echo 0 || echo 1)"

# configured but unreachable (0 models) -> WARN naming the remedy
start_endpoint_model_count() { echo 0; }
out="$(start_status_report 2>&1)"
check "status: unreachable local endpoint -> WARN" "0" "$(grep -q "WARN local endpoint 'localbot' unreachable" <<<"$out" && echo 0 || echo 1)"

# a non-integer/garbage probe result must degrade to WARN, never crash the report
start_endpoint_model_count() { echo "nope"; }
out="$(start_status_report 2>&1)"; rc=$?
check "status: garbage probe -> WARN (no crash)" "0" "$(grep -q "WARN local endpoint 'localbot'" <<<"$out" && echo 0 || echo 1)"
check "status: report still succeeds on garbage probe" "0" "$rc"

# --- #81: loop-worktree cleanliness in the health report -------------------------
# A stopped/paused loop that left uncommitted changes is a real "half-done
# session" signal (the loop is meant to leave a clean tree between iterations);
# a *running* loop is legitimately dirty mid-session, so it must stay silent.
# All three are seams, shadowed like the endpoint probes above so every branch
# is deterministic without real git repos or supervisor processes.
check "sourcing defines start_registered_repos" "0" "$(type start_registered_repos >/dev/null 2>&1 && echo 0 || echo 1)"
check "sourcing defines start_worktree_status" "0" "$(type start_worktree_status >/dev/null 2>&1 && echo 0 || echo 1)"
check "sourcing defines start_loop_running" "0" "$(type start_loop_running >/dev/null 2>&1 && echo 0 || echo 1)"
check "sourcing defines start_pid_command" "0" "$(type start_pid_command >/dev/null 2>&1 && echo 0 || echo 1)"

# keep the endpoint block silent so only the cleanliness lines are under test
start_local_accounts() { :; }
start_registered_repos() { echo "/fake/wt"; }

# dirty + loop NOT running -> WARN naming the worktree and the inspect command
start_worktree_status() { echo dirty; }
start_loop_running() { return 1; }
out="$(start_status_report 2>&1)"
check "status: dirty stopped worktree -> WARN" "0" "$(grep -q "WARN loop worktree '/fake/wt' has uncommitted changes" <<<"$out" && echo 0 || echo 1)"
check "status: dirty worktree WARN shows the inspect command" "0" "$(grep -q "git -C /fake/wt status" <<<"$out" && echo 0 || echo 1)"

# dirty + loop RUNNING -> silent (mid-session dirt is expected, not a warning),
# and the healthy aggregate stands in (nothing was flagged)
start_loop_running() { return 0; }
out="$(start_status_report 2>&1)"
check "status: dirty RUNNING worktree -> no warn (mid-session)" "1" "$(grep -q 'uncommitted changes' <<<"$out" && echo 0 || echo 1)"
check "status: no flagged worktree -> aggregate healthy OK" "0" "$(grep -q 'loop worktree(s) healthy' <<<"$out" && echo 0 || echo 1)"

# unknown (uninspectable) -> WARN, never counted as clean (fail-safe #1); even
# a RUNNING loop can't excuse an uninspectable worktree
start_worktree_status() { echo unknown; }
start_loop_running() { return 0; }
out="$(start_status_report 2>&1)"
check "status: uninspectable worktree -> WARN (fail-safe)" "0" "$(grep -q "WARN loop worktree '/fake/wt' could not be inspected" <<<"$out" && echo 0 || echo 1)"
check "status: uninspectable worktree suppresses the healthy aggregate" "1" "$(grep -q 'loop worktree(s) healthy' <<<"$out" && echo 0 || echo 1)"

# clean + not running -> the positive aggregate OK, no per-repo warn
start_worktree_status() { echo clean; }
start_loop_running() { return 1; }
out="$(start_status_report 2>&1)"
check "status: clean worktree -> no warn" "1" "$(grep -q 'uncommitted changes\|could not be inspected' <<<"$out" && echo 0 || echo 1)"
check "status: clean worktree -> aggregate healthy OK" "0" "$(grep -q 'loop worktree(s) healthy' <<<"$out" && echo 0 || echo 1)"

# no registered repos -> no cleanliness line at all (nothing to check, no noise)
start_registered_repos() { :; }
out="$(start_status_report 2>&1)"
check "status: no repos -> no worktree cleanliness line" "1" "$(grep -q 'loop worktree' <<<"$out" && echo 0 || echo 1)"

# --- #81: per-loop running/paused/stopped state line in the health report -------
# Fold the loop lifecycle state 'bin/control.sh list' shows into the report so the
# operator needn't run a second command. start_loop_state is built on the
# identity-confirmed start_loop_running (fail-safe: an unconfirmable loop reads
# 'stopped', never a false 'running'); a supervisor idles ALIVE with the PAUSE
# sentinel present (supervisor.sh's pause loop), so confirmed-alive + sentinel ->
# paused, confirmed-alive + no sentinel -> running, otherwise stopped.
check "sourcing defines start_loop_state" "0" "$(type start_loop_state >/dev/null 2>&1 && echo 0 || echo 1)"

# REAL start_loop_state over the start_loop_running seam + a real PAUSE sentinel
# (a plain file read, no process needed): drive all three branches deterministically.
lstaterepo="$tmp/lstate"; mkdir -p "$lstaterepo/var/autonomy-logs"
start_loop_running() { return 1; }
check "start_loop_state: loop not running -> stopped" "stopped" "$(start_loop_state "$lstaterepo")"
start_loop_running() { return 0; }
check "start_loop_state: confirmed running, no sentinel -> running" "running" "$(start_loop_state "$lstaterepo")"
touch "$lstaterepo/var/autonomy-logs/autonomy-PAUSE"
check "start_loop_state: confirmed alive + PAUSE sentinel -> paused" "paused" "$(start_loop_state "$lstaterepo")"
rm -f "$lstaterepo/var/autonomy-logs/autonomy-PAUSE"

# the report emits one per-loop state line per registered repo (state via the seam)
start_registered_repos() { echo "/fake/wt"; }
start_worktree_status() { echo clean; }
start_loop_state() { echo running; }
start_loop_wedged() { printf 'ok\t'; }   # a healthy running loop -> plain OK line
out="$(start_status_report 2>&1)"
check "status: per-loop state line shows running" "0" "$(grep -q 'loop running -- /fake/wt' <<<"$out" && echo 0 || echo 1)"
start_loop_state() { echo paused; }
out="$(start_status_report 2>&1)"
check "status: per-loop state line shows paused" "0" "$(grep -q 'loop paused -- /fake/wt' <<<"$out" && echo 0 || echo 1)"
check "status: paused state line names the resume command" "0" "$(grep -q 'control.sh resume' <<<"$out" && echo 0 || echo 1)"
start_loop_state() { echo stopped; }
out="$(start_status_report 2>&1)"
check "status: per-loop state line shows stopped" "0" "$(grep -q 'loop stopped -- /fake/wt' <<<"$out" && echo 0 || echo 1)"

# no registered repos -> no per-loop state line at all (no noise)
start_registered_repos() { :; }
out="$(start_status_report 2>&1)"
check "status: no repos -> no per-loop state line" "1" "$(grep -q 'loop running --\|loop paused --\|loop stopped --' <<<"$out" && echo 0 || echo 1)"

# --- #81 / SD-32 §9: wedged-session health folded into the running-loop line ----
# A RUNNING loop is not automatically healthy: a session-running heartbeat gone
# quiet past the threshold is WEDGED, and an uninspectable liveness store is
# UNKNOWN -- both must REPLACE the bare "OK loop running", never read as healthy
# (fail-safe, never fail-open). start_loop_wedged is a seam (prints
# lib/health.py's `<state>\t<reason>`), shadowed here so the report branch is
# deterministic without real heartbeats.
check "sourcing defines start_loop_wedged" "0" "$(type start_loop_wedged >/dev/null 2>&1 && echo 0 || echo 1)"
start_registered_repos() { echo "/fake/wt"; }
start_worktree_status() { echo clean; }
start_loop_state() { echo running; }

# ok -> plain OK, no wedged warn
start_loop_wedged() { printf 'ok\tworking session, last write 5s ago'; }
out="$(start_status_report 2>&1)"
check "status: running + ok -> OK loop running" "0" "$(grep -q 'OK   loop running -- /fake/wt' <<<"$out" && echo 0 || echo 1)"
check "status: running + ok -> no WEDGED warn" "1" "$(grep -q 'WEDGED' <<<"$out" && echo 0 || echo 1)"

# idle (a legitimately sleeping loop) -> still a plain OK, never wedged
start_loop_wedged() { printf 'idle\tnot a working session'; }
out="$(start_status_report 2>&1)"
check "status: running + idle -> OK loop running (no false wedged)" "0" "$(grep -q 'OK   loop running -- /fake/wt' <<<"$out" && echo 0 || echo 1)"

# wedged -> WARN that REPLACES the OK line and carries the reason + inspect hint
start_loop_wedged() { printf 'wedged\tworking session with no liveness write in 2000s (threshold 900s)'; }
out="$(start_status_report 2>&1)"
check "status: wedged -> WARN appears" "0" "$(grep -q 'WARN loop appears WEDGED -- /fake/wt' <<<"$out" && echo 0 || echo 1)"
check "status: wedged WARN carries the health reason" "0" "$(grep -q 'no liveness write in 2000s' <<<"$out" && echo 0 || echo 1)"
check "status: wedged WARN names the logs to inspect" "0" "$(grep -q '/fake/wt/var/autonomy-logs' <<<"$out" && echo 0 || echo 1)"
check "status: wedged REPLACES the bare OK line (never both)" "1" "$(grep -q 'OK   loop running -- /fake/wt' <<<"$out" && echo 0 || echo 1)"

# unknown (uninspectable liveness) -> WARN, never a silent OK (fail-safe)
start_loop_wedged() { printf 'unknown\tno readable heartbeat'; }
out="$(start_status_report 2>&1)"
check "status: unknown -> WARN uninspectable liveness" "0" "$(grep -q 'WARN loop running but its liveness is uninspectable -- /fake/wt' <<<"$out" && echo 0 || echo 1)"
check "status: unknown REPLACES the bare OK line" "1" "$(grep -q 'OK   loop running -- /fake/wt' <<<"$out" && echo 0 || echo 1)"

# blank (the probe itself failed/timed out / no python3) -> WARN uninspectable,
# NEVER a silent OK: absence of a positive health verdict must not read healthy
# (fail-safe, never fail-open -- Codex CP2). A fallback reason is supplied.
start_loop_wedged() { :; }
out="$(start_status_report 2>&1)"
check "status: blank probe -> WARN uninspectable (not a silent OK)" "0" "$(grep -q 'WARN loop running but its liveness is uninspectable -- /fake/wt' <<<"$out" && echo 0 || echo 1)"
check "status: blank probe -> no bare OK loop running" "1" "$(grep -q 'OK   loop running -- /fake/wt' <<<"$out" && echo 0 || echo 1)"
check "status: blank probe WARN supplies a fallback reason" "0" "$(grep -q 'health probe unavailable' <<<"$out" && echo 0 || echo 1)"

# a garbage/unrecognised state also falls through to the uninspectable WARN
start_loop_wedged() { printf 'weird-state\tmystery'; }
out="$(start_status_report 2>&1)"
check "status: unrecognised state -> WARN uninspectable (fail-safe default)" "0" "$(grep -q 'WARN loop running but its liveness is uninspectable -- /fake/wt' <<<"$out" && echo 0 || echo 1)"

# quiet the registry so the block below re-sources clean
start_registered_repos() { :; }

# restore the REAL seam functions (re-sourcing is guarded: it only re-defines,
# never executes) so the checks below exercise the genuine implementations
# shellcheck source=/dev/null
source "$ENGINE_HOME/start"

# REAL enumerator: only openai_compatible accounts are listed. Uses the real
# accounts.py against the sandboxed HOME index (a local file read -- no network).
python3 "$ENGINE_HOME/lib/accounts.py" set local-test openai_compatible http://127.0.0.1:1/v1 >/dev/null 2>&1
python3 "$ENGINE_HOME/lib/accounts.py" set subx claude_subscription >/dev/null 2>&1
accts_out="$(start_local_accounts)"
check "real start_local_accounts lists the openai_compatible account" "0" "$(grep -qx 'local-test' <<<"$accts_out" && echo 0 || echo 1)"
check "real start_local_accounts omits non-endpoint accounts" "1" "$(grep -qx 'subx' <<<"$accts_out" && echo 0 || echo 1)"

# REAL prober against a dead port (127.0.0.1:1) -> 0 (unreachable). Genuinely
# offline: list_models returns [] on the connection error.
cnt_out="$(start_endpoint_model_count local-test)"
check "real start_endpoint_model_count on a dead endpoint -> 0" "0" "$cnt_out"

# clean up so the integration `start status` below sees no local accounts
python3 "$ENGINE_HOME/lib/accounts.py" delete local-test >/dev/null 2>&1
python3 "$ENGINE_HOME/lib/accounts.py" delete subx >/dev/null 2>&1

# REAL start_worktree_status against genuine git worktrees (no seam, no network):
# a tree with an untracked/modified file reads `dirty`; a committed-clean tree
# reads `clean`; a non-git directory and a missing path read `unknown` (never
# silently "clean" -- fail-safe #1).
gitclean="$tmp/wt-clean"; gitdirty="$tmp/wt-dirty"; notgit="$tmp/wt-nogit"
mkdir -p "$gitclean" "$gitdirty" "$notgit"
( cd "$gitclean" && git init -q && git -c user.email=a@b.c -c user.name=t commit -q --allow-empty -m init )
( cd "$gitdirty" && git init -q && git -c user.email=a@b.c -c user.name=t commit -q --allow-empty -m init && echo x > f )
check "real start_worktree_status: dirty tree -> dirty" "dirty" "$(start_worktree_status "$gitdirty")"
check "real start_worktree_status: clean tree -> clean" "clean" "$(start_worktree_status "$gitclean")"
check "real start_worktree_status: non-git dir -> unknown" "unknown" "$(start_worktree_status "$notgit")"
check "real start_worktree_status: missing dir -> unknown" "unknown" "$(start_worktree_status "$tmp/nope")"

# REAL start_loop_running: reads the supervisor lock pid, requires the pid to be
# BOTH alive AND confirmed as this repo's supervisor (argv carries supervisor.sh
# + the repo path). A live-but-reused pid on an unrelated process must read
# not-running so the dirty WARN still fires (fail-safe #1). The argv lookup is
# shadowed via the start_pid_command seam so the confirmation is testable with a
# real live pid ($$) but a controlled command line.
mkdir -p "$gitdirty/var/autonomy-supervisor.lock"
printf '%s' "$$" > "$gitdirty/var/autonomy-supervisor.lock/pid"
start_pid_command() { echo "/bin/bash $ENGINE_HOME/bin/supervisor.sh --repo $gitdirty"; }
start_loop_running "$gitdirty"; check "real start_loop_running: live confirmed supervisor -> rc 0" "0" "$?"
start_pid_command() { echo "/bin/bash $ENGINE_HOME/bin/supervisor.sh --repo $gitdirty --once"; }
start_loop_running "$gitdirty"; check "real start_loop_running: supervisor with repo + trailing args -> rc 0" "0" "$?"
start_pid_command() { echo "/usr/bin/vim /some/file"; }
start_loop_running "$gitdirty"; check "real start_loop_running: live but non-supervisor pid -> rc 1 (fail-safe)" "1" "$?"
start_pid_command() { echo "/bin/bash $ENGINE_HOME/bin/supervisor.sh --repo /a/different/repo"; }
start_loop_running "$gitdirty"; check "real start_loop_running: supervisor for another repo -> rc 1" "1" "$?"
# an EDITOR whose argv merely contains the supervisor.sh path + the repo path,
# but no `--repo <repo>` launch sequence, must not read running (loose-substring
# false-match Codex flagged)
start_pid_command() { echo "/usr/bin/vim $gitdirty/bin/supervisor.sh"; }
start_loop_running "$gitdirty"; check "real start_loop_running: editor of supervisor.sh -> rc 1 (fail-safe)" "1" "$?"
# a supervisor for a repo whose path is a SUPERSTRING of this one (repo vs repo2)
# must not false-match this repo
start_pid_command() { echo "/bin/bash $ENGINE_HOME/bin/supervisor.sh --repo ${gitdirty}2"; }
start_loop_running "$gitdirty"; check "real start_loop_running: superstring repo path -> rc 1 (fail-safe)" "1" "$?"
# dead pid, non-numeric pid, and a missing lock all short-circuit before the
# argv confirmation, so they read not-running regardless of the seam.
printf '%s' "999999" > "$gitdirty/var/autonomy-supervisor.lock/pid"
start_loop_running "$gitdirty"; check "real start_loop_running: dead pid -> rc 1" "1" "$?"
printf 'garbage' > "$gitdirty/var/autonomy-supervisor.lock/pid"
start_loop_running "$gitdirty"; check "real start_loop_running: non-numeric pid -> rc 1" "1" "$?"
start_loop_running "$gitclean"; check "real start_loop_running: no lock -> rc 1" "1" "$?"
# restore the real seams (the start_pid_command shadow above must be gone before
# the real start_pid_command checks below); guarded re-source only re-defines.
# shellcheck source=/dev/null
source "$ENGINE_HOME/start"
# REAL start_pid_command: the current process ($$) is live, so its argv is
# non-empty; a definitely-dead pid yields empty.
check "real start_pid_command: live pid -> non-empty argv" "0" "$([ -n "$(start_pid_command "$$")" ] && echo 0 || echo 1)"
check "real start_pid_command: dead pid -> empty" "0" "$([ -z "$(start_pid_command 999999)" ] && echo 0 || echo 1)"

# REAL start_registered_repos: one path per line, blank-tolerant, empty when the
# registry is absent (the same registry ./start and control.sh share).
write_repos "$gitclean"$'\n\n'"$gitdirty"$'\n'
repos_out="$(start_registered_repos)"
check "real start_registered_repos lists registered paths" "0" "$(grep -qx "$gitclean" <<<"$repos_out" && echo 0 || echo 1)"
check "real start_registered_repos drops blank lines (2 non-blank)" "2" "$(grep -c . <<<"$repos_out")"
rm -f "$HOME/.config/autonomy/repos"

# fail-safe (#1): a registry that EXISTS but is unreadable must WARN, never
# silently skip worktree health, and the report still exits 0. (An unreadable
# registry yields empty from start_registered_repos just like an absent one, so
# the report disambiguates via a readability check.)
write_repos "$gitclean"$'\n'; chmod 000 "$HOME/.config/autonomy/repos"
out="$(start_status_report 2>&1)"; rc=$?
chmod 644 "$HOME/.config/autonomy/repos"
check "status: unreadable registry -> WARN (fail-safe)" "0" "$(grep -q 'registry .* unreadable' <<<"$out" && echo 0 || echo 1)"
check "status: unreadable registry report still exits 0" "0" "$rc"
rm -f "$HOME/.config/autonomy/repos"

# integration: the status subcommand is read-only -- exit 0, never binds/launchctl
rm -f "$SHIM_LOG"
out="$(bash "$ENGINE_HOME/start" status </dev/null 2>&1)"; rc=$?
check "start status exits 0" "0" "$rc"
check "start status prints the health header" "0" "$(grep -q '== autonomy engine health ==' <<<"$out" && echo 0 || echo 1)"
check "start status never reaches the dashboard launch" "1" "$(grep -q 'launching the dashboard' <<<"$out" && echo 0 || echo 1)"
check "start status runs no launchctl" "0" "$([ ! -e "$SHIM_LOG" ] && echo 0 || echo 1)"

# status takes no further args (explicit rejection, not silent-ignore)
bash "$ENGINE_HOME/start" status extra </dev/null >/dev/null 2>&1; rc=$?
check "start status rejects extra args (rc 2)" "2" "$rc"

# edge: status works in setup mode (no repos) and survives an unreadable repos file
rm -f "$HOME/.config/autonomy/repos"
bash "$ENGINE_HOME/start" status </dev/null >/dev/null 2>&1; rc=$?
check "start status in setup mode exits 0" "0" "$rc"
write_repos "$tmp/r"$'\n'; chmod 000 "$HOME/.config/autonomy/repos"
bash "$ENGINE_HOME/start" status </dev/null >/dev/null 2>&1; rc=$?
chmod 644 "$HOME/.config/autonomy/repos"
check "start status on unreadable repos file still exits 0" "0" "$rc"
rm -f "$HOME/.config/autonomy/repos"

# --- setup mode: guidance, no bind, no launchctl ---------------------------------
bash "$ENGINE_HOME/start" </dev/null >"$tmp/out1" 2>&1
rc=$?
check "bare start in setup mode exits 0" "0" "$rc"
check "setup guidance mentions quickstart" "0" "$(grep -q 'quickstart' "$tmp/out1" && echo 0 || echo 1)"
check "setup guidance shows the ./start <repo> form" "0" "$(grep -q 'start /path/to' "$tmp/out1" && echo 0 || echo 1)"
check "launchctl never invoked" "0" "$([ ! -e "$SHIM_LOG" ] && echo 0 || echo 1)"

# --- setup mode with a target: chains quickstart, registers, reaches app mode ----
mkdir -p "$tmp/proj"
bash "$ENGINE_HOME/start" "$tmp/proj" --no-launch \
  </dev/null >"$tmp/out2" 2>&1
rc=$?
check "start <target> exits 0" "0" "$rc"
check "target got the pack scaffolded" "0" "$([ -f "$tmp/proj/.autonomy/config.yaml" ] && echo 0 || echo 1)"
check "target was registered for the dashboard" "1" "$(grep -cxF "$tmp/proj" "$HOME/.config/autonomy/repos" 2>/dev/null)"
check "after setup it reaches app mode (dashboard command printed)" "0" "$(grep -q 'dashboard.py' "$tmp/out2" && echo 0 || echo 1)"
check "still no launchctl" "0" "$([ ! -e "$SHIM_LOG" ] && echo 0 || echo 1)"

# --- app mode: state summary + printed dashboard command (--no-launch) ------------
bash "$ENGINE_HOME/start" --no-launch </dev/null >"$tmp/out3" 2>&1
rc=$?
check "app mode --no-launch exits 0" "0" "$rc"
check "state summary lists the registered repo" "0" "$(grep -q "$tmp/proj" "$tmp/out3" && echo 0 || echo 1)"
check "dashboard command printed, not run" "0" "$(grep -q 'dashboard.py' "$tmp/out3" && echo 0 || echo 1)"

bash "$ENGINE_HOME/start" --no-launch --port 9999 </dev/null >"$tmp/out4" 2>&1
check "--port propagates into the printed command" "0" "$(grep -q -- '--port 9999' "$tmp/out4" && echo 0 || echo 1)"

# --- chained quickstart failure -> non-zero exit, no dashboard exec ----------------
# (PR #46 review WARNING: exit must stay truthful)
mkdir -p "$tmp/badproj"
chmod 555 "$tmp/badproj"          # onboard cannot scaffold -> quickstart fails
bash "$ENGINE_HOME/start" "$tmp/badproj" --no-launch </dev/null >"$tmp/out5" 2>&1
rc=$?
chmod 755 "$tmp/badproj"
check "failed chained setup -> non-zero exit" "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"
check "failed chained setup still explains itself" "0" "$(grep -qi 'quickstart reported problems' "$tmp/out5" && echo 0 || echo 1)"

# --- usage ------------------------------------------------------------------------
bash "$ENGINE_HOME/start" --frobnicate </dev/null >/dev/null 2>&1
check "unknown flag -> non-zero exit" "1" "$([ $? -ne 0 ] && echo 1 || echo 0)"

# --- every operator-facing entry point is directly executable ----------------------
# (quickstart.sh shipped 644 and './start proj' died on Permission denied --
# nothing had ever exec'd it before; bin/agents/*.sh are source-only by design)
for f in "$ENGINE_HOME/start" "$ENGINE_HOME"/bin/*.sh "$ENGINE_HOME/bin/dashboard.py"; do
  check "executable: ${f#"$ENGINE_HOME"/}" "0" "$([ -x "$f" ] && echo 0 || echo 1)"
done

# dashboard-as-a-service (#81): the plist render is the pure, testable core;
# launchctl load/stop are boundary seams (not exercised here).
plist="$(render_dashboard_plist 9099)"
check "plist: dashboard service label present" "0" "$(grep -q 'com.autonomy.dashboard' <<<"$plist" && echo 0 || echo 1)"
check "plist: port substituted" "0" "$(grep -q '<string>9099</string>' <<<"$plist" && echo 0 || echo 1)"
check "plist: engine-home dashboard.py path substituted" "0" "$(grep -qF "$ENGINE_HOME/bin/dashboard.py" <<<"$plist" && echo 0 || echo 1)"
check "plist: python path is absolute" "0" "$(grep -qE '<string>/[^<]*python3?</string>' <<<"$plist" && echo 0 || echo 1)"
check "plist: no unsubstituted __PLACEHOLDER__ left" "0" "$(grep -q '__[A-Z_]*__' <<<"$plist" && echo 1 || echo 0)"
check "usage mentions stop + foreground" "0" "$(start_usage 2>&1 | grep -q 'stop' && start_usage 2>&1 | grep -q 'foreground' && echo 0 || echo 1)"

# REAL start_loop_wedged over the REAL lib/health.py on a temp logdir (genuine
# I/O, no mocks -- the seams are the real ones after the re-source above). A
# session-running heartbeat whose newest write is far in the past -> wedged; the
# same stale write under an idle phase -> never wedged (no false positive).
wrepo="$tmp/wedged-repo"; mkdir -p "$wrepo/var/autonomy-logs"
printf '1000\tsession-running coder\t0\trunning\n' > "$wrepo/var/autonomy-logs/heartbeat"
: > "$wrepo/var/autonomy-logs/session-20260101T000000.log"
touch -t 202601010000 "$wrepo/var/autonomy-logs/session-20260101T000000.log"
real_wedged="$(start_loop_wedged "$wrepo")"
check "real start_loop_wedged: session-running + stale write -> wedged" "0" "$(printf '%s' "$real_wedged" | grep -q '^wedged' && echo 0 || echo 1)"
printf '1000\tboard-empty\t0\tidle\n' > "$wrepo/var/autonomy-logs/heartbeat"
real_idle="$(start_loop_wedged "$wrepo")"
check "real start_loop_wedged: idle phase + stale write -> not wedged" "0" "$(printf '%s' "$real_idle" | grep -q '^idle' && echo 0 || echo 1)"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
