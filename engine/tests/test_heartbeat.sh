#!/usr/bin/env bash
# tests/test_heartbeat.sh -- the supervisor's structured liveness heartbeat
# (#177). heartbeat() writes ONE machine-readable, tab-separated status line
# (ts, phase, until_epoch, reason) atomically under the gitignored LOGDIR, is
# the sole writer, and is best-effort (a write failure must never perturb the
# loop). Sources the real supervisor.sh and calls the real function.
# shellcheck disable=SC2034  # vars consumed inside the sourced supervisor.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_HOME="$(cd "$HERE/.." && pwd)"

# shellcheck source=/dev/null
source "$ENGINE_HOME/bin/supervisor.sh"

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

SUPLOG=/dev/null
LOGDIR="$tmp/logs"
mkdir -p "$LOGDIR"
HB="$LOGDIR/heartbeat"

# --- happy path: correct tab-separated fields ---------------------------------
heartbeat "pace-wait" "session clean -- next session soon" "1893456000"
line="$(cat "$HB")"
# Fields: <ts>\t<phase>\t<until>\t<reason>
ts="$(printf '%s' "$line" | cut -f1)"
phase="$(printf '%s' "$line" | cut -f2)"
until_e="$(printf '%s' "$line" | cut -f3)"
reason="$(printf '%s' "$line" | cut -f4)"
check "phase field written"   "pace-wait" "$phase"
check "until_epoch field written" "1893456000" "$until_e"
check "reason field (spaces preserved)" "session clean -- next session soon" "$reason"
case "$ts" in ''|*[!0-9]*) echo "FAIL - ts is not an epoch integer ('$ts')"; fails=$((fails + 1)) ;; *) echo "ok   - ts is an epoch integer" ;; esac

# --- single line only (latest wins; sole-writer overwrite) --------------------
heartbeat "board-empty" "no open issues" ""
check "file holds exactly one line" "1" "$(wc -l < "$HB" | tr -d ' ')"
check "latest phase overwrites"     "board-empty" "$(cut -f2 "$HB")"
check "empty until_epoch stays empty" "" "$(cut -f3 "$HB")"

# --- atomic: no temp file left behind -----------------------------------------
leftover="$(find "$LOGDIR" -name 'heartbeat.*.tmp' | wc -l | tr -d ' ')"
check "no temp file left behind" "0" "$leftover"

# --- best-effort: unwritable LOGDIR must not crash / must return 0 -------------
SAVED_LOGDIR="$LOGDIR"
LOGDIR="$tmp/does/not/exist"
heartbeat "cron-check" "checking scheduled roles" ""; rc=$?
check "unwritable LOGDIR returns 0 (best-effort)" "0" "$rc"
LOGDIR="$SAVED_LOGDIR"

# --- no LOGDIR set: no-op return 0 (never errors before the loop wires it) -----
UNSET_LOGDIR_RC=0
( unset LOGDIR; heartbeat "x" "y" "" ); UNSET_LOGDIR_RC=$?
check "absent LOGDIR is a no-op (rc 0)" "0" "$UNSET_LOGDIR_RC"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
