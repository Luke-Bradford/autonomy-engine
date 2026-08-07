#!/usr/bin/env bash
# tests/test_event_bus.sh -- event bus over TRIGGERS (Phase C cutover; W2
# lineage, issue #86). The supervisor folds a gh-poll event check into its
# loop iteration: resolve_trigger_event_wakes enumerates event triggers
# (seam _triggers_enumerate), polls current fireable tokens per event (seam
# _event_poll), routes SHIM triggers through the legacy per-role wake body
# (run_session, stubbed) and NATIVE triggers through the START-ONLY lane,
# and advances the per-(name,event) seen-set at-least-once. session.done is
# a per-tick loop-session edge. Sources the real supervisor.sh, stubs only
# run_session + the seams.
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
contains() {
  case "$2" in *"$3"*) echo "ok   - $1" ;; *) echo "FAIL - $1 (missing '$3' in '$2')"; fails=$((fails + 1)) ;; esac
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

SUPLOG=/dev/null
LOGF="$tmp/log"
log() { echo "$*" >>"$LOGF"; }

VARDIR="$tmp/var"
AUTONOMY_TARGET_REPO="$tmp/repo"   # unused while the seams are stubbed

CAPTURE="$tmp/fired"
RS_RC=0
run_session() { echo "$1" >>"$CAPTURE"; return "$RS_RC"; }

TAB="$(printf '\t')"
POLL_OUT=""
POLL_RC=0
_event_poll() { [ "$POLL_RC" -eq 0 ] || return "$POLL_RC"; printf '%s\n' "$POLL_OUT"; }

reset() { : >"$CAPTURE"; : >"$LOGF"; rm -rf "$VARDIR"; POLL_OUT=""; POLL_RC=0; RS_RC=0; }
seed_seen() { mkdir -p "$VARDIR/events"; printf '%s\n' "$2" > "$VARDIR/events/$1.seen"; }

# === Phase C (#376) Task 10: the event CUTOVER ================================
# resolve_trigger_event_wakes routes SHIM event triggers through the SAME
# _event_role_wakes body (parity 1-3: same seen files, same single
# run_session, failed session leaves seen, first-sight seeds) and NATIVE
# event triggers through the START-ONLY lane (decision 14: one run per new
# token via pipeline.py start, NEVER run_session -- the main loop advances
# the run as an ordinary in-flight token).

TRIG_ENUM_OUT=""
TRIG_ENUM_RC=0
_triggers_enumerate() {
  [ "$TRIG_ENUM_RC" -eq 0 ] || return "$TRIG_ENUM_RC"
  printf '%s' "$TRIG_ENUM_OUT"
}
LOGDIR="$VARDIR/autonomy-logs"
PYCALLS="$tmp/pycalls"
PY_RC=0
python3() { echo "$*" >>"$PYCALLS"; return "$PY_RC"; }
CAP_RC=0
trigger_start_token_for() { [ "$CAP_RC" -eq 0 ] || return 1; printf '%s' "$1"; }
reset2() { reset; : >"$PYCALLS"; TRIG_ENUM_OUT=""; TRIG_ENUM_RC=0; PY_RC=0; CAP_RC=0; }

# --- parity 1: a shim fires through the legacy body, same seen file ----------
reset2
TRIG_ENUM_OUT="qa${TAB}shim${TAB}pr.opened${TAB}skip${TAB}1"
POLL_OUT="$(printf '4\n5')"
seed_seen "qa__pr.opened" "4"
resolve_trigger_event_wakes 0
check "shim event fired qa once (parity)" "qa" "$(cat "$CAPTURE")"
contains "shim seen file advanced (byte-equal name)" \
  "$(cat "$VARDIR/events/qa__pr.opened.seen")" "5"
check "shim fired no native start" "" "$(cat "$PYCALLS")"

# --- parity 2: session.done wakes shims only when a session ran --------------
reset2
TRIG_ENUM_OUT="notify${TAB}shim${TAB}session.done${TAB}skip${TAB}1"
resolve_trigger_event_wakes 1
check "shim session.done fired when session ran" "notify" "$(cat "$CAPTURE")"
reset2
TRIG_ENUM_OUT="notify${TAB}shim${TAB}session.done${TAB}skip${TAB}1"
resolve_trigger_event_wakes 0
check "shim session.done quiet with no session" "" "$(cat "$CAPTURE")"

