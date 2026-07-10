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

# lane-scoped markers (review round 2): a same-named trigger in another lane
# must never be frozen/throttled by THIS lane's markers -- the marker name
# carries the lane suffix exactly like pipeline_state_file's filename.
AUTONOMY_LANE="qa"
: >"$VARDIR/trigger-ctl/stop/coder"          # bare marker = default lane's
check "lane ignores default-lane stop" "1" "$(trigger_stopped coder && echo 0 || echo 1)"
: >"$VARDIR/trigger-ctl/stop/coder--qa"
check "lane sees its own stop"         "0" "$(trigger_stopped coder && echo 0 || echo 1)"
trigger_record_error_backoff coder
check "lane backoff file suffixed"     "0" "$([ -f "$VARDIR/trigger-ctl/backoff/coder--qa" ] && echo 0 || echo 1)"
trigger_clear_backoff coder
AUTONOMY_LANE=""
rm -f "$VARDIR/trigger-ctl/stop/coder"       # drop the bare marker first
check "default lane ignores qa stop"   "1" "$(trigger_stopped coder && echo 0 || echo 1)"
rm -f "$VARDIR/trigger-ctl/stop/coder" "$VARDIR/trigger-ctl/stop/coder--qa"

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

# lane discipline on the fire scanner (review round 2): a default-lane
# supervisor skips other lanes' markers; a lane supervisor consumes only
# its own suffix (trigger must belong to that lane in config).
: >"$RS_FILE"
: >"$VARDIR/trigger-ctl/fire/push-now--qa"
resolve_manual_fires
check "default lane skips qa marker" "" "$(rs_calls)"
check "qa marker left in place"      "0" "$([ -f "$VARDIR/trigger-ctl/fire/push-now--qa" ] && echo 0 || echo 1)"
rm -f "$VARDIR/trigger-ctl/fire/push-now--qa"

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
check "junk kind refused, no run"   "" "$(rs_calls)"
check "junk queued marker removed"  "1" "$([ -f "$VARDIR/trigger-ctl/queued/push-now" ] && echo 0 || echo 1)"
: >"$RS_FILE"
printf 'native\n' >"$VARDIR/trigger-ctl/queued/push-now"
: >"$LOGDIR/.pipeline-run-push-now.json"
resolve_queued_fires
check "queued at capacity waits"    "" "$(rs_calls)"
check "queued marker kept at cap"   "0" "$([ -f "$VARDIR/trigger-ctl/queued/push-now" ] && echo 0 || echo 1)"
rm -f "$LOGDIR"/.pipeline-run-*.json "$VARDIR/trigger-ctl/queued/push-now"

# --- run-window fire-marker deferral (Phase E) -------------------------------
# manual: window-closed keeps the marker (the disabled-marker discipline).
# Stub both seams; the real definitions are restored below (save/restore --
# re-sourcing here would clobber the run_session recorder).
SAVED_SHOW_FIELDS="$(declare -f _trigger_show_fields)"
: >"$RS_FILE"
mkdir -p "$(trigger_ctl_dir fire)"
: >"$VARDIR/trigger-ctl/fire/night-push"
_triggers_enumerate() { printf ''; }   # window-filtered list omits it
_trigger_show_fields() {
  SHOW_MODE="manual"; SHOW_ENABLED="true"; SHOW_POLICY="skip"
  SHOW_MAX=1; SHOW_WINDOW="closed"
}
resolve_manual_fires
check "window-closed manual marker kept" "0" \
  "$([ -f "$VARDIR/trigger-ctl/fire/night-push" ] && echo 0 || echo 1)"
check "window-closed manual did not run" "" "$(rs_calls)"
rm -f "$VARDIR/trigger-ctl/fire/night-push"

# queued: window-closed defers the drain, marker kept.
: >"$RS_FILE"
mkdir -p "$(trigger_ctl_dir queued)"
printf 'native\n' >"$VARDIR/trigger-ctl/queued/night-push"
resolve_queued_fires
check "window-closed queued marker kept" "0" \
  "$([ -f "$VARDIR/trigger-ctl/queued/night-push" ] && echo 0 || echo 1)"
check "window-closed queued did not run" "" "$(rs_calls)"

