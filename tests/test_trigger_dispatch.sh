#!/bin/bash
# Phase B (#374): trigger dispatch plumbing, built BEHIND the role path --
# tokens (name[@slot]), slot-aware state files, inflight_tokens,
# resolve_dispatch_triggers over the _triggers_enumerate seam, and the
# per-trigger lifecycle/concurrency helpers (Task 8). Sources the REAL
# supervisor; stubs only the enumeration seam (the established pattern).
# shellcheck disable=SC2034  # vars consumed inside the sourced supervisor.sh
set -uo pipefail
ENGINE_HOME="$(cd "$(dirname "$0")/.." && pwd)"
export ENGINE_HOME

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"
  else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails+1)); fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

repo="$tmp/repo"
mkdir -p "$repo/.autonomy" "$repo/var/autonomy-logs"
printf 'roles:\n  coder:\n    enabled: true\n' >"$repo/.autonomy/config.yaml"

# --- source the real supervisor ----------------------------------------------
# shellcheck source=/dev/null
source "$ENGINE_HOME/bin/supervisor.sh"
AUTONOMY_TARGET_REPO="$repo"
VARDIR="$repo/var"; LOGDIR="$VARDIR/autonomy-logs"
SUPLOG=/dev/null
AUTONOMY_LANE=""
log() { :; }

# --- token helpers: 'name' and 'name@slot' split cleanly; bad tokens refuse ---
check "token_name plain"        "coder"   "$(token_name 'coder')"
check "token_name slotted"      "qa"      "$(token_name 'qa@2')"
check "token_slot plain is 0"   "0"       "$(token_slot 'coder')"
check "token_slot slotted"      "2"       "$(token_slot 'qa@2')"
check "token bad charset rc"    "1"       "$(token_name 'x;y' >/dev/null 2>&1; echo $?)"
check "token bad slot rc"       "1"       "$(token_name 'qa@x' >/dev/null 2>&1; echo $?)"
check "token empty slot rc"     "1"       "$(token_name 'qa@' >/dev/null 2>&1; echo $?)"

# --- pipeline_state_file: slot 0 keeps the LEGACY filename (parity inv. 2) ----
check "state file slot0 legacy" "$LOGDIR/.pipeline-run-coder.json" \
  "$(pipeline_state_file coder 0)"
check "state file no-slot arg"  "$LOGDIR/.pipeline-run-coder.json" \
  "$(pipeline_state_file coder)"
check "state file slot2"        "$LOGDIR/.pipeline-run-coder@2.json" \
  "$(pipeline_state_file coder 2)"
AUTONOMY_LANE="qa"
check "state file lane+slot"    "$LOGDIR/.pipeline-run-coder--qa@2.json" \
  "$(pipeline_state_file coder 2)"
check "state file lane slot0"   "$LOGDIR/.pipeline-run-coder--qa.json" \
  "$(pipeline_state_file coder 0)"
AUTONOMY_LANE=""

# --- inflight_tokens: slot-aware tokens, charset-gates disk input -------------
: >"$LOGDIR/.pipeline-run-coder.json"
: >"$LOGDIR/.pipeline-run-qa@1.json"
: >"$LOGDIR/.pipeline-run-ev;l.json"
out="$(inflight_tokens | sort | tr '\n' ' ')"
check "inflight tokens"         "coder qa@1 " "$out"

# lane+slot parse order (Codex CP1): strip @slot FIRST, then --lane
: >"$LOGDIR/.pipeline-run-coder--qa@2.json"
AUTONOMY_LANE="qa"
out="$(inflight_tokens | sort | tr '\n' ' ')"
check "lane inflight slotted"   "coder@2 " "$out"
AUTONOMY_LANE=""
out="$(inflight_tokens | sort | tr '\n' ' ')"
check "other lane's state not ours" "coder qa@1 " "$out"
rm -f "$LOGDIR"/.pipeline-run-*.json

# --- resolve_dispatch_triggers goes through the _triggers_enumerate seam ------
_triggers_enumerate() { printf 'coder\tshim\tskip\t1\nqa-x\tnative\tparallel\t2\n'; }
out="$(resolve_dispatch_triggers | tr '\n' ' ')"
check "dispatch trigger names"  "coder qa-x " "$out"
resolve_dispatch_triggers >/dev/null
check "trigger_kind_of shim"    "shim"    "$(trigger_kind_of coder)"
check "trigger_kind_of native"  "native"  "$(trigger_kind_of qa-x)"
check "trigger_policy_of"       "parallel" "$(trigger_policy_of qa-x)"
check "trigger_max_of"          "2"        "$(trigger_max_of qa-x)"
# absent from enumeration = pre-cutover in-flight compat: advance-only defaults
check "kind of unknown = shim"  "shim"    "$(trigger_kind_of ghost)"
check "policy of unknown"       "skip"    "$(trigger_policy_of ghost)"
check "max of unknown"          "1"       "$(trigger_max_of ghost)"
# hostile enumeration lines are dropped, never dispatched (prevention-log #6)
_triggers_enumerate() { printf 'x;y\tshim\tskip\t1\nok\tshim\tskip\t1\nz\twat\tskip\t1\n'; }
out="$(resolve_dispatch_triggers | tr '\n' ' ')"
check "hostile enum lines dropped" "ok " "$out"
_triggers_enumerate() { return 1; }
resolve_dispatch_triggers >/dev/null 2>&1
check "enumeration failure rc"  "1" "$?"
# restore the REAL seam (unset -f would delete the sourced function too)
_triggers_enumerate() {
  if [ -n "${AUTONOMY_LANE:-}" ]; then
    python3 "$ENGINE_HOME/lib/triggers.py" "$@" --lane "$AUTONOMY_LANE" 2>>"$SUPLOG"
  else
    python3 "$ENGINE_HOME/lib/triggers.py" "$@" 2>>"$SUPLOG"
  fi
}

