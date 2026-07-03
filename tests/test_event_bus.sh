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

echo ""
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
