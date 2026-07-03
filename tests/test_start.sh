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
touch "$HOME/.config/autonomy/repos"
check "empty repos file -> setup" "setup" "$(start_mode)"
printf '   \n\n' > "$HOME/.config/autonomy/repos"
check "whitespace-only repos file -> setup" "setup" "$(start_mode)"
printf '%s\n' "$tmp/somerepo" > "$HOME/.config/autonomy/repos"
check "registered repo -> app" "app" "$(start_mode)"
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
check "status: dashboard running (pid) reported" "0" "$(grep -q 'dashboard running (pid 4242)' <<<"$out" && echo 0 || echo 1)"
dashboard_pids() { :; }
out="$(start_status_report 2>&1)"
check "status: dashboard not running reported" "0" "$(grep -q 'dashboard not running' <<<"$out" && echo 0 || echo 1)"
check "status: hard-kill hint shown" "0" "$(grep -q 'pkill -f bin/dashboard.py' <<<"$out" && echo 0 || echo 1)"

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
printf '%s\n' "$tmp/somerepo" > "$HOME/.config/autonomy/repos"
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
printf '%s\n' "$tmp/r" > "$HOME/.config/autonomy/repos"; chmod 000 "$HOME/.config/autonomy/repos"
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

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
