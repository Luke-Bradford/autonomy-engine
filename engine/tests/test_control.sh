#!/usr/bin/env bash
# tests/test_control.sh -- multi-repo registry / control unit (issue #4).
# control.sh drives launch/stop/pause/resume across every registered repo.
# Registry = ~/.config/autonomy/repos (the SAME file dashboard.py discovers
# from and quickstart.sh registers into). Label<->path mapping comes from the
# installed launchd plists themselves (what setup_worktree.sh wrote), never
# re-derived by guessing. launchctl is PATH-shimmed: start/stop must invoke
# it with exact args; nothing else may.
# shellcheck disable=SC2034  # vars consumed by sourced functions
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_HOME="$(cd "$HERE/.." && pwd)"

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

tmp="$(mktemp -d)"
tmp="$(cd "$tmp" && pwd -P)"
cleanup() {
  if [ -n "${live_pid:-}" ]; then
    kill "$live_pid" 2>/dev/null
    wait "$live_pid" 2>/dev/null   # reap quietly -- no 'Terminated' noise
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

export HOME="$tmp/home"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.config/autonomy"

shim="$tmp/shim"
mkdir -p "$shim"
export SHIM_LOG="$tmp/launchctl.log"
cat > "$shim/launchctl" <<'SH'
#!/bin/sh
echo "launchctl $*" >> "$SHIM_LOG"
exit 0
SH
chmod +x "$shim/launchctl"
export PATH="$shim:$PATH"

mkplist() { # $1 slug, $2 workdir -> installs a fixture plist
  sed -e "s#__ENGINE_HOME__#$ENGINE_HOME#g" -e "s#__REPO__#$2#g" -e "s#__LABEL__#$1#g" \
    "$ENGINE_HOME/templates/supervisor.plist.tmpl" \
    > "$HOME/Library/LaunchAgents/com.autonomy.$1.supervisor.plist"
}

repoA="$tmp/repoA"; repoB="$tmp/repoB"; repoC="$tmp/repoC"
mkdir -p "$repoA" "$repoB" "$repoC"
mkplist repoa "$repoA"
mkplist repoc "$repoC"        # installed but never registered (orphan)
REG="$HOME/.config/autonomy/repos"

# --- sourcing: qs_* discipline holds here too ---------------------------------
opts_before="$-"
# shellcheck source=/dev/null
source "$ENGINE_HOME/bin/control.sh"
check "sourcing leaves shell options untouched" "$opts_before" "$-"
check "sourcing defines ctl_loop_state" "0" "$(type ctl_loop_state >/dev/null 2>&1 && echo 0 || echo 1)"

# --- registry: register / dedup / unregister ----------------------------------
bash "$ENGINE_HOME/bin/control.sh" register "$repoA" >/dev/null 2>&1
bash "$ENGINE_HOME/bin/control.sh" register "$repoB" >/dev/null 2>&1
bash "$ENGINE_HOME/bin/control.sh" register "$repoA" >/dev/null 2>&1
check "register is append-if-missing (A once)" "1" "$(grep -cxF "$repoA" "$REG")"
check "register keeps both repos" "1" "$(grep -cxF "$repoB" "$REG")"
bash "$ENGINE_HOME/bin/control.sh" unregister "$repoB" >/dev/null 2>&1
check "unregister removes the line" "0" "$(grep -cxF "$repoB" "$REG")"
check "unregister keeps other entries" "1" "$(grep -cxF "$repoA" "$REG")"
bash "$ENGINE_HOME/bin/control.sh" unregister "$repoB" >/dev/null 2>&1
check "unregister of a non-entry exits non-zero" "1" "$([ $? -ne 0 ] && echo 1 || echo 0)"
bash "$ENGINE_HOME/bin/control.sh" register "$repoB" >/dev/null 2>&1

# PR #41 review (NITPICK): the rewrite-via-tmpfile must not change the
# registry's permissions
chmod 600 "$REG"
bash "$ENGINE_HOME/bin/control.sh" register "$tmp/repoC" >/dev/null 2>&1
bash "$ENGINE_HOME/bin/control.sh" unregister "$tmp/repoC" >/dev/null 2>&1
check "unregister preserves the registry's mode" "0o600" "$(python3 -c 'import os,stat,sys;print(oct(stat.S_IMODE(os.stat(sys.argv[1]).st_mode)))' "$REG")"
chmod 644 "$REG"

# --- plist mapping (ground truth: installed plists) ----------------------------
check "find_plist maps repo -> its plist" "$HOME/Library/LaunchAgents/com.autonomy.repoa.supervisor.plist" "$(ctl_find_plist "$repoA")"
check "find_plist empty when none installed" "" "$(ctl_find_plist "$repoB")"
check "plist label extracted" "com.autonomy.repoa.supervisor" "$(ctl_plist_label "$(ctl_find_plist "$repoA")")"

# --- lanes (#147 Part 2): two lanes of ONE repo -> two distinct plists ---------
# control keys purely on WorkingDirectory + Label, so per-lane worktrees make it
# lane-safe with NO code change: the default lane keeps the legacy label, the
# non-default lane gets <slug>.<lane>, and each worktree resolves to its own plist.
wtMain="$tmp/wt-lanerepo"; wtFe="$tmp/wt-lanerepo-fe"
mkdir -p "$wtMain" "$wtFe"
mkplist lanerepo "$wtMain"       # default lane, legacy label
mkplist lanerepo.fe "$wtFe"      # non-default lane, com.autonomy.lanerepo.fe.supervisor
check "lane: default-lane worktree -> legacy plist" \
  "$HOME/Library/LaunchAgents/com.autonomy.lanerepo.supervisor.plist" "$(ctl_find_plist "$wtMain")"
check "lane: non-default worktree -> per-lane plist" \
  "$HOME/Library/LaunchAgents/com.autonomy.lanerepo.fe.supervisor.plist" "$(ctl_find_plist "$wtFe")"
check "lane: per-lane label extracted" \
  "com.autonomy.lanerepo.fe.supervisor" "$(ctl_plist_label "$(ctl_find_plist "$wtFe")")"

# --- loop state: lock pid + pause sentinel -------------------------------------
check "no lock -> stopped" "stopped" "$(ctl_loop_state "$repoA")"
mkdir -p "$repoA/var/autonomy-supervisor.lock" "$repoA/var/autonomy-logs"
sleep 300 & live_pid=$!
echo "$live_pid" > "$repoA/var/autonomy-supervisor.lock/pid"
check "live lock pid -> running" "running" "$(ctl_loop_state "$repoA")"
touch "$repoA/var/autonomy-logs/autonomy-PAUSE"
check "live pid + sentinel -> paused" "paused" "$(ctl_loop_state "$repoA")"
rm -f "$repoA/var/autonomy-logs/autonomy-PAUSE"
echo "999999999" > "$repoA/var/autonomy-supervisor.lock/pid"
check "dead lock pid -> stopped" "stopped" "$(ctl_loop_state "$repoA")"
rm -rf "$repoA/var/autonomy-supervisor.lock"

# --- start: refuses without a plist, exact launchctl args with one -------------
bash "$ENGINE_HOME/bin/control.sh" start "$repoB" >"$tmp/startB.out" 2>&1
check "start without plist exits non-zero" "1" "$([ $? -ne 0 ] && echo 1 || echo 0)"
check "start without plist points at setup" "0" "$(grep -Eq 'setup_worktree|quickstart' "$tmp/startB.out" && echo 0 || echo 1)"
check "start without plist never calls launchctl" "0" "$([ ! -e "$SHIM_LOG" ] && echo 0 || echo 1)"
bash "$ENGINE_HOME/bin/control.sh" start "$repoA" >/dev/null 2>&1
check "start exits 0 with plist" "0" "$?"
check "start bootstraps the exact plist" "launchctl bootstrap gui/$(id -u) $HOME/Library/LaunchAgents/com.autonomy.repoa.supervisor.plist" "$(tail -1 "$SHIM_LOG")"

# --- stop: bootout by label ------------------------------------------------------
bash "$ENGINE_HOME/bin/control.sh" stop "$repoA" >/dev/null 2>&1
check "stop exits 0" "0" "$?"
check "stop boots out the label" "launchctl bootout gui/$(id -u)/com.autonomy.repoa.supervisor" "$(tail -1 "$SHIM_LOG")"

# --- start --all: does what it can, reports what it can't ------------------------
: > "$SHIM_LOG"
bash "$ENGINE_HOME/bin/control.sh" start --all >"$tmp/startall.out" 2>&1
check "start --all exits non-zero when any repo lacks a plist" "1" "$([ $? -ne 0 ] && echo 1 || echo 0)"
check "start --all still bootstraps the ready repo" "1" "$(grep -c "bootstrap gui/$(id -u) $HOME/Library/LaunchAgents/com.autonomy.repoa.supervisor.plist" "$SHIM_LOG")"

# --- pause / resume: the graceful sentinel, per-repo and --all -------------------
bash "$ENGINE_HOME/bin/control.sh" pause "$repoA" >/dev/null 2>&1
check "pause creates the sentinel" "0" "$([ -f "$repoA/var/autonomy-logs/autonomy-PAUSE" ] && echo 0 || echo 1)"
bash "$ENGINE_HOME/bin/control.sh" pause --all >/dev/null 2>&1
check "pause --all reaches every registered repo" "0" "$([ -f "$repoB/var/autonomy-logs/autonomy-PAUSE" ] && echo 0 || echo 1)"
bash "$ENGINE_HOME/bin/control.sh" resume --all >/dev/null 2>&1
check "resume --all clears sentinels (A)" "0" "$([ ! -f "$repoA/var/autonomy-logs/autonomy-PAUSE" ] && echo 0 || echo 1)"
check "resume --all clears sentinels (B)" "0" "$([ ! -f "$repoB/var/autonomy-logs/autonomy-PAUSE" ] && echo 0 || echo 1)"

# --- list: registered repos with states, orphan plists surfaced ------------------
bash "$ENGINE_HOME/bin/control.sh" list >"$tmp/list.out" 2>&1
check "list exits 0" "0" "$?"
check "list shows repoA with its label" "0" "$(grep "$repoA" "$tmp/list.out" | grep -q "com.autonomy.repoa.supervisor" && echo 0 || echo 1)"
check "list marks repoB as having no plist" "0" "$(grep "$repoB" "$tmp/list.out" | grep -qi "no plist" && echo 0 || echo 1)"
check "list surfaces the orphan plist's repo" "0" "$(grep -q "$repoC" "$tmp/list.out" && echo 0 || echo 1)"
check "list shows states" "0" "$(grep "$repoA" "$tmp/list.out" | grep -q "stopped" && echo 0 || echo 1)"

# --- usage ------------------------------------------------------------------------
bash "$ENGINE_HOME/bin/control.sh" >/dev/null 2>&1
check "no args -> non-zero exit" "1" "$([ $? -ne 0 ] && echo 1 || echo 0)"
bash "$ENGINE_HOME/bin/control.sh" frobnicate >/dev/null 2>&1
check "unknown command -> non-zero exit" "1" "$([ $? -ne 0 ] && echo 1 || echo 0)"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
