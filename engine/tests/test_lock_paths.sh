#!/usr/bin/env bash
# tests/test_lock_paths.sh -- the single source of the supervisor lock path
# convention (issue #117). bin/lock_paths.sh defines the path once; supervisor.sh
# writes it, control.sh (ctl_loop_state) and start (start_loop_running) read it.
# This pins the predicate directly; the reader behaviour is separately pinned by
# test_control.sh / test_start.sh, which exercise the real lock dir.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_HOME="$(cd "$HERE/.." && pwd)"

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

# shellcheck source=/dev/null
source "$ENGINE_HOME/bin/lock_paths.sh"

check "sourcing defines supervisor_lock_dir" "0" "$(type supervisor_lock_dir >/dev/null 2>&1 && echo 0 || echo 1)"
check "sourcing defines supervisor_lock_pid_file" "0" "$(type supervisor_lock_pid_file >/dev/null 2>&1 && echo 0 || echo 1)"

check "lock dir for a repo" "/tmp/repoA/var/autonomy-supervisor.lock" "$(supervisor_lock_dir /tmp/repoA)"
check "pid file for a repo" "/tmp/repoA/var/autonomy-supervisor.lock/pid" "$(supervisor_lock_pid_file /tmp/repoA)"

# The pid file must compose from the dir -- one convention, not two literals.
check "pid file is dir + /pid" "$(supervisor_lock_dir /x/y)/pid" "$(supervisor_lock_pid_file /x/y)"

# A path with a trailing slash or spaces is not mangled (repos are pre-resolved
# absolute paths, but the helper must not add its own assumptions).
check "path with spaces preserved" "/tmp/my repo/var/autonomy-supervisor.lock/pid" "$(supervisor_lock_pid_file "/tmp/my repo")"

# The three entrypoints must all source this file (drift-proofing, #117).
check "supervisor.sh sources lock_paths" "0" "$(grep -q 'bin/lock_paths.sh' "$ENGINE_HOME/bin/supervisor.sh" && echo 0 || echo 1)"
check "control.sh sources lock_paths" "0" "$(grep -q 'bin/lock_paths.sh' "$ENGINE_HOME/bin/control.sh" && echo 0 || echo 1)"
check "start sources lock_paths" "0" "$(grep -q 'bin/lock_paths.sh' "$ENGINE_HOME/start" && echo 0 || echo 1)"

if [ "$fails" -eq 0 ]; then echo "PASS test_lock_paths"; exit 0; else echo "FAIL test_lock_paths ($fails)"; exit 1; fi
