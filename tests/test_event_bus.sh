#!/usr/bin/env bash
# tests/test_event_bus.sh -- W2 event bus (event triggers, issue #86). The
# supervisor folds a gh-poll event check into its loop iteration: enumerate
# event roles (roles.py events, seam _event_enumerate), poll current fireable
# tokens per event (seam _event_poll), fire a role via run_session (stubbed)
# when a new token appears since its per-(role,event) seen-set, and advance the
# seen-set after a successful dispatch (at-least-once). session.done is a
# per-tick loop-session edge. Sources the real supervisor.sh, stubs only
# run_session + the two seams.
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
ENUM_OUT=""
ENUM_RC=0
_event_enumerate() { [ "$ENUM_RC" -eq 0 ] || return "$ENUM_RC"; printf '%s' "$ENUM_OUT"; }

POLL_OUT=""
POLL_RC=0
_event_poll() { [ "$POLL_RC" -eq 0 ] || return "$POLL_RC"; printf '%s\n' "$POLL_OUT"; }

reset() { : >"$CAPTURE"; : >"$LOGF"; rm -rf "$VARDIR"; ENUM_OUT=""; ENUM_RC=0; POLL_OUT=""; POLL_RC=0; RS_RC=0; }
seed_seen() { mkdir -p "$VARDIR/events"; printf '%s\n' "$2" > "$VARDIR/events/$1.seen"; }

# --- the real function is defined by sourcing (not a stub) -------------------
check "resolve_event_wakes is defined" "function" "$(type -t resolve_event_wakes)"

# --- a new pr.opened number fires and the seen-set advances ------------------
reset
ENUM_OUT="qa${TAB}pr.opened"
POLL_OUT="$(printf '4\n5')"           # PR 5 is new relative to seen {4}
seed_seen "qa__pr.opened" "4"
resolve_event_wakes 0
check "new pr.opened fired qa once" "qa" "$(cat "$CAPTURE")"
contains "seen advanced to include 5" "$(cat "$VARDIR/events/qa__pr.opened.seen")" "5"

# --- no new token -> no fire -------------------------------------------------
reset
ENUM_OUT="qa${TAB}pr.opened"
POLL_OUT="$(printf '4\n5')"
seed_seen "qa__pr.opened" "$(printf '4\n5')"
resolve_event_wakes 0
check "no new token did not fire" "" "$(cat "$CAPTURE")"

# --- first-sight: seed the seen-set without firing ---------------------------
reset
ENUM_OUT="qa${TAB}pr.opened"
POLL_OUT="$(printf '4\n5')"
resolve_event_wakes 0
check "first-sight did not fire" "" "$(cat "$CAPTURE")"
check "first-sight seeded seen-set" "yes" "$([ -f "$VARDIR/events/qa__pr.opened.seen" ] && echo yes || echo no)"

# --- dispatch failure leaves the seen-set unadvanced (re-delivers) -----------
reset
ENUM_OUT="qa${TAB}pr.opened"
POLL_OUT="$(printf '4\n5')"
seed_seen "qa__pr.opened" "4"
RS_RC=1
resolve_event_wakes 0
check "failed dispatch still fired (attempted)" "qa" "$(cat "$CAPTURE")"
check "failed dispatch did NOT advance seen (re-deliver)" "yes" \
  "$(grep -Fxq 5 "$VARDIR/events/qa__pr.opened.seen" && echo no || echo yes)"

# --- poll failure: no fire, no error, seen untouched -------------------------
reset
ENUM_OUT="qa${TAB}pr.opened"
seed_seen "qa__pr.opened" "4"
POLL_RC=1
resolve_event_wakes 0; rc=$?
check "poll failure returns 0" "0" "$rc"
check "poll failure fired nothing" "" "$(cat "$CAPTURE")"
check "poll failure left seen untouched" "4" "$(cat "$VARDIR/events/qa__pr.opened.seen")"

# --- session.done fires on a loop-session tick, not otherwise ----------------
reset
ENUM_OUT="notify${TAB}session.done"
resolve_event_wakes 1
check "session.done fired when a session ran" "notify" "$(cat "$CAPTURE")"
reset
ENUM_OUT="notify${TAB}session.done"
resolve_event_wakes 0
check "session.done did not fire with no session" "" "$(cat "$CAPTURE")"

# --- enumeration failure: no fire, no error ----------------------------------
reset
ENUM_RC=1
resolve_event_wakes 0; rc=$?
check "enumeration failure returns 0" "0" "$rc"
check "enumeration failure fired nothing" "" "$(cat "$CAPTURE")"

# --- a dotted role name (valid per roles.py _ROLE_NAME_RE) is processed -------
reset
ENUM_OUT="qa.v2${TAB}pr.opened"
POLL_OUT="$(printf '4\n5')"
seed_seen "qa.v2__pr.opened" "4"
resolve_event_wakes 0
check "dotted role name fired (not dropped)" "qa.v2" "$(cat "$CAPTURE")"

# --- invalid role name ignored with WARN -------------------------------------
reset
ENUM_OUT="bad/name${TAB}pr.opened"
POLL_OUT="5"
resolve_event_wakes 0
check "invalid-name role did not fire" "" "$(cat "$CAPTURE")"
contains "invalid-name role warned" "$(cat "$LOGF")" "WARN"

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

# --- structural double-dispatch impossibility (parity 5) -----------------------
# [[:space:]] not \s -- BSD grep has no \s; a silently-unmatched pattern would
# fake the proof (CP1).
n="$(grep -c '^[[:space:]]*resolve_event_wakes ' "$ENGINE_HOME/bin/supervisor.sh" || true)"
check "legacy event resolver uncalled by the loop" "0" "$n"
n="$(grep -c 'resolve_trigger_event_wakes "\$session_ran"' "$ENGINE_HOME/bin/supervisor.sh")"
check "trigger event resolver wired in the loop" "1" "$n"

echo ""
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