# --- Task 8: per-trigger lifecycle markers + concurrency gating ---------------
ERR_BACKOFF_START=60; ERR_BACKOFF_MAX=3600

# backoff: record -> future epoch; clear -> 0; junk marker reads as 0
trigger_record_error_backoff coder
now="$(date -u +%s)"
until_e="$(trigger_backoff_until coder)"
check "backoff records future epoch" "0" "$([ "$until_e" -gt "$now" ] && echo 0 || echo 1)"
trigger_record_error_backoff coder
until2="$(trigger_backoff_until coder)"
check "backoff grows on repeat"     "0" "$([ "$until2" -ge "$until_e" ] && echo 0 || echo 1)"
trigger_clear_backoff coder
check "backoff cleared"             "0" "$(trigger_backoff_until coder)"
mkdir -p "$VARDIR/trigger-ctl/backoff" && printf 'junk\n' >"$VARDIR/trigger-ctl/backoff/coder"
check "junk backoff reads 0 (safe)" "0" "$(trigger_backoff_until coder)"
rm -f "$VARDIR/trigger-ctl/backoff/coder"
check "bad name refused"            "1" "$(trigger_backoff_until 'a;b' >/dev/null 2>&1; echo $?)"

# stop sentinel
mkdir -p "$VARDIR/trigger-ctl/stop" && : >"$VARDIR/trigger-ctl/stop/coder"
check "stop sentinel detected"      "0" "$(trigger_stopped coder && echo 0 || echo 1)"
rm -f "$VARDIR/trigger-ctl/stop/coder"
check "stop sentinel gone"          "1" "$(trigger_stopped coder && echo 0 || echo 1)"
check "stop bad name refused"       "1" "$(trigger_stopped 'a;b' && echo 0 || echo 1)"

# slots: first hole wins; full -> rc 1; slot 0 keeps the legacy filename
: >"$LOGDIR/.pipeline-run-qa.json"
check "free slot skips slot 0"      "1" "$(trigger_free_slot qa 3)"
: >"$LOGDIR/.pipeline-run-qa@1.json" && : >"$LOGDIR/.pipeline-run-qa@2.json"
check "no free slot rc"             "1" "$(trigger_free_slot qa 3 >/dev/null; echo $?)"
check "inflight count"              "3" "$(trigger_inflight_count qa)"

# start token: policy skip clamps to max 1
_triggers_enumerate() { printf 'qa\tnative\tskip\t1\nfleet\tnative\tparallel\t3\n'; }
resolve_dispatch_triggers >/dev/null
check "skip at capacity rc"         "1" "$(trigger_start_token qa >/dev/null; echo $?)"
: >"$LOGDIR/.pipeline-run-fleet.json"
check "parallel next slot token"    "fleet@1" "$(trigger_start_token fleet)"
rm -f "$LOGDIR"/.pipeline-run-*.json
check "fresh trigger slot0 token"   "qa" "$(trigger_start_token qa)"
# restore the REAL seam (unset -f would delete the sourced function too)
_triggers_enumerate() {
  if [ -n "${AUTONOMY_LANE:-}" ]; then
    python3 "$ENGINE_HOME/lib/triggers.py" "$@" --lane "$AUTONOMY_LANE" 2>>"$SUPLOG"
  else
    python3 "$ENGINE_HOME/lib/triggers.py" "$@" 2>>"$SUPLOG"
  fi
}

# --- manual fire markers -------------------------------------------------------
# Real trigger files + the real triggers.py drive the identity check.
mkdir -p "$repo/.autonomy/triggers" "$repo/.autonomy/pipelines/flow"
printf '{"name":"flow","version":1,"caps":{"max_sessions_per_run":4},"nodes":[{"id":"a","type":"pick","brief_ref":"a.md"}],"edges":[]}' \
  >"$repo/.autonomy/pipelines/flow/pipeline.json"
