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
unset -f _triggers_enumerate

echo
if [ "$fails" -gt 0 ]; then echo "$fails FAILURE(S)"; exit 1; fi
echo "ALL CHECKS PASS"
