### Task 8: `supervisor.sh` — the generic engine loop

**Files:**
- Create: `bin/supervisor.sh`
- Test: `tests/test_preflight_recovery.sh`
- Test: `tests/test_agent_dispatch.sh`

**Interfaces:**
- Consumes: `doctor_preflight_check` (Task 4), `agent_invoke`/`agent_classify_outcome` from
  `bin/agents/${AGENT_TYPE}.sh` (Task 3 for `claude`), `python3 lib/config_parser.py` (Task 2).
- Produces: CLI `bin/supervisor.sh --repo <path> [--agent-type ...] [--model ...]
  [--fallback-model ...] [--label ...]` — the main entry point launchd runs. Defines
  `resolve_config_value(config_file, config_key, cli_override, hardcoded_default)`,
  `preflight()`, `run_session()`, `compute_limit_wait()` as testable functions.

- [ ] **Step 1: Write the failing tests**

```bash
# tests/test_preflight_recovery.sh
#!/usr/bin/env bash
# Scenario test for supervisor.sh preflight() against a throwaway repo.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
source "$HERE/../bin/supervisor.sh"
SUPLOG=/dev/null
log() { :; }

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
origin="$tmp/origin.git"; work="$tmp/work"
git init -q --bare "$origin"
git -c init.defaultBranch=main init -q "$work"
cd "$work" || exit 1
git config user.email "t@t.t"; git config user.name "t"
mkdir -p .autonomy
cat > .autonomy/config.yaml <<'YAML'
engine:
  requires_claude_md: false
YAML
git add .autonomy/config.yaml
git commit -q -m init
git branch -M main
git remote add origin "$origin"
git push -q -u origin main 2>/dev/null

AUTONOMY_TARGET_REPO="$work"
RESET_STATE="$tmp/.last_usage_reset"

dirty_skips=0
preflight; rc=$?
check "clean tree proceeds" 0 "$rc"
check "clean tree leaves counter 0" 0 "$dirty_skips"
check "preflight detaches HEAD (no branch ref)" "" "$(git symbolic-ref -q --short HEAD || echo '')"
check "preflight HEAD == origin/main" "$(git rev-parse origin/main)" "$(git rev-parse HEAD)"

dirty_skips=0
echo "wip" > wip.txt
preflight; rc=$?
check "1st dirty skip returns 2 (grace)" 2 "$rc"
check "1st dirty skip increments counter" 1 "$dirty_skips"
check "1st dirty skip does NOT stash" 0 "$(git stash list | wc -l | tr -d ' ')"

preflight; rc=$?
check "K-th dirty skip proceeds (0)" 0 "$rc"
check "K-th dirty skip resets counter" 0 "$dirty_skips"
check "K-th dirty skip created a stash" 1 "$(git stash list | wc -l | tr -d ' ')"
check "K-th dirty skip stash message tagged" 1 "$(git stash list | grep -c 'autonomy-preflight-recovery')"
check "tree clean after recovery" "" "$(git status --porcelain)"
git stash drop -q 2>/dev/null

dirty_skips=5
echo "midrevert" > wip2.txt
: > "$(git rev-parse --git-dir)/REVERT_HEAD"
preflight; rc=$?
check "in-progress op returns 2" 2 "$rc"
check "in-progress op does NOT stash" 0 "$(git stash list | wc -l | tr -d ' ')"
rm -f "$(git rev-parse --git-dir)/REVERT_HEAD" wip2.txt

dirty_skips=0
echo "wip3" > wip3.txt
preflight >/dev/null 2>&1
check "counter is 1 after one dirty skip" 1 "$dirty_skips"
rm -f wip3.txt
preflight; rc=$?
check "clean observation resets counter" 0 "$dirty_skips"
check "clean observation proceeds (0)" 0 "$rc"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
```

