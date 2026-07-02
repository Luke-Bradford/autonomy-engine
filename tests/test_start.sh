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