# --- parity 3: failed shim session leaves the seen-set (redelivery) ----------
reset2
TRIG_ENUM_OUT="qa${TAB}shim${TAB}pr.opened${TAB}skip${TAB}1"
POLL_OUT="$(printf '4\n5')"
seed_seen "qa__pr.opened" "4"
RS_RC=1
resolve_trigger_event_wakes 0
check "failed shim left seen (redeliver)" "4" "$(cat "$VARDIR/events/qa__pr.opened.seen")"

# --- shim-lane ports from the retired legacy first half ----------------------
# no new token -> no fire.
reset2
TRIG_ENUM_OUT="qa${TAB}shim${TAB}pr.opened${TAB}skip${TAB}1"
POLL_OUT="$(printf '4\n5')"
seed_seen "qa__pr.opened" "$(printf '4\n5')"
resolve_trigger_event_wakes 0
check "shim no new token did not fire" "" "$(cat "$CAPTURE")"

# first-sight: seed the seen-set without firing (the native twin is below).
reset2
TRIG_ENUM_OUT="qa${TAB}shim${TAB}pr.opened${TAB}skip${TAB}1"
POLL_OUT="$(printf '4\n5')"
resolve_trigger_event_wakes 0
check "shim first-sight did not fire" "" "$(cat "$CAPTURE")"
check "shim first-sight seeded seen-set" "yes" \
  "$([ -f "$VARDIR/events/qa__pr.opened.seen" ] && echo yes || echo no)"

# poll failure: no fire, no error, seen untouched.
reset2
TRIG_ENUM_OUT="qa${TAB}shim${TAB}pr.opened${TAB}skip${TAB}1"
seed_seen "qa__pr.opened" "4"
POLL_RC=1
resolve_trigger_event_wakes 0; rc=$?
check "shim poll failure returns 0" "0" "$rc"
check "shim poll failure fired nothing" "" "$(cat "$CAPTURE")"
check "shim poll failure left seen untouched" "4" "$(cat "$VARDIR/events/qa__pr.opened.seen")"

# a dotted shim name (valid charset) is processed, not path-gated out.
reset2
TRIG_ENUM_OUT="qa.v2${TAB}shim${TAB}pr.opened${TAB}skip${TAB}1"
POLL_OUT="$(printf '4\n5')"
seed_seen "qa.v2__pr.opened" "4"
resolve_trigger_event_wakes 0
check "dotted shim name fired (not dropped)" "qa.v2" "$(cat "$CAPTURE")"

# invalid shim name: dropped, no fire (prevention-log #6).
reset2
TRIG_ENUM_OUT="bad/name${TAB}shim${TAB}pr.opened${TAB}skip${TAB}1"
POLL_OUT="5"
resolve_trigger_event_wakes 0
check "invalid shim name did not fire" "" "$(cat "$CAPTURE")"

# --- native: START-ONLY, one run per new token --------------------------------
reset2
TRIG_ENUM_OUT="qa-x${TAB}native${TAB}pr.opened${TAB}skip${TAB}1"
POLL_OUT="$(printf '4\n5')"
seed_seen "qa-x__pr.opened" "4"
resolve_trigger_event_wakes 0
check "native lane never runs a session" "" "$(cat "$CAPTURE")"
contains "native start called with the token field" "$(cat "$PYCALLS")" \
  "--event-field item=5"
contains "native start is kind native" "$(cat "$PYCALLS")" "--kind native"
contains "native seen advanced per started token" \
  "$(cat "$VARDIR/events/qa-x__pr.opened.seen")" "5"

# --- native seen PRUNES to the current page (boundedness) ---------------------
reset2
TRIG_ENUM_OUT="qa-x${TAB}native${TAB}pr.opened${TAB}skip${TAB}1"
POLL_OUT="5"
seed_seen "qa-x__pr.opened" "$(printf '3\n4\n5')"   # 3,4 scrolled off the page
resolve_trigger_event_wakes 0
check "native seen pruned to page" "5" "$(cat "$VARDIR/events/qa-x__pr.opened.seen")"