```bash
# tests/test_agent_dispatch.sh
#!/usr/bin/env bash
# Unit test for supervisor.sh's config precedence (CLI override > config.yaml
# > hardcoded default) and that the correct adapter file exists per agent.type.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../bin/supervisor.sh"
SUPLOG=/dev/null
log() { :; }

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cfg="$tmp/config.yaml"
cat > "$cfg" <<'YAML'
agent:
  type: claude
  model:
    primary: claude-sonnet-5
    fallback: claude-sonnet-4-6
YAML

check "CLI override wins over config" "codex" "$(resolve_config_value "$cfg" agent.type "codex" claude)"
check "config wins over hardcoded default" "claude" "$(resolve_config_value "$cfg" agent.type "" opus)"
check "hardcoded default wins when key absent" "claude-opus-4-8" "$(resolve_config_value "$cfg" agent.model.does_not_exist "" claude-opus-4-8)"
check "claude adapter file exists" "0" "$([ -f "$HERE/../bin/agents/claude.sh" ] && echo 0 || echo 1)"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
```

- [ ] **Step 2: Run both to verify they fail**

```bash
chmod +x tests/test_preflight_recovery.sh tests/test_agent_dispatch.sh
bash tests/test_preflight_recovery.sh
bash tests/test_agent_dispatch.sh
```
Expected: both fail (`bin/supervisor.sh` doesn't exist yet).

- [ ] **Step 3: Implement `bin/supervisor.sh`**

```bash
#!/usr/bin/env bash
# bin/supervisor.sh -- generic, repo-agnostic autonomy SUPERVISOR. Runs
# board-drain sessions back-to-back for days, unattended, with usage-limit
# backoff, against WHATEVER target repo is passed via --repo.
#
# Usage:
#   supervisor.sh --repo <path> [--agent-type claude|codex] [--model <id>]
#                 [--fallback-model <id>] [--label <slug>]
#
# --repo is required. Everything else defaults from the target repo's
# .autonomy/config.yaml, or this script's own hardcoded defaults if the pack
# doesn't set it. CLI flags override config.yaml for THIS invocation only --
# config.yaml is never edited by a flag.
set -uo pipefail
ENGINE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export AUTONOMY_ENGINE_HOME="$ENGINE_HOME"

# shellcheck source=/dev/null
source "$ENGINE_HOME/bin/doctor.sh"

CONFIG_GET() { python3 "$ENGINE_HOME/lib/config_parser.py" "$1" "$2" 2>/dev/null; }

# Resolve a config value with CLI-override precedence: CLI override > pack's
# config.yaml > hardcoded default. Empty CLI override means "not passed".
resolve_config_value() {
  local config_file="$1" config_key="$2" cli_override="$3" hardcoded_default="$4"
  if [ -n "$cli_override" ]; then printf '%s' "$cli_override"; return; fi
  local from_config
  from_config="$(CONFIG_GET "$config_file" "$config_key")"
  if [ -n "$from_config" ]; then printf '%s' "$from_config"; return; fi
  printf '%s' "$hardcoded_default"
}

# --- timing knobs (seconds) ---
PACE=120
EMPTY_IDLE=1800
ERR_BACKOFF_START=300; ERR_BACKOFF_MAX=3600
LIMIT_BACKOFF_START=1800; LIMIT_BACKOFF_MAX=18000
LIMIT_RESET_MAX_HORIZON=691200
PREFLIGHT_RECOVERY_AFTER=2
dirty_skips=0

log() {
  local prefix=""
  [ -n "${LABEL:-}" ] && prefix="[$LABEL] "
  echo "$(date -u +%FT%TZ) ${prefix}$*" | tee -a "$SUPLOG"
}

preflight() {
  cd "$AUTONOMY_TARGET_REPO" || { log "preflight: cannot cd to $AUTONOMY_TARGET_REPO"; return 2; }

  if ! doctor_preflight_check "$AUTONOMY_TARGET_REPO"; then
    log "preflight: .autonomy/ pack invalid or incomplete -- abort"
    return 2
  fi

  local gitdir; gitdir="$(git rev-parse --git-dir 2>/dev/null || echo .git)"
  if [ -d "$gitdir/rebase-merge" ] || [ -d "$gitdir/rebase-apply" ] \
     || [ -f "$gitdir/CHERRY_PICK_HEAD" ] || [ -f "$gitdir/MERGE_HEAD" ] \
     || [ -f "$gitdir/REVERT_HEAD" ] || [ -f "$gitdir/BISECT_LOG" ]; then
    log "preflight: rebase/cherry-pick/merge/revert/bisect in progress -- skip (needs a human)"; return 2
  fi

  if [ -n "$(git status --porcelain)" ]; then
    dirty_skips=$((dirty_skips + 1))
    if [ "$dirty_skips" -lt "$PREFLIGHT_RECOVERY_AFTER" ]; then
      log "preflight: tree dirty -- skip ${dirty_skips}/${PREFLIGHT_RECOVERY_AFTER} (won't checkout over uncommitted work yet)"
      return 2
    fi
    local stash_msg; stash_msg="autonomy-preflight-recovery $(date -u +%FT%TZ)"
    if ! git stash push -u -m "$stash_msg" >>"$SUPLOG" 2>&1; then
      log "preflight: tree dirty ${dirty_skips}x but 'git stash' FAILED -- cannot auto-recover; skip (needs a human)"; return 2
    fi
    if [ -n "$(git status --porcelain)" ]; then
      log "preflight: stashed WIP but tree still dirty -- cannot auto-recover; skip (needs a human)"; return 2
    fi
    log "preflight: tree dirty ${dirty_skips}x -- stashed WIP ('$stash_msg'; recover via 'git stash list') and proceeding onto main"
  fi
  dirty_skips=0

  git fetch origin -q 2>>"$SUPLOG" || { log "preflight: fetch failed"; return 2; }
  git switch --detach origin/main -q 2>>"$SUPLOG" || { log "preflight: switch to origin/main failed"; return 2; }
  [ -z "$(git status --porcelain)" ] || { log "preflight: tree dirty on origin/main -- skip"; return 2; }
  return 0
}

compute_limit_wait() {
  [ -f "$RESET_STATE" ] || return 1
  local reset now
  reset="$(cat "$RESET_STATE" 2>/dev/null)"
  case "$reset" in
    ''|*[!0-9]*) return 1 ;;
  esac
  now="$(date +%s)"
  if [ "$reset" -gt "$now" ] && [ "$reset" -le "$((now + LIMIT_RESET_MAX_HORIZON))" ]; then
    echo "$((reset - now))"
    return 0
  fi
  return 1
}

run_session() {
  preflight || return $?

  # shellcheck source=/dev/null
  source "$ENGINE_HOME/bin/agents/${AGENT_TYPE}.sh"

  local log_file; log_file="$LOGDIR/session-$(date +%Y%m%dT%H%M%S).log"
  log "session start -> $log_file"

  agent_invoke \
    "$AUTONOMY_TARGET_REPO/.autonomy/loop_prompt.md" \
    "$AUTONOMY_TARGET_REPO/.autonomy/hard_rules.md" \
    "$MODEL" "$FALLBACK_MODEL" "$log_file"
  local rc=$?

  local outcome; outcome="$(agent_classify_outcome "$log_file" "$rc")"
  case "$outcome" in
    success)
      return 0 ;;
    usage_limit*)
      local epoch="${outcome#usage_limit }"
      if [ "$epoch" != "usage_limit" ] && [ -n "$epoch" ]; then
        printf '%s\n' "$epoch" >"$RESET_STATE"
      fi
      return 3 ;;
    *)
      if compute_limit_wait >/dev/null; then return 3; fi
      return "$rc" ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  AUTONOMY_TARGET_REPO=""
  AGENT_TYPE_OVERRIDE=""
  MODEL_OVERRIDE=""
  FALLBACK_MODEL_OVERRIDE=""
  LABEL_OVERRIDE=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --repo) AUTONOMY_TARGET_REPO="$2"; shift 2 ;;
      --agent-type) AGENT_TYPE_OVERRIDE="$2"; shift 2 ;;
      --model) MODEL_OVERRIDE="$2"; shift 2 ;;
      --fallback-model) FALLBACK_MODEL_OVERRIDE="$2"; shift 2 ;;
      --label) LABEL_OVERRIDE="$2"; shift 2 ;;
      *) echo "unknown argument: $1" >&2; exit 1 ;;
    esac
  done

  [ -n "$AUTONOMY_TARGET_REPO" ] || { echo "usage: supervisor.sh --repo <path> [--agent-type ...] [--model ...] [--fallback-model ...] [--label ...]" >&2; exit 1; }
  [ -d "$AUTONOMY_TARGET_REPO" ] || { echo "supervisor.sh: --repo path does not exist: $AUTONOMY_TARGET_REPO" >&2; exit 1; }
  AUTONOMY_TARGET_REPO="$(cd "$AUTONOMY_TARGET_REPO" && pwd)"
  export AUTONOMY_TARGET_REPO

  VARDIR="$AUTONOMY_TARGET_REPO/var"
  LOGDIR="$VARDIR/autonomy-logs"
  mkdir -p "$LOGDIR"
  SUPLOG="$LOGDIR/supervisor.log"
  RESET_STATE="$LOGDIR/.last_usage_reset"
  LABEL="$LABEL_OVERRIDE"

  CFG="$AUTONOMY_TARGET_REPO/.autonomy/config.yaml"
  AGENT_TYPE="$(resolve_config_value "$CFG" agent.type "$AGENT_TYPE_OVERRIDE" claude)"
  MODEL="$(resolve_config_value "$CFG" agent.model.primary "$MODEL_OVERRIDE" claude-sonnet-5)"
  FALLBACK_MODEL="$(resolve_config_value "$CFG" agent.model.fallback "$FALLBACK_MODEL_OVERRIDE" claude-sonnet-4-6)"

  LOCK="$VARDIR/autonomy-supervisor.lock"
  if ! mkdir "$LOCK" 2>/dev/null; then
    pid="$(cat "$LOCK/pid" 2>/dev/null || echo)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      log "supervisor already running (pid $pid); exiting."; exit 0
    fi
    rm -rf "$LOCK"; mkdir "$LOCK" || { log "lost lock race; exiting."; exit 0; }
  fi
  echo $$ >"$LOCK/pid"
  trap 'rm -rf "$LOCK"; log "supervisor stopped."; exit 0' EXIT INT TERM

  log "=== supervisor start (pid $$, repo=$AUTONOMY_TARGET_REPO, agent=$AGENT_TYPE, model=$MODEL) ==="
  err_backoff=$ERR_BACKOFF_START
  limit_backoff=$LIMIT_BACKOFF_START

  while true; do
    open_count="$(cd "$AUTONOMY_TARGET_REPO" && gh issue list --state open --json number -q 'length' 2>/dev/null || echo -1)"
    if [ "$open_count" = "0" ]; then
      dirty_skips=0
      log "board empty -- idle ${EMPTY_IDLE}s"; sleep "$EMPTY_IDLE"; continue
    fi

    run_session; outcome=$?
    case $outcome in
      0) log "session clean (open issues ~$open_count). pace ${PACE}s"
         err_backoff=$ERR_BACKOFF_START; limit_backoff=$LIMIT_BACKOFF_START
         rm -f "$RESET_STATE"
         sleep "$PACE" ;;
      3) jitter=$((RANDOM % 120))
         if reset_wait="$(compute_limit_wait)"; then
           reset_wait=$((reset_wait + jitter))
           log "USAGE LIMIT -- sleeping ${reset_wait}s until API-reported reset, then retry"
           sleep "$reset_wait"
           limit_backoff=$LIMIT_BACKOFF_START
         else
           log "USAGE LIMIT (no reset signal) -- exp backoff $((limit_backoff + jitter))s then retry"
           sleep $((limit_backoff + jitter))
           limit_backoff=$(( limit_backoff*2 < LIMIT_BACKOFF_MAX ? limit_backoff*2 : LIMIT_BACKOFF_MAX ))
         fi ;;
      2) log "preflight skip -- wait ${ERR_BACKOFF_START}s"; sleep "$ERR_BACKOFF_START" ;;
      *) log "session error (rc=$outcome) -- backoff ${err_backoff}s"
         sleep "$err_backoff"
         err_backoff=$(( err_backoff*2 < ERR_BACKOFF_MAX ? err_backoff*2 : ERR_BACKOFF_MAX )) ;;
    esac
  done
fi
```

- [ ] **Step 4: Run both tests to verify they pass**

```bash
bash tests/test_preflight_recovery.sh
bash tests/test_agent_dispatch.sh
```
Expected: both `ALL PASS`.

- [ ] **Step 5: shellcheck**

```bash
shellcheck -S warning bin/supervisor.sh
```
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add bin/supervisor.sh tests/test_preflight_recovery.sh tests/test_agent_dispatch.sh
git commit -m "feat: add generic supervisor.sh (--repo, agent-adapter dispatch, config precedence)"
git push
```

---

