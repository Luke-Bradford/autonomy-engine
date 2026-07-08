#!/bin/bash
# Pipeline runner wiring (#345): run_session drives lib/pipeline.py --
# wrapped legacy roles byte-equivalent, bound pipelines walk one node per
# call, invalid bindings REFUSE, usage_limit retries, journal written.
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

# --- fake target repo pack ---------------------------------------------------
repo="$tmp/repo"
mkdir -p "$repo/.autonomy/pipelines/flow" "$repo/var/autonomy-logs"
printf 'engine:\n  label: t\n' >"$repo/.autonomy/config.yaml"
printf 'LEGACY PROMPT BODY\n' >"$repo/.autonomy/loop_prompt.md"
printf 'hard rules\n' >"$repo/.autonomy/hard_rules.md"

# --- stub adapter: records its argv, emits configured outcome ----------------
agents="$tmp/agents"
mkdir -p "$agents"
cat >"$agents/stub.sh" <<'EOF'
agent_invoke() {
  printf '%s\n' "$1" >"${STUB_CALLS:?}/prompt_file"
  printf '%s\n' "$2" >"${STUB_CALLS}/rules_file"
  return 0
}
agent_classify_outcome() { printf '%s' "${STUB_OUTCOME:-success}"; }
EOF
export AUTONOMY_AGENTS_DIR="$agents"
export STUB_CALLS="$tmp/calls"; mkdir -p "$STUB_CALLS"

# --- source the real supervisor ----------------------------------------------
# shellcheck source=/dev/null
source "$ENGINE_HOME/bin/supervisor.sh"
AUTONOMY_TARGET_REPO="$repo"
VARDIR="$repo/var"; LOGDIR="$VARDIR/autonomy-logs"
SUPLOG=/dev/null
RESET_STATE="$LOGDIR/.last_usage_reset"   # set -u safety: normally the main guard's job
log() { :; }
heartbeat() { :; }
preflight() { return 0; }
materialize_planner() { :; }
resolve_session_settings() { MODEL=test-model; FALLBACK_MODEL=test-fb; EFFORT=""; }
resolve_role_credential() { printf ''; }
compute_limit_wait() { return 1; }        # no active limit window in these tests
AGENT_TYPE=stub
STUB_OUTCOME=""

# 1. wrapped legacy role: same prompt file as the pre-pipeline engine ----------
run_session coder; rc=$?
check "wrapped run_session rc" "0" "$rc"
check "wrapped prompt byte-path equivalence" "$repo/.autonomy/loop_prompt.md" \
  "$(cat "$STUB_CALLS/prompt_file")"
check "state cleaned after 1-node run" "1" \
  "$([ ! -f "$(pipeline_state_file coder)" ] && echo 1 || echo 0)"
jl="$(wc -l <"$LOGDIR/journal.jsonl" | tr -d ' ')"
check "journal has one line" "1" "$jl"
check "journal pass true" "1" \
  "$(grep -c '"pass": true' "$LOGDIR/journal.jsonl")"

# 2. bound two-node pipeline: one node per run_session call --------------------
cat >"$repo/.autonomy/pipelines/flow/pipeline.json" <<'EOF'
{"name": "flow", "version": 1, "caps": {"max_sessions_per_run": 5},
 "nodes": [{"id": "a", "type": "pick", "brief_ref": "a.md"},
           {"id": "b", "type": "summarize", "brief_ref": "b.md"}],
 "edges": [], "containers": []}
EOF
printf 'BRIEF A\n' >"$repo/.autonomy/pipelines/flow/a.md"
printf 'BRIEF B\n' >"$repo/.autonomy/pipelines/flow/b.md"
printf 'roles:\n  coder:\n    enabled: true\n    pipeline: flow\n' \
  >"$repo/.autonomy/config.yaml"

run_session coder; rc=$?
check "bound node-a rc" "0" "$rc"
brief_file="$LOGDIR/.pipeline-run-coder.brief.md"
check "node-a compiled brief used" "$brief_file" \
  "$(cat "$STUB_CALLS/prompt_file")"
check "brief carries node a body" "1" \
  "$(grep -c 'BRIEF A' "$brief_file")"