# window OPEN drains the queued marker (the gate opens, not just closes).
_trigger_show_fields() {
  SHOW_MODE="manual"; SHOW_ENABLED="true"; SHOW_POLICY="skip"
  SHOW_MAX=1; SHOW_WINDOW="open"
}
resolve_queued_fires
check "window-open queued fire ran" " night-push:native" "$(rs_calls)"
check "window-open queued marker consumed" "1" \
  "$([ -f "$VARDIR/trigger-ctl/queued/night-push" ] && echo 0 || echo 1)"
# restore the REAL seams (unset -f would delete the sourced functions too)
eval "$SAVED_SHOW_FIELDS"
_triggers_enumerate() {
  if [ -n "${AUTONOMY_LANE:-}" ]; then
    python3 "$ENGINE_HOME/lib/triggers.py" "$@" --lane "$AUTONOMY_LANE" 2>>"$SUPLOG"
  else
    python3 "$ENGINE_HOME/lib/triggers.py" "$@" 2>>"$SUPLOG"
  fi
}

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

# hostile kind on the cron enumeration pipe is DROPPED, never clamped to
# shim (review round 3: a clamp could route a native trigger through
# legacy role dispatch -- resolve_dispatch_triggers' line-drop discipline)
_triggers_enumerate() { printf 'evil\t* * * * *\twat\n'; }
: >"$RS_FILE"
resolve_trigger_cron_due
check "hostile cron kind no fire"   "" "$(rs_calls)"
check "hostile cron kind no marker" "1" "$([ -f "$VARDIR/cron/evil.last_fire" ] && echo 0 || echo 1)"
# restore the REAL seam (unset -f would delete the sourced function too)
_triggers_enumerate() {
  if [ -n "${AUTONOMY_LANE:-}" ]; then
    python3 "$ENGINE_HOME/lib/triggers.py" "$@" --lane "$AUTONOMY_LANE" 2>>"$SUPLOG"
  else
    python3 "$ENGINE_HOME/lib/triggers.py" "$@" 2>>"$SUPLOG"
  fi
}

# --- dispatch_kind_of: kind comes from the run's OWN state, never a guess ------
printf '{"fmt": 2, "doc": {}, "kind": "native", "status": "in_progress"}' \
  >"$LOGDIR/.pipeline-run-natv.json"
check "state kind native"           "native" "$(state_kind_of natv 0)"
printf '{"fmt": 2, "doc": {}, "status": "in_progress"}' \
  >"$LOGDIR/.pipeline-run-oldstate.json"
check "pre-phaseB state kind shim"  "shim"   "$(state_kind_of oldstate 0)"
printf 'not json' >"$LOGDIR/.pipeline-run-corrupt.json"
check "corrupt state kind rc1"      "1"      "$(state_kind_of corrupt 0 >/dev/null 2>&1; echo $?)"
printf '{"fmt": 2, "doc": {}, "kind": "wat"}' >"$LOGDIR/.pipeline-run-badkind.json"
check "junk state kind rc1"         "1"      "$(state_kind_of badkind 0 >/dev/null 2>&1; echo $?)"
_triggers_enumerate() { printf 'listed\tnative\tskip\t1\n'; }
resolve_dispatch_triggers >/dev/null
check "dispatch kind enumerated"    "native" "$(dispatch_kind_of listed 0)"
check "dispatch kind from state"    "native" "$(dispatch_kind_of natv 0)"
# restore the REAL seam (unset -f would delete the sourced function too)
_triggers_enumerate() {
  if [ -n "${AUTONOMY_LANE:-}" ]; then
    python3 "$ENGINE_HOME/lib/triggers.py" "$@" --lane "$AUTONOMY_LANE" 2>>"$SUPLOG"
  else
    python3 "$ENGINE_HOME/lib/triggers.py" "$@" 2>>"$SUPLOG"
  fi
}
rm -f "$LOGDIR"/.pipeline-run-*.json

# --- Task 9: the seven cutover parity invariants -------------------------------
# 1. Enumeration parity: a roles-only config enumerates exactly
#    resolve_dispatch_roles' output, same order, all kind=shim -- REAL CLIs,
#    no stubs, over a fixture with standard + custom roles.
parity="$tmp/parity"
mkdir -p "$parity/.autonomy" "$parity/var/autonomy-logs"
cat >"$parity/.autonomy/config.yaml" <<'EOF'
roles:
  coder:
    enabled: true
  docs-bot:
    enabled: true
  pm:
    enabled: true
    trigger:
      type: cron
      schedule: '0 6 * * *'