printf 'pick\n' >"$repo/.autonomy/pipelines/flow/a.md"
printf '{"name":"push-now","pipeline":"flow","firing":{"mode":"manual"}}' \
  >"$repo/.autonomy/triggers/push-now.json"
printf '{"name":"always-on","pipeline":"flow","firing":{"mode":"continuous"}}' \
  >"$repo/.autonomy/triggers/always-on.json"

# File-based recorder: resolve_trigger_cron_due fires inside a pipeline
# subshell (the resolve_cron_due shape), so a variable would not escape.
RS_FILE="$tmp/rs_calls"; : >"$RS_FILE"
run_session() { printf ' %s:%s' "$1" "$2" >>"$RS_FILE"; return 0; }
rs_calls() { cat "$RS_FILE"; }

mkdir -p "$VARDIR/trigger-ctl/fire"
: >"$VARDIR/trigger-ctl/fire/push-now"
: >"$VARDIR/trigger-ctl/fire/bad;name"
: >"$VARDIR/trigger-ctl/fire/always-on"     # non-manual -> WARN-removed
resolve_manual_fires
check "manual fire ran once"        " push-now:native" "$(rs_calls)"
check "manual marker consumed"      "1" "$([ -f "$VARDIR/trigger-ctl/fire/push-now" ] && echo 0 || echo 1)"
check "bad-charset marker removed"  "1" "$([ -f "$VARDIR/trigger-ctl/fire/bad;name" ] && echo 0 || echo 1)"
check "non-manual marker removed"   "1" "$([ -f "$VARDIR/trigger-ctl/fire/always-on" ] && echo 0 || echo 1)"

# at capacity: marker KEPT for retry, no session
: >"$RS_FILE"
: >"$LOGDIR/.pipeline-run-push-now.json"
: >"$VARDIR/trigger-ctl/fire/push-now"
resolve_manual_fires
check "manual at capacity no run"   "" "$(rs_calls)"
check "manual marker kept"          "0" "$([ -f "$VARDIR/trigger-ctl/fire/push-now" ] && echo 0 || echo 1)"
rm -f "$LOGDIR"/.pipeline-run-*.json "$VARDIR/trigger-ctl/fire/push-now"

# --- queued fires ---------------------------------------------------------------
: >"$RS_FILE"
mkdir -p "$VARDIR/trigger-ctl/queued"
printf 'native\n' >"$VARDIR/trigger-ctl/queued/push-now"
resolve_queued_fires
check "queued fire ran with kind"   " push-now:native" "$(rs_calls)"
check "queued marker consumed"      "1" "$([ -f "$VARDIR/trigger-ctl/queued/push-now" ] && echo 0 || echo 1)"
: >"$RS_FILE"
printf 'wat\n' >"$VARDIR/trigger-ctl/queued/push-now"
resolve_queued_fires
check "junk kind clamps to shim"    " push-now:shim" "$(rs_calls)"
: >"$RS_FILE"
printf 'native\n' >"$VARDIR/trigger-ctl/queued/push-now"
: >"$LOGDIR/.pipeline-run-push-now.json"
resolve_queued_fires
check "queued at capacity waits"    "" "$(rs_calls)"
check "queued marker kept at cap"   "0" "$([ -f "$VARDIR/trigger-ctl/queued/push-now" ] && echo 0 || echo 1)"
rm -f "$LOGDIR"/.pipeline-run-*.json "$VARDIR/trigger-ctl/queued/push-now"

# --- schedule firing via the cron machinery --------------------------------------
printf '{"name":"nightly","pipeline":"flow","firing":{"mode":"schedule","schedule":"* * * * *"},"concurrency":{"policy":"queue","max":1}}' \
  >"$repo/.autonomy/triggers/nightly.json"
: >"$RS_FILE"
resolve_trigger_cron_due
check "cron first sight no fire"    "" "$(rs_calls)"
check "cron marker initialised"     "0" "$([ -f "$VARDIR/cron/nightly.last_fire" ] && echo 0 || echo 1)"
printf '0' >"$VARDIR/cron/nightly.last_fire"
resolve_trigger_cron_due
check "cron due fires native"       " nightly:native" "$(rs_calls)"
# at capacity, policy queue -> ONE queued marker carrying the kind
: >"$RS_FILE"
: >"$LOGDIR/.pipeline-run-nightly.json"
printf '0' >"$VARDIR/cron/nightly.last_fire"
resolve_trigger_cron_due
check "cron at cap queues not fires" "" "$(rs_calls)"
check "queued marker written"       "native" "$(cat "$VARDIR/trigger-ctl/queued/nightly" 2>/dev/null)"
rm -f "$LOGDIR"/.pipeline-run-*.json "$VARDIR/trigger-ctl/queued/nightly" "$VARDIR/cron/nightly.last_fire"
rm -f "$repo/.autonomy/triggers"/*.json

echo
if [ "$fails" -gt 0 ]; then echo "$fails FAILURE(S)"; exit 1; fi
echo "ALL CHECKS PASS"
