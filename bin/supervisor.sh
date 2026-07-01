#!/usr/bin/env bash
# bin/supervisor.sh -- generic, repo-agnostic autonomy SUPERVISOR. Runs
# board-drain sessions back-to-back for days, unattended, with usage-limit
# backoff, against WHATEVER target repo is passed via --repo.
#
# Usage:
#   supervisor.sh --repo <path> [--agent-type claude|codex] [--model <id>]
#                 [--fallback-model <id>] [--effort <level>] [--label <slug>]
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
PAUSE_POLL=30
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

# --- live model/effort settings (#24) ---------------------------------------
# Strict token check for model ids -- the value came over the dashboard's
# control channel and lands in a CLI argv; nothing shell-metacharish allowed.
# Kept in PARITY with dashboard_control._MODEL_RE (start alnum, allowed set,
# max 64 chars) so the defense-in-depth line is as strict as the first.
# (In the negated bracket set `]` must come first.)
valid_model_id() {
  case "$1" in
    '') return 1 ;;
    [!A-Za-z0-9]*) return 1 ;;
    *[!]A-Za-z0-9._[-]*) return 1 ;;
  esac
  [ "${#1}" -le 64 ]
}

# The claude CLI's accepted effort levels (verified against the CLI itself).
valid_effort() {
  case "$1" in low|medium|high|xhigh|max) return 0 ;; *) return 1 ;; esac
}

# Resolve model/fallback/effort PER SESSION (not once at startup), so a config
# edit -- including the dashboard's 'save as default' write-back -- takes
# effect on the next session without a supervisor restart.
resolve_session_settings() {
  MODEL="$(resolve_config_value "$CFG" agent.model.primary "$MODEL_OVERRIDE" claude-sonnet-5)"
  FALLBACK_MODEL="$(resolve_config_value "$CFG" agent.model.fallback "$FALLBACK_MODEL_OVERRIDE" claude-sonnet-4-6)"
  EFFORT="$(resolve_config_value "$CFG" agent.effort "$EFFORT_OVERRIDE" "")"
  consume_model_override "$LOGDIR/model-override"
}

# One-shot override file the dashboard writes ('next session only' scope):
# key=value lines (model= / fallback= / effort=). Values are validated here
# again (defense in depth) and the file is ALWAYS deleted -- valid or not --
# so it can never apply twice or wedge the loop.
consume_model_override() {
  local override_file="$1" line key val
  [ -f "$override_file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    key="${line%%=*}"; val="${line#*=}"
    case "$key" in
      model)
        if valid_model_id "$val"; then MODEL="$val"
        else log "model-override: invalid model id ignored"; fi ;;
      fallback)
        if valid_model_id "$val"; then FALLBACK_MODEL="$val"
        else log "model-override: invalid fallback id ignored"; fi ;;
      effort)
        if valid_effort "$val"; then EFFORT="$val"
        else log "model-override: invalid effort ignored (valid: low|medium|high|xhigh|max)"; fi ;;
    esac
  done <"$override_file"
  rm -f "$override_file"
  log "model-override consumed (one session): model=$MODEL effort=${EFFORT:-default}"
}

# Graceful-stop sentinel. If this file exists at the top of the loop the
# supervisor finishes the current session (this predicate is only checked
# BEFORE run_session, never mid-session) then idles until it's removed --
# distinct from a hard stop (launchctl bootout). Removing the file resumes.
# File-only: a directory at the path is not a pause request.
pause_requested() {
  [ -f "$1" ]
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

  resolve_session_settings

  local log_file; log_file="$LOGDIR/session-$(date +%Y%m%dT%H%M%S).log"
  log "session start (model=$MODEL effort=${EFFORT:-default}) -> $log_file"

  agent_invoke \
    "$AUTONOMY_TARGET_REPO/.autonomy/loop_prompt.md" \
    "$AUTONOMY_TARGET_REPO/.autonomy/hard_rules.md" \
    "$MODEL" "$FALLBACK_MODEL" "$log_file" "$EFFORT"
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
  EFFORT_OVERRIDE=""
  LABEL_OVERRIDE=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --repo) AUTONOMY_TARGET_REPO="$2"; shift 2 ;;
      --agent-type) AGENT_TYPE_OVERRIDE="$2"; shift 2 ;;
      --model) MODEL_OVERRIDE="$2"; shift 2 ;;
      --fallback-model) FALLBACK_MODEL_OVERRIDE="$2"; shift 2 ;;
      --effort) EFFORT_OVERRIDE="$2"; shift 2 ;;
      --label) LABEL_OVERRIDE="$2"; shift 2 ;;
      *) echo "unknown argument: $1" >&2; exit 1 ;;
    esac
  done

  [ -n "$AUTONOMY_TARGET_REPO" ] || { echo "usage: supervisor.sh --repo <path> [--agent-type ...] [--model ...] [--fallback-model ...] [--effort ...] [--label ...]" >&2; exit 1; }
  [ -d "$AUTONOMY_TARGET_REPO" ] || { echo "supervisor.sh: --repo path does not exist: $AUTONOMY_TARGET_REPO" >&2; exit 1; }
  AUTONOMY_TARGET_REPO="$(cd "$AUTONOMY_TARGET_REPO" && pwd)"
  export AUTONOMY_TARGET_REPO

  VARDIR="$AUTONOMY_TARGET_REPO/var"
  LOGDIR="$VARDIR/autonomy-logs"
  mkdir -p "$LOGDIR"
  SUPLOG="$LOGDIR/supervisor.log"
  RESET_STATE="$LOGDIR/.last_usage_reset"
  PAUSE_SENTINEL="$LOGDIR/autonomy-PAUSE"
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
  paused_logged=0

  while true; do
    # Graceful stop: checked at the top so any in-flight session has already
    # finished (never a mid-session kill). Idle-poll until the sentinel is
    # removed (resume). Under launchd KeepAlive=true, exiting would just be
    # relaunched -- idling is the only stop that actually holds.
    if pause_requested "$PAUSE_SENTINEL"; then
      if [ "$paused_logged" -eq 0 ]; then
        log "PAUSE sentinel present ($PAUSE_SENTINEL) -- graceful stop: current session finished, idling (remove to resume)"
        paused_logged=1
      fi
      sleep "$PAUSE_POLL"; continue
    fi
    if [ "$paused_logged" -eq 1 ]; then
      log "PAUSE sentinel gone -- resuming"
      paused_logged=0
    fi

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