EOF
AUTONOMY_TARGET_REPO="$parity"
roles_out="$(resolve_dispatch_roles | tr '\n' ' ')"
trig_out="$(resolve_dispatch_triggers | tr '\n' ' ')"
check "parity1 same names same order" "$roles_out" "$trig_out"
kind_check=0
for _n in $trig_out; do [ "$(trigger_kind_of "$_n")" = "shim" ] || kind_check=1; done
check "parity1 every entry kind=shim" "0" "$kind_check"
AUTONOMY_TARGET_REPO="$repo"

# 2. Filename parity: a pre-cutover state file (no @, no lane) appears in
#    inflight_tokens as the bare name and round-trips to the same path.
pre="$LOGDIR/.pipeline-run-coder.json"
: >"$pre"
check "parity2 token is bare name"  "coder" "$(inflight_tokens | tr -d '\n')"
check "parity2 path round-trip"     "$pre"  "$(pipeline_state_file "$(inflight_tokens | tr -d '\n')" 0)"
rm -f "$pre"

# 4. (kind of unenumerated token = shim -- pinned above in the Task 7 block.)

# 6. Stopped trigger's token filtered; backoff-marked trigger's token filtered.
: >"$LOGDIR/.pipeline-run-coder.json"
: >"$LOGDIR/.pipeline-run-qa@1.json"
: >"$LOGDIR/.pipeline-run-ok.json"
mkdir -p "$VARDIR/trigger-ctl/stop" "$VARDIR/trigger-ctl/backoff"
: >"$VARDIR/trigger-ctl/stop/coder"
printf '%s\t1\n' "$(( $(date -u +%s) + 900 ))" >"$VARDIR/trigger-ctl/backoff/qa"
# shellcheck disable=SC2046  # intentional split: tokens are [A-Za-z0-9._-@] words
out="$(filter_dispatchable_tokens $(inflight_tokens) | sort | tr '\n' ' ')"
check "parity6 stop+backoff filtered" "ok " "$out"
printf '5\t1\n' >"$VARDIR/trigger-ctl/backoff/qa"    # expired backoff = eligible
# shellcheck disable=SC2046
out="$(filter_dispatchable_tokens $(inflight_tokens) | sort | tr '\n' ' ')"
check "parity6 expired backoff passes" "ok qa@1 " "$out"
rm -f "$VARDIR/trigger-ctl/stop/coder" "$VARDIR/trigger-ctl/backoff/qa" \
      "$LOGDIR"/.pipeline-run-*.json