check "state persists mid-run" "1" \
  "$([ -f "$(pipeline_state_file coder)" ] && echo 1 || echo 0)"
check "pipeline_inflight sees it" "0" "$(pipeline_inflight coder; echo $?)"
check "any_pipeline_inflight sees it" "0" "$(any_pipeline_inflight; echo $?)"

run_session coder; rc=$?
check "bound node-b rc" "0" "$rc"
check "brief carries node b body" "1" \
  "$(grep -c 'BRIEF B' "$brief_file")"
check "state cleaned after final node" "1" \
  "$([ ! -f "$(pipeline_state_file coder)" ] && echo 1 || echo 0)"
check "journal now two lines" "2" "$(wc -l <"$LOGDIR/journal.jsonl" | tr -d ' ')"

# 3. usage_limit: state intact, no record, same node next time -----------------
run_session coder >/dev/null 2>&1   # fresh run, executes node a (success)
STUB_OUTCOME="usage_limit"
run_session coder >/dev/null 2>&1; rc=$?
STUB_OUTCOME=""
check "usage_limit rc 3" "3" "$rc"
check "usage_limit leaves state intact" "1" \
  "$([ -f "$(pipeline_state_file coder)" ] && echo 1 || echo 0)"
check "journal unchanged on usage_limit" "2" \
  "$(wc -l <"$LOGDIR/journal.jsonl" | tr -d ' ')"
rm -f "$(pipeline_state_file coder)"   # reset for the next scenario

# 4. adapter error: run fails, journal pass=false, state cleaned ---------------
STUB_OUTCOME="error"
run_session coder >/dev/null 2>&1
STUB_OUTCOME=""
check "error run journals pass=false" "1" \
  "$(grep -c '"pass": false' "$LOGDIR/journal.jsonl")"
check "error run cleans state" "1" \
  "$([ ! -f "$(pipeline_state_file coder)" ] && echo 1 || echo 0)"

# 5. error during an ACTIVE limit window: rc 3, state intact, no record --------
run_session coder >/dev/null 2>&1   # fresh run, node a success, state persists
compute_limit_wait() { echo 60; return 0; }
STUB_OUTCOME="error"
run_session coder >/dev/null 2>&1; rc=$?
STUB_OUTCOME=""
compute_limit_wait() { return 1; }
check "limit-window error rc 3" "3" "$rc"
check "limit-window error leaves state intact (no run destroyed)" "1" \
  "$([ -f "$(pipeline_state_file coder)" ] && echo 1 || echo 0)"
rm -f "$(pipeline_state_file coder)"

# 6. bound-but-missing pipeline REFUSES (rc 2), nothing invoked -----------------
printf 'roles:\n  coder:\n    enabled: true\n    pipeline: ghost\n' \
  >"$repo/.autonomy/config.yaml"
rm -f "$STUB_CALLS/prompt_file"
run_session coder >/dev/null 2>&1; rc=$?
check "invalid binding rc 2 (REFUSE, no legacy fallback)" "2" "$rc"
check "invalid binding never invoked the agent" "1" \
  "$([ ! -f "$STUB_CALLS/prompt_file" ] && echo 1 || echo 0)"

# 7. no state -> helpers report not-inflight ------------------------------------
check "pipeline_inflight none" "1" "$(pipeline_inflight coder; echo $?)"
check "any_pipeline_inflight none" "1" "$(any_pipeline_inflight; echo $?)"

# 8. lane-scoped state path (one supervisor per lane shares LOGDIR) -------------
AUTONOMY_LANE="alpha"
check "lane-scoped state filename" "$LOGDIR/.pipeline-run-coder--alpha.json" \
  "$(pipeline_state_file coder)"
check "lane-scoped verdict filename" \
  "$LOGDIR/.pipeline-run-coder--alpha.verdict.json" \
  "$(pipeline_verdict_file coder)"
AUTONOMY_LANE=""

echo
if [ "$fails" -eq 0 ]; then echo "ALL CHECKS PASS"; exit 0; fi
echo "$fails CHECK(S) FAILED"; exit 1