# --- native at-capacity: token NOT advanced (redelivered) ---------------------
reset2
TRIG_ENUM_OUT="qa-x${TAB}native${TAB}pr.opened${TAB}skip${TAB}1"
POLL_OUT="$(printf '4\n5')"
seed_seen "qa-x__pr.opened" "4"
CAP_RC=1
resolve_trigger_event_wakes 0
check "at-capacity fired no start" "" "$(cat "$PYCALLS")"
check "at-capacity token redelivered" "4" "$(cat "$VARDIR/events/qa-x__pr.opened.seen")"

# --- native failed start: token NOT advanced ----------------------------------
reset2
TRIG_ENUM_OUT="qa-x${TAB}native${TAB}pr.opened${TAB}skip${TAB}1"
POLL_OUT="$(printf '4\n5')"
seed_seen "qa-x__pr.opened" "4"
PY_RC=1
resolve_trigger_event_wakes 0
check "failed start token redelivered" "4" "$(cat "$VARDIR/events/qa-x__pr.opened.seen")"

# --- native first-sight seeds without starting --------------------------------
reset2
TRIG_ENUM_OUT="qa-x${TAB}native${TAB}pr.opened${TAB}skip${TAB}1"
POLL_OUT="$(printf '4\n5')"
resolve_trigger_event_wakes 0
check "native first-sight started nothing" "" "$(cat "$PYCALLS")"
check "native first-sight seeded" "yes" \
  "$([ -f "$VARDIR/events/qa-x__pr.opened.seen" ] && echo yes || echo no)"

# --- pr.synchronize native maps NUMBER:SHA into two fields --------------------
reset2
TRIG_ENUM_OUT="qa-x${TAB}native${TAB}pr.synchronize${TAB}skip${TAB}1"
POLL_OUT="7:abc123"
seed_seen "qa-x__pr.synchronize" ""
resolve_trigger_event_wakes 0
contains "sync item field" "$(cat "$PYCALLS")" "--event-field item=7"
contains "sync sha field" "$(cat "$PYCALLS")" "--event-field sha=abc123"

# --- empty page + nothing handled: seen EMPTIES cleanly (review round 1) -------
# all previously-seen tokens scrolled off the poll page and nothing new was
# handled -> the advance writes an EMPTY seen-set; grep's rc-1 on zero lines
# is not a failure and must not leave the stale file or a spurious WARN.
reset2
TRIG_ENUM_OUT="qa-x${TAB}native${TAB}pr.opened${TAB}skip${TAB}1"
POLL_OUT=""
seed_seen "qa-x__pr.opened" "4"
resolve_trigger_event_wakes 0
check "empty page emptied the seen-set" "" "$(cat "$VARDIR/events/qa-x__pr.opened.seen")"
case "$(cat "$LOGF")" in
  *"cannot advance seen"*) check "no spurious advance WARN" 0 1 ;;
  *) check "no spurious advance WARN" 0 0 ;;
esac

# --- hostile enumeration lines are dropped -------------------------------------
reset2
TRIG_ENUM_OUT="bad/name${TAB}native${TAB}pr.opened${TAB}skip${TAB}1"
POLL_OUT="5"
resolve_trigger_event_wakes 0
check "hostile trigger name started nothing" "" "$(cat "$PYCALLS")"

# --- enumeration failure: quiet no-op ------------------------------------------
reset2
TRIG_ENUM_RC=1
resolve_trigger_event_wakes 0; rc=$?
check "trigger enumeration failure returns 0" "0" "$rc"

# --- single-wiring proof (parity 5's surviving half) ---------------------------
# The trigger resolver is the ONE event dispatch call in the loop (the legacy
# twin is deleted -- Phase E; double dispatch is structurally impossible).
n="$(grep -c 'resolve_trigger_event_wakes "\$session_ran"' "$ENGINE_HOME/bin/supervisor.sh")"
check "trigger event resolver wired in the loop" "1" "$n"

echo ""
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
