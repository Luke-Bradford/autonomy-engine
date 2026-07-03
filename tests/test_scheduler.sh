#!/usr/bin/env bash
# tests/test_scheduler.sh -- W1 scheduler (cron triggers, issue #85). The
# supervisor folds a cron check into its loop iteration: enumerate cron roles
# (roles.py cron, seam _cron_enumerate), compute due-ness via roles.py cron-due
# (real cron_next_fire math), fire due roles through run_session (stubbed here),
# and advance a supervisor-owned per-role last-fire marker. Sources the real
# supervisor.sh and stubs only run_session + the enumeration seam.
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
AUTONOMY_TARGET_REPO="$tmp/repo"   # unused while _cron_enumerate is stubbed

# run_session is stubbed to record which role it fired (the established seam).
CAPTURE="$tmp/fired"
: >"$CAPTURE"
run_session() { echo "$1" >>"$CAPTURE"; return 0; }

# _cron_enumerate is the enumeration seam: tests override it to feed
# NAME<TAB>SCHEDULE lines without touching roles.py cron.
TAB="$(printf '\t')"
ENUM_OUT=""
ENUM_RC=0
_cron_enumerate() { [ "$ENUM_RC" -eq 0 ] || return "$ENUM_RC"; printf '%s' "$ENUM_OUT"; }

reset() { : >"$CAPTURE"; : >"$LOGF"; rm -rf "$VARDIR"; ENUM_OUT=""; ENUM_RC=0; }

# --- the real function is defined by sourcing (not a stub) -------------------
check "resolve_cron_due is defined" "function" "$(type -t resolve_cron_due)"

# --- a due role fires and its marker advances --------------------------------
reset
ENUM_OUT="duejob${TAB}* * * * *"
# marker is year-2001, so the next '* * * * *' fire is ~now: due.
mkdir -p "$VARDIR/cron"
echo 1000000000 >"$VARDIR/cron/duejob.last_fire"
resolve_cron_due
check "due role fired once" "duejob" "$(cat "$CAPTURE")"
marker_after="$(cat "$VARDIR/cron/duejob.last_fire")"
check "marker advanced off the old value" "yes" "$([ "$marker_after" != "1000000000" ] && echo yes || echo no)"
check "marker is a recent epoch" "yes" "$([ "$marker_after" -gt 1000000060 ] && echo yes || echo no)"

# --- a not-yet-due role does not fire ----------------------------------------
reset
ENUM_OUT="later${TAB}0 0 1 1 *"          # yearly; next fire is far in the future
mkdir -p "$VARDIR/cron"
date +%s >"$VARDIR/cron/later.last_fire"
resolve_cron_due
check "not-due role did not fire" "" "$(cat "$CAPTURE")"

# --- first-sight role: marker created, no fire -------------------------------
reset
ENUM_OUT="fresh${TAB}* * * * *"
resolve_cron_due
check "first-sight role did not fire" "" "$(cat "$CAPTURE")"
check "first-sight marker created" "yes" "$([ -f "$VARDIR/cron/fresh.last_fire" ] && echo yes || echo no)"

# --- enumeration failure: no fire, no error, loop unaffected -----------------
reset
ENUM_RC=1
resolve_cron_due; rc=$?
check "enumeration failure returns 0" "0" "$rc"
check "enumeration failure fired nothing" "" "$(cat "$CAPTURE")"

# --- corrupt/unreadable marker: reinit without firing (under-fire) -----------
# A non-numeric marker must NOT be read as epoch 0 (which would force an
# immediate spurious fire) -- treat like first-sight: reinit to now, no fire.
reset
ENUM_OUT="corrupt${TAB}* * * * *"
mkdir -p "$VARDIR/cron"
printf 'garbage' >"$VARDIR/cron/corrupt.last_fire"
resolve_cron_due
check "corrupt-marker role did not fire" "" "$(cat "$CAPTURE")"
cm="$(cat "$VARDIR/cron/corrupt.last_fire")"
check "corrupt marker reinitialised to a numeric epoch" "yes" "$(grep -qE '^[0-9]+$' <<<"$cm" && echo yes || echo no)"
contains "corrupt-marker warned" "$(cat "$LOGF")" "WARN"

# --- marker write failure: skip fire, no over-fire (fail-safe under-fire) ----
# The marker is advanced BEFORE firing; if that write fails the role must NOT
# fire (else it re-fires every tick). Simulate by making the marker read-only.
# Skipped under root (perms ignored).
if [ "$(id -u)" != "0" ]; then
  reset
  ENUM_OUT="stuck${TAB}* * * * *"
  mkdir -p "$VARDIR/cron"
  echo 1000000000 >"$VARDIR/cron/stuck.last_fire"   # due
  chmod 0444 "$VARDIR/cron/stuck.last_fire"
  resolve_cron_due; rc=$?
  chmod 0644 "$VARDIR/cron/stuck.last_fire"          # restore for cleanup
  check "marker-write failure returns 0" "0" "$rc"
  check "marker-write failure did not fire" "" "$(cat "$CAPTURE")"
  check "marker-write failure left marker unadvanced" "1000000000" "$(cat "$VARDIR/cron/stuck.last_fire")"
  contains "marker-write failure warned" "$(cat "$LOGF")" "WARN"
fi

# --- invalid role name: WARN, ignored, no fire (prevention-log #6) -----------
reset
ENUM_OUT="bad/name${TAB}* * * * *"
mkdir -p "$VARDIR/cron"
resolve_cron_due
check "invalid-name role did not fire" "" "$(cat "$CAPTURE")"
contains "invalid-name role warned" "$(cat "$LOGF")" "WARN"

echo ""
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