# 3/5/7. Loop-wiring assertions (grep-level, per the plan): the main loop
# enumerates TRIGGERS, keeps the empty-board in-flight-only assembly, keeps
# the event path on ROLES, splits token->name for the fingerprint gate, and
# passes kind to run_session. Event-path invariant 5 is the UNCHANGED
# test_event_bus.sh suite -- run_all executes it.
sup="$ENGINE_HOME/bin/supervisor.sh"
check "loop enumerates triggers"    "1" "$(grep -c 'trig_names="\$(resolve_dispatch_triggers)"' "$sup")"
check "loop cron via triggers"      "1" "$(grep -c '^    resolve_trigger_cron_due$' "$sup")"
check "loop consumes manual fires"  "1" "$(grep -c '^    resolve_manual_fires$' "$sup")"
check "loop consumes queued fires"  "1" "$(grep -c '^    resolve_queued_fires$' "$sup")"
check "loop inflight via tokens"    "1" "$(grep -c 'inflight_list="\$(filter_dispatchable_tokens' "$sup")"
check "empty board inflight-only"   "1" "$(grep -c 'dispatch_list="\$inflight_list"' "$sup")"
# Phase C FLIP: the loop calls the TRIGGER event resolver; the legacy role
# resolver is uncalled (structural double-dispatch impossibility, parity 5 --
# test_event_bus.sh proves the same with an anchored grep).
check "event path via triggers"     "1" "$(grep -c 'resolve_trigger_event_wakes "\$session_ran"' "$sup")"
check "fp gate gets bare name"      "1" "$(grep -c 'fingerprint_gate "\$name"' "$sup")"
check "run_session gets kind"       "1" "$(grep -c 'run_session "\$role" "\$kind"; outcome=' "$sup")"
check "loop kind via state not guess" "1" "$(grep -c 'kind="\$(dispatch_kind_of "\$name"' "$sup")"
check "no coder fallback left"      "0" "$(grep -c 'dispatch_list="coder"' "$sup")"
check "error arm records backoff"   "1" "$(grep -c 'trigger_record_error_backoff "\$name"' "$sup")"
check "clean arm clears backoff"    "1" "$(grep -c 'trigger_clear_backoff "\$name"' "$sup")"

# --- Phase C (#376): WAITING protocol + child tokens + reserved sidecars ------

# A child run's state file joins the tokens as exactly ONE extra well-formed
# token (parity invariant 7)...
: >"$LOGDIR/.pipeline-run-coder.json"
: >"$LOGDIR/.pipeline-run-coder.c0.qa.json"
out="$(inflight_tokens | sort | tr '\n' ' ')"
check "child token present" "coder coder.c0.qa " "$out"

# ...and the run's SIDECARS never become tokens. They share the state-file
# glob namespace (.pipeline-run-*.json) -- latent since Phase B for
# outputs/verdict, aggravated by the Phase C outcome sidecar, which persists
# BETWEEN ticks while a parent waits. Reserved suffixes; the mint sites
# (validate_doc node ids, validate_trigger names) refuse them.
: >"$LOGDIR/.pipeline-run-coder.qa.outputs.json"
: >"$LOGDIR/.pipeline-run-coder.qa.verdict.json"
: >"$LOGDIR/.pipeline-run-coder.c0.qa.outcome.json"
out="$(inflight_tokens | sort | tr '\n' ' ')"
check "sidecars are not tokens" "coder coder.c0.qa " "$out"
rm -f "$LOGDIR"/.pipeline-run-*.json

# resolve_pipeline_ready parses the WAITING sentinel: rc 0, flag set, zero
# blocks (a wait:true call unit's child is running as its own token).
: >"$LOGDIR/.pipeline-run-coder.json"     # state exists -> no start call
python3() { echo "WAITING"; }
PIPE_WAIT=0
resolve_pipeline_ready coder 8 0 shim; rc=$?
check "waiting ready rc" "0" "$rc"
check "waiting flag set" "1" "$PIPE_WAIT"
check "waiting zero blocks" "0" "$PB_COUNT"
unset -f python3
rm -f "$LOGDIR"/.pipeline-run-*.json

# run_session treats a waiting run as the dispatch-skip family (rc 2) and
# invokes NO adapter -- stub only the established seams. The manual-fire
# tests above stubbed run_session itself; re-source the real supervisor to
# get it back (the BASH_SOURCE guard makes sourcing side-effect free), then
# re-apply this file's env. The WAITING signal reaches the REAL
# resolve_pipeline_ready through the python3 seam (redefining the function
# here would trip CI shellcheck's SC2218 on the earlier call).
# shellcheck source=/dev/null
source "$ENGINE_HOME/bin/supervisor.sh"
AUTONOMY_TARGET_REPO="$repo"
VARDIR="$repo/var"; LOGDIR="$VARDIR/autonomy-logs"
SUPLOG=/dev/null
AUTONOMY_LANE=""
log() { :; }
preflight() { return 0; }
materialize_planner() { :; }
resolve_role_dispatch() {
  ROLE_PROMPT="p"; ROLE_SCOPE=""; ROLE_MODEL=""; ROLE_EFFORT=""
  ROLE_ACCOUNT=""; ROLE_AGENT=""; return 0
}
: >"$LOGDIR/.pipeline-run-coder.json"     # state exists -> no start call
python3() { echo "WAITING"; }
run_session coder shim; rc=$?
check "waiting run_session rc is dispatch-skip" "2" "$rc"
check "waiting run_session set the flag" "1" "$PIPE_WAIT"
unset -f python3
rm -f "$LOGDIR"/.pipeline-run-*.json

# Main-loop wiring (grep-level, the file's established pattern): the waiting
# branch paces WITHOUT entering the outcome case (no error backoff, no
# fingerprint record, no session.done edge).
check "loop paces child-wait"            "1" "$(grep -c 'heartbeat "child-wait"' "$sup")"
check "loop resets PIPE_WAIT pre-dispatch" "1" "$(grep -c '^    PIPE_WAIT=0$' "$sup")"

# --- Phase C (#376) Task 8: NODE_SECRET parse + resolution + redaction --------

# The waiting tests above stubbed resolve_pipeline_ready; re-source the real
# supervisor and re-apply this file's env.
# shellcheck source=/dev/null
source "$ENGINE_HOME/bin/supervisor.sh"
AUTONOMY_TARGET_REPO="$repo"
VARDIR="$repo/var"; LOGDIR="$VARDIR/autonomy-logs"
SUPLOG=/dev/null
AUTONOMY_LANE=""
log() { :; }

# Ready-block parse: a malformed NODE_SECRET line refuses the WHOLE block
# (a session running WITHOUT a declared secret is a broken constraint
# artifact -- prevention-log #3, account-resolution parity).
: >"$LOGDIR/.pipeline-run-coder.json"
: >"$LOGDIR/.pipeline-run-coder.a.brief.md"
mk_ready_stub() {
  READY_EXTRA="$1"
  python3() {
    printf 'NODE=a\nKIND=compiled\nPROMPT=%s\nVERDICT=var/autonomy-logs/.pipeline-run-coder.a.verdict.json\n' \
      "$LOGDIR/.pipeline-run-coder.a.brief.md"
    [ -n "$READY_EXTRA" ] && printf '%s\n' "$READY_EXTRA"
    printf 'END\n'
  }
}
mk_ready_stub "NODE_SECRET=noequals"
resolve_pipeline_ready coder 8 0 shim >/dev/null 2>&1
check "NODE_SECRET malformed refuses" "1" "$?"
mk_ready_stub "NODE_SECRET=my-var=lbl"
resolve_pipeline_ready coder 8 0 shim >/dev/null 2>&1
check "NODE_SECRET bad var refuses" "1" "$?"
mk_ready_stub "NODE_SECRET=ANTHROPIC_API_KEY=x"
resolve_pipeline_ready coder 8 0 shim >/dev/null 2>&1
check "NODE_SECRET denylisted var refuses" "1" "$?"
mk_ready_stub "NODE_SECRET=MY_TOKEN=bad label"
resolve_pipeline_ready coder 8 0 shim >/dev/null 2>&1
check "NODE_SECRET bad label refuses" "1" "$?"
mk_ready_stub "NODE_SECRET=MY_TOKEN=gh-token"
resolve_pipeline_ready coder 8 0 shim; rc=$?
check "NODE_SECRET good parses" "0" "$rc"
case "${PB_SECRET[0]:-}" in
  *"MY_TOKEN=gh-token"*) check "PB_SECRET carries VAR=label" 0 0 ;;
  *) check "PB_SECRET carries VAR=label" 0 1 ;;
esac
# two blocks -> distinct per-block PB_SECRET
python3() {
  printf 'NODE=a\nKIND=compiled\nPROMPT=%s\nVERDICT=var/autonomy-logs/.pipeline-run-coder.a.verdict.json\nNODE_SECRET=TOK_A=lbl-a\nEND\n' \
    "$LOGDIR/.pipeline-run-coder.a.brief.md"
  printf 'NODE=b\nKIND=compiled\nPROMPT=%s\nVERDICT=var/autonomy-logs/.pipeline-run-coder.b.verdict.json\nNODE_SECRET=TOK_B=lbl-b\nEND\n' \
    "$LOGDIR/.pipeline-run-coder.a.brief.md"
}
resolve_pipeline_ready coder 8 0 shim
check "two-block parse rc" "0" "$?"
case "${PB_SECRET[0]:-}" in *"TOK_A=lbl-a"*) ok=0 ;; *) ok=1 ;; esac
check "block0 secret distinct" "0" "$ok"
case "${PB_SECRET[1]:-}" in *"TOK_B=lbl-b"*) ok=0 ;; *) ok=1 ;; esac
check "block1 secret distinct" "0" "$ok"
unset -f python3
rm -f "$LOGDIR"/.pipeline-run-*

# Resolution: label -> value via the AUTONOMY_CREDENTIALS_BIN seam,
# FOREGROUND, fail-safe; the VALUE never reaches the supervisor log.
SUPLOG="$tmp/sup.log"; : >"$SUPLOG"
log() { printf '%s\n' "$*" >>"$SUPLOG"; }
cred_ok="$tmp/cred_ok"
printf '#!/bin/sh\n[ "$1" = get ] || exit 1\necho s3cr3t-value\n' >"$cred_ok"
chmod +x "$cred_ok"
cred_missing="$tmp/cred_missing"
printf '#!/bin/sh\nexit 1\n' >"$cred_missing"
chmod +x "$cred_missing"
cred_multiline="$tmp/cred_multiline"
printf '#!/bin/sh\nprintf "a\\nb\\n"\n' >"$cred_multiline"
chmod +x "$cred_multiline"

AUTONOMY_CREDENTIALS_BIN="$cred_ok"
if resolve_node_secret_env "MY_TOKEN=gh-token" "A=1"; then rc=0; else rc=1; fi
check "secret resolves rc" "0" "$rc"
case "$NS_ENV_LINES" in *"MY_TOKEN=s3cr3t-value"*) ok=0 ;; *) ok=1 ;; esac
check "secret env line built" "0" "$ok"
case "$NS_VALUES" in *"s3cr3t-value"*) ok=0 ;; *) ok=1 ;; esac
check "secret value collected for redaction" "0" "$ok"

AUTONOMY_CREDENTIALS_BIN="$cred_missing"
if resolve_node_secret_env "MY_TOKEN=gh-token" ""; then rc=0; else rc=1; fi
check "missing secret refuses" "1" "$rc"
check "missing secret clears env lines" "" "$NS_ENV_LINES"

AUTONOMY_CREDENTIALS_BIN="$cred_ok"
if resolve_node_secret_env "MY_TOKEN=gh-token" "MY_TOKEN=already"; then rc=0; else rc=1; fi
check "dup of auth env var refuses" "1" "$rc"
if resolve_node_secret_env "MY_TOKEN=gh-token" "A=1
MY_TOKEN=already"; then rc=0; else rc=1; fi
check "dup on later auth line refuses" "1" "$rc"

AUTONOMY_CREDENTIALS_BIN="$cred_multiline"
if resolve_node_secret_env "MY_TOKEN=gh-token" ""; then rc=0; else rc=1; fi
check "newline-bearing value refuses" "1" "$rc"

case "$(cat "$SUPLOG")" in
  *s3cr3t-value*) check "value never logged" 0 1 ;;
  *) check "value never logged" 0 0 ;;
esac
case "$(cat "$SUPLOG")" in
  *gh-token*) check "label IS loggable (SD-8)" 0 0 ;;
  *) check "label IS loggable (SD-8)" 0 1 ;;
esac

# Redaction sweep: every resolved value replaced with [REDACTED]; runs
# after classify (the outcome grep must see the raw log).
printf 'before s3cr3t-value after\n' >"$LOGDIR/s.log"
NS_VALUES="s3cr3t-value
"
redact_session_log "$LOGDIR/s.log"
case "$(cat "$LOGDIR/s.log")" in
  *s3cr3t-value*) check "redaction scrubs value" 0 1 ;;
  *"[REDACTED]"*) check "redaction scrubs value" 0 0 ;;
  *) check "redaction scrubs value" 0 1 ;;
esac
# empty NS_VALUES = no-op, never an error
NS_VALUES=""
redact_session_log "$LOGDIR/s.log"
check "redaction no-op rc" "0" "$?"
# prefix shadowing (CP2): a shorter value that PREFIXES a longer one must
# not leave the longer one's tail in the log -- longest replaced first.
printf 'x abcdef y abc z\n' >"$LOGDIR/p.log"
NS_VALUES="abc
abcdef
"
redact_session_log "$LOGDIR/p.log"
case "$(cat "$LOGDIR/p.log")" in
  *def*) check "prefix-shadowed value fully scrubbed" 0 1 ;;
  *) check "prefix-shadowed value fully scrubbed" 0 0 ;;
esac
unset AUTONOMY_CREDENTIALS_BIN
SUPLOG=/dev/null
log() { :; }

echo
if [ "$fails" -gt 0 ]; then echo "$fails FAILURE(S)"; exit 1; fi
echo "ALL CHECKS PASS"
