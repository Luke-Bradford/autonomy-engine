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

# Defense-in-depth re-validation of a role's `prompt:` path at dispatch time.
# doctor.sh's check_prompt_files (lib/roles.py) already rejects absolute or
# repo-escaping prompt paths every preflight, but re-checking here -- parity
# with how valid_model_id re-checks a config-sourced model id -- keeps the
# supervisor self-contained: the value lands in a filename below, so a doctor
# bypass must not let an absolute or `..`-escaping path through. Reject empty,
# absolute, and any real `..` path segment (a dotted FILENAME like `..x.md` is
# fine -- only `..` as a whole component traverses).
valid_prompt_path() {
  case "$1" in
    '') return 1 ;;
    /*) return 1 ;;                    # absolute
    ..|../*|*/..|*/../*) return 1 ;;    # parent-dir segment anywhere
    *) return 0 ;;
  esac
}

# Resolve model/fallback/effort PER SESSION (not once at startup), so a config
# edit -- including the dashboard's 'save as default' write-back -- takes
# effect on the next session without a supervisor restart. Role-level
# model/effort (ROLE_MODEL/ROLE_EFFORT, set by resolve_role_dispatch) sit
# between the CLI flag and config.yaml: CLI > role > agent.* > default. The
# one-shot dashboard override is applied last and wins for its one session.
resolve_session_settings() {
  MODEL="$(resolve_config_value "$CFG" agent.model.primary "${MODEL_OVERRIDE:-${ROLE_MODEL:-}}" claude-sonnet-5)"
  FALLBACK_MODEL="$(resolve_config_value "$CFG" agent.model.fallback "$FALLBACK_MODEL_OVERRIDE" claude-sonnet-4-6)"
  EFFORT="$(resolve_config_value "$CFG" agent.effort "${EFFORT_OVERRIDE:-${ROLE_EFFORT:-}}" "")"
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

# --- account-level shared usage-limit state (#3) ----------------------------
# One Anthropic account serves every supervisor on this machine: a reset
# epoch discovered by any one loop is written to a shared, account-keyed
# marker as well as the repo-local file, so parallel supervisors back off
# together instead of stampeding into the same wall. The supervisor remains
# the SOLE writer (adapters only extract); the shared write is best-effort
# and every read is validated per-file, so a torn/garbage/stale marker can
# never block or extend a loop incorrectly (fail-safe).

# engine.account_key from config.yaml names WHICH account's marker this repo
# shares ('default' when unset -- one operator, one account). The value lands
# in a filename: anything outside [A-Za-z0-9._-] falls back to 'default'.
resolve_account_key() {
  local key
  key="$(resolve_config_value "$CFG" engine.account_key "" default)"
  case "$key" in
    "") key=default ;;
    *[!A-Za-z0-9._-]*)
      log "WARN engine.account_key '$key' has characters outside [A-Za-z0-9._-] -- using 'default'"
      key=default ;;
  esac
  printf '%s' "$key"
}

# Shared marker path: $AUTONOMY_SHARED_STATE_DIR override (tests) >
# ~/.config/autonomy (the engine's established per-operator config dir) >
# empty = repo-local-only mode (no HOME, e.g. a bare daemon context).
resolve_shared_reset_state() {
  local dir="${AUTONOMY_SHARED_STATE_DIR:-}"
  if [ -z "$dir" ] && [ -n "${HOME:-}" ]; then dir="$HOME/.config/autonomy"; fi
  if [ -n "$dir" ]; then printf '%s' "$dir/usage-reset.$1"; fi
}

# Persist a discovered reset epoch: repo-local (existing contract) plus the
# shared marker. Shared write is atomic (tmp + mv, a concurrent reader never
# sees a torn value) and best-effort -- on failure warn and keep looping.
persist_reset_epoch() {
  local epoch="$1" dir tmpf
  printf '%s\n' "$epoch" >"$RESET_STATE"
  [ -n "${SHARED_RESET_STATE:-}" ] || return 0
  dir="$(dirname "$SHARED_RESET_STATE")"
  tmpf="$SHARED_RESET_STATE.$$"
  if mkdir -p "$dir" 2>/dev/null \
     && printf '%s\n' "$epoch" >"$tmpf" 2>/dev/null \
     && mv -f "$tmpf" "$SHARED_RESET_STATE" 2>/dev/null; then
    return 0
  fi
  rm -f "$tmpf" 2>/dev/null
  log "WARN could not write shared usage-reset marker ($SHARED_RESET_STATE) -- repo-local only"
  return 0
}

# A clean session is empirical proof the account is usable again: clear both
# markers. (Another loop that is still limited re-persists within one
# session attempt -- self-healing, never fail-open.)
clear_reset_state() {
  rm -f "$RESET_STATE"
  if [ -n "${SHARED_RESET_STATE:-}" ]; then rm -f "$SHARED_RESET_STATE" 2>/dev/null; fi
  return 0
}

# Print $1's epoch only if it's a pure integer inside (now, now+horizon].
read_valid_reset() {
  local f="$1" now="$2" reset
  [ -f "$f" ] || return 1
  reset="$(cat "$f" 2>/dev/null)"
  case "$reset" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$reset" -gt "$now" ] && [ "$reset" -le "$((now + LIMIT_RESET_MAX_HORIZON))" ] || return 1
  printf '%s' "$reset"
}

# Wait until the LATEST valid epoch across the repo-local and shared markers
# (most conservative: the account is limited until every signal has passed).
compute_limit_wait() {
  local now best r f
  now="$(date +%s)"
  best=""
  for f in "$RESET_STATE" ${SHARED_RESET_STATE:+"$SHARED_RESET_STATE"}; do
    if r="$(read_valid_reset "$f" "$now")"; then
      if [ -z "$best" ] || [ "$r" -gt "$best" ]; then best="$r"; fi
    fi
  done
  [ -n "$best" ] || return 1
  echo "$((best - now))"
}

# --- per-role API credential (#51-C) ----------------------------------------
# Subscriptions are the default auth (nothing to resolve). If the operator
# assigned a named API key to this loop's ROLE via the config page, run the
# session with that key exported -- for THAT session only. Best-effort: any
# failure resolves to empty and the session runs on whatever auth the env
# already has (subscription). The secret is never logged.
resolve_role_credential() {
  local role="$1"
  if [ -n "${AUTONOMY_CREDENTIALS_BIN:-}" ]; then
    "$AUTONOMY_CREDENTIALS_BIN" resolve-role "$role" 2>/dev/null || true
  else
    python3 "$ENGINE_HOME/lib/credentials.py" resolve-role "$role" 2>/dev/null || true
  fi
}

# Run agent_invoke with $1 -- zero or more VAR=value lines, exactly what
# `accounts.py resolve` prints -- exported in a SUBSHELL, so account keys are
# scoped to the one session and never land in the supervisor's own
# environment (a long-lived process). Empty $1 = whatever auth the ambient
# env already has (subscription). Generalises the #51-C single-key form.
invoke_scoped_env() {
  local env_lines="$1"; shift
  if [ -z "$env_lines" ]; then
    agent_invoke "$@"
    return $?
  fi
  (
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      case "$line" in *=*) ;; *) continue ;; esac   # no '=' at all -- not an env line
      case "${line%%=*}" in
        ''|*[!A-Za-z0-9_]*) continue ;;   # not a sane env var name -- skip
      esac
      # shellcheck disable=SC2163
      export "${line%%=*}=${line#*=}"
    done <<EOF
$env_lines
EOF
    agent_invoke "$@"
  )
}

# Back-compat single-key form (#51-C): a resolved role credential ("" = none).
invoke_scoped_key() {
  local key="$1"; shift
  if [ -n "$key" ]; then
    invoke_scoped_env "ANTHROPIC_API_KEY=$key" "$@"
  else
    invoke_scoped_env "" "$@"
  fi
}

# --- headless multi-agent dispatch (agent-org increment 3) -------------------
# The supervisor dispatches EVERY enabled `roles:` agent whose trigger is
# `loop`, round-robin -- one session per loop iteration -- exactly the way it
# has always run Coder. Enumeration re-resolves every tick so config edits
# apply on the next session. Cron/event triggers belong to increment 4's
# scheduler/event bus and are never dispatched here.

# Enabled loop-role names, one per line (roles.py dispatch contract). The
# caller handles rc!=0 (fail back to coder-only) and empty output (idle).
resolve_dispatch_roles() {
  python3 "$ENGINE_HOME/lib/roles.py" dispatch "$AUTONOMY_TARGET_REPO" 2>>"$SUPLOG"
}

# --- cron scheduler (W1, issue #85) -----------------------------------------
# Enumerate the target repo's cron roles as NAME<TAB>SCHEDULE lines (roles.py
# cron contract; schedules never contain a tab). Behind a function so tests can
# override the enumeration seam without a real roles.py call. rc!=0 is the
# caller's cue to skip cron this tick -- best-effort, never crashes the loop.
_cron_enumerate() {
  python3 "$ENGINE_HOME/lib/roles.py" cron "$AUTONOMY_TARGET_REPO" 2>>"$SUPLOG"
}

# Fire every cron role whose next scheduled fire (strictly after its last-fire
# marker) is at or before now, then advance its marker. The supervisor is the
# SOLE writer of each per-role marker ($VARDIR/cron/<role>.last_fire) -- the
# reset-epoch-split invariant generalised (adapters never persist scheduling
# state). Additive and best-effort: any failure skips cron for this tick and
# leaves loop dispatch byte-for-byte unchanged. First-sight (no marker)
# initialises the marker to now WITHOUT firing (no thundering-herd on first
# start / after downtime). All cron math stays in roles.py (cron-due); this is
# a thin string-tester. NEVER returns non-zero -- a cron hiccup is not a loop
# error. The role name reaches a filesystem path, so it is charset-gated at the
# point of use exactly like ROLE_AGENT (prevention-log #6).
resolve_cron_due() {
  local enum now name schedule marker last due
  enum="$(_cron_enumerate)" || return 0
  [ -n "$enum" ] || return 0
  now="$(date +%s)"
  mkdir -p "$VARDIR/cron" 2>/dev/null || {
    log "WARN cron: cannot create $VARDIR/cron -- skipping cron this tick"; return 0; }
  # NAME<TAB>SCHEDULE per line. A pipeline subshell is fine: no state needs to
  # escape the loop (markers are files; each tick re-enumerates from scratch).
  printf '%s\n' "$enum" | while IFS="$(printf '\t')" read -r name schedule; do
    [ -n "$name" ] || continue
    case "$name" in
      *[!A-Za-z0-9_-]*)
        log "WARN cron: role name '$name' has invalid path chars -- ignored"
        continue ;;
    esac
    marker="$VARDIR/cron/$name.last_fire"
    if [ ! -f "$marker" ]; then
      printf '%s' "$now" >"$marker" 2>/dev/null \
        || log "WARN cron: cannot initialise marker for '$name'"
      continue
    fi
    last="$(cat "$marker" 2>/dev/null)"
    case "$last" in ''|*[!0-9]*) last=0 ;; esac
    # roles.py owns the cron_next_fire math; unparseable/error -> not-due.
    due="$(python3 "$ENGINE_HOME/lib/roles.py" cron-due "$schedule" "$last" "$now" 2>>"$SUPLOG")" || continue
    [ "$due" = "due" ] || continue
    log "cron: role '$name' due (schedule '$schedule') -- firing"
    run_session "$name" || log "cron: role '$name' session rc=$? (see supervisor.log)"
    # Advance the marker regardless of the session's rc: under-fire (wait for
    # the next window), never over-fire. A write failure warns and leaves the
    # marker so the role does not re-fire every tick.
    printf '%s' "$now" >"$marker" 2>/dev/null \
      || log "WARN cron: marker write failed for '$name' -- not advancing (retries next tick)"
  done
  return 0
}

# Round-robin selector: print the (idx mod n)th name, 0-indexed, from the
# names in $2..; rc 1 when the list is empty. Role names are [A-Za-z0-9._-]
# by the dispatch contract, so callers may word-split the enumeration safely.
select_role() {
  local idx="$1"; shift
  [ $# -gt 0 ] || return 1
  shift $(( idx % $# ))
  printf '%s' "$1"
}

# Parse `roles.py dispatch <repo> <role>` KEY=value output into ROLE_*
# globals. rc 1 = the role is not dispatchable / settings unreadable -- the
# caller REFUSES the session (fail-safe). Model/effort values came from a
# config a dashboard may write: validate before they can land in argv
# (defense-in-depth parity with consume_model_override).
resolve_role_dispatch() {
  local role="$1" out line key val
  ROLE_ACCOUNT=""; ROLE_AGENT=""; ROLE_MODEL=""; ROLE_EFFORT=""; ROLE_PROMPT=""
  ROLE_SCOPE=""; ROLE_INSTANCES=1
  out="$(python3 "$ENGINE_HOME/lib/roles.py" dispatch "$AUTONOMY_TARGET_REPO" "$role" 2>>"$SUPLOG")" || return 1
  while IFS= read -r line; do
    key="${line%%=*}"; val="${line#*=}"
    case "$key" in
      ACCOUNT)   ROLE_ACCOUNT="$val" ;;
      AGENT)     ROLE_AGENT="$val" ;;
      MODEL)     ROLE_MODEL="$val" ;;
      EFFORT)    ROLE_EFFORT="$val" ;;
      PROMPT)    ROLE_PROMPT="$val" ;;
      SCOPE)     ROLE_SCOPE="$val" ;;
      INSTANCES) ROLE_INSTANCES="$val" ;;
    esac
  done <<EOF
$out
EOF
  if [ -n "$ROLE_MODEL" ] && ! valid_model_id "$ROLE_MODEL"; then
    log "WARN roles.$role.model is not a valid model id -- ignored"
    ROLE_MODEL=""
  fi
  if [ -n "$ROLE_EFFORT" ] && ! valid_effort "$ROLE_EFFORT"; then
    log "WARN roles.$role.effort invalid (valid: low|medium|high|xhigh|max) -- ignored"
    ROLE_EFFORT=""
  fi
  # The agent name becomes part of a `source .../${ROLE_AGENT}.sh` path, so
  # re-validate its charset here even though roles.py checks the shape
  # (defense-in-depth, prevention-log #6): a value with any non-[A-Za-z0-9_-]
  # char (e.g. a '../' traversal) is blanked -> the global $AGENT_TYPE runs.
  # An empty value has no chars to match, so it stays empty (= use $AGENT_TYPE).
  case "$ROLE_AGENT" in
    *[!A-Za-z0-9_-]*)
      log "WARN roles.$role.agent '$ROLE_AGENT' has invalid chars -- ignored (using \$AGENT_TYPE)"
      ROLE_AGENT="" ;;
  esac
  return 0
}

# Resolve an account name to its session env (VAR=value lines) via
# lib/accounts.py (increment 1). Subscriptions print nothing (rc 0). rc 1 =
# unresolvable: the caller MUST refuse the session -- never run on broken
# auth (fail-safe, never fail-open). accounts.py's stderr reason lands in
# the supervisor log; the secret itself is never logged.
# $AUTONOMY_ACCOUNTS_BIN is the test seam (same pattern as
# AUTONOMY_CREDENTIALS_BIN).
resolve_account_env() {
  if [ -n "${AUTONOMY_ACCOUNTS_BIN:-}" ]; then
    "$AUTONOMY_ACCOUNTS_BIN" resolve "$1" 2>>"$SUPLOG"
  else
    python3 "$ENGINE_HOME/lib/accounts.py" resolve "$1" 2>>"$SUPLOG"
  fi
}

# Compose the session's system-prompt file: the pack's hard_rules plus the
# role's one-line scope directive. Prints the path to hand the adapter. No
# scope -> the original hard_rules path untouched. A compose FAILURE refuses
# (rc 1): silently dropping a scope would widen the agent's remit
# (fail-open), so the caller skips the session instead.
compose_session_rules() {
  local rules_file="$1" scope_line="$2" out_file="$3"
  if [ -z "$scope_line" ]; then
    printf '%s' "$rules_file"
    return 0
  fi
  { cat "$rules_file" && printf '\n%s\n' "$scope_line"; } >"$out_file" 2>>"$SUPLOG" || return 1
  printf '%s' "$out_file"
}

run_session() {
  local role="${1:-${ROLE:-coder}}"
  preflight || return $?

  if ! resolve_role_dispatch "$role"; then
    log "dispatch: cannot resolve settings for role '$role' -- REFUSING session (fail-safe; see supervisor.log)"
    return 2
  fi

  # Source the ROLE's agent adapter when it sets one (e.g. a local-LLM 'prep'
  # role on codex), else the global $AGENT_TYPE. resolve_role_dispatch has
  # already charset-gated ROLE_AGENT, so it is safe in this path.
  #
  # roles.py validates `agent:` only as a non-empty string -- it does NOT check
  # the adapter file exists or is usable. Under `set -uo pipefail` (no `set -e`)
  # a missing / unreadable / syntactically-broken / incomplete adapter would
  # leave the `source` failed or partial and execution would continue with STALE
  # agent_invoke/agent_classify_outcome definitions from a prior role in the
  # round-robin (or undefined on the first role) -- silently running the WRONG
  # agent. So: CLEAR any prior role's adapter functions first, then refuse the
  # session unless the adapter loads AND defines the full contract. Fail-safe,
  # never fail-open, like every other unresolvable dispatch (settled-decision #4).
  local adapter_name="${ROLE_AGENT:-$AGENT_TYPE}"
  local adapter="${AUTONOMY_AGENTS_DIR:-$ENGINE_HOME/bin/agents}/${adapter_name}.sh"
  unset -f agent_invoke agent_classify_outcome 2>/dev/null || true
  # shellcheck source=/dev/null
  # `declare -F` (not `command -v`): the contract must be a FUNCTION defined by
  # the adapter, never an unrelated executable of the same name on $PATH.
  if [ ! -f "$adapter" ] || ! source "$adapter" \
      || ! declare -F agent_invoke >/dev/null 2>&1 \
      || ! declare -F agent_classify_outcome >/dev/null 2>&1; then
    log "dispatch: agent adapter '$adapter_name' unusable ($adapter) -- missing, unreadable, or not defining agent_invoke/agent_classify_outcome -- REFUSING session (fail-safe; see supervisor.log)"
    return 2
  fi

  resolve_session_settings

  # Auth precedence: account (fail-safe -- an unresolvable account REFUSES
  # the session, never runs on broken auth) > per-role credential (#51-C,
  # best-effort) > subscription.
  local env_lines="" auth_note="subscription"
  if [ -n "$ROLE_ACCOUNT" ]; then
    if ! env_lines="$(resolve_account_env "$ROLE_ACCOUNT")"; then
      log "dispatch: role '$role' account '$ROLE_ACCOUNT' did not resolve -- REFUSING session (fail-safe; see supervisor.log)"
      return 2
    fi
    auth_note="account($ROLE_ACCOUNT)"
  else
    local role_key; role_key="$(resolve_role_credential "$role")"
    if [ -n "$role_key" ]; then
      env_lines="ANTHROPIC_API_KEY=$role_key"
      auth_note="api-key($role)"
    fi
  fi

  # The role's own prompt when set (doctor verified it is a repo-relative
  # pack file), else the pack's loop_prompt. Re-validate the config-sourced
  # path here (defense-in-depth, independent of doctor) before it becomes a
  # filename; a missing file refuses.
  local prompt_file="$AUTONOMY_TARGET_REPO/.autonomy/loop_prompt.md"
  if [ -n "$ROLE_PROMPT" ]; then
    if ! valid_prompt_path "$ROLE_PROMPT"; then
      log "dispatch: role '$role' prompt path '$ROLE_PROMPT' is absolute or escapes the pack -- REFUSING session (fail-safe)"
      return 2
    fi
    prompt_file="$AUTONOMY_TARGET_REPO/$ROLE_PROMPT"
  fi
  if [ ! -f "$prompt_file" ]; then
    log "dispatch: prompt file missing for role '$role' ($prompt_file) -- REFUSING session"
    return 2
  fi

  local rules_file
  if ! rules_file="$(compose_session_rules "$AUTONOMY_TARGET_REPO/.autonomy/hard_rules.md" "$ROLE_SCOPE" "$LOGDIR/.session-rules")"; then
    log "dispatch: cannot compose scope rules for role '$role' -- REFUSING session (a dropped scope would widen the agent's remit)"
    return 2
  fi

  if [ "$ROLE_INSTANCES" != "1" ]; then
    log "NOTE roles.$role.instances=$ROLE_INSTANCES not yet supported -- running a single instance (parallel instances are a later increment)"
  fi

  local log_file; log_file="$LOGDIR/session-$(date +%Y%m%dT%H%M%S).log"
  log "session start (role=$role model=$MODEL effort=${EFFORT:-default} auth=$auth_note) -> $log_file"

  invoke_scoped_env "$env_lines" \
    "$prompt_file" "$rules_file" \
    "$MODEL" "$FALLBACK_MODEL" "$log_file" "$EFFORT"
  local rc=$?

  local outcome; outcome="$(agent_classify_outcome "$log_file" "$rc")"
  case "$outcome" in
    success)
      return 0 ;;
    usage_limit*)
      local epoch="${outcome#usage_limit }"
      if [ "$epoch" != "usage_limit" ] && [ -n "$epoch" ]; then
        persist_reset_epoch "$epoch"
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
  ACCOUNT_KEY="$(resolve_account_key)"
  SHARED_RESET_STATE="$(resolve_shared_reset_state "$ACCOUNT_KEY")"
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
  role_rr=0

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

    # Cron scheduler (W1, #85): fire due cron roles under the held lock, one at
    # a time. Run BEFORE the board-empty / no-loop-role gates below so a cron
    # PM/researcher still fires when the coder board is empty or no loop role is
    # enabled (a cron-only repo must schedule) -- the spec's whole point. Purely
    # additive and best-effort: with no cron roles this is a no-op and the loop
    # behaves byte-for-byte as before.
    resolve_cron_due

    open_count="$(cd "$AUTONOMY_TARGET_REPO" && gh issue list --state open --json number -q 'length' 2>/dev/null || echo -1)"
    if [ "$open_count" = "0" ]; then
      dirty_skips=0
      log "board empty -- idle ${EMPTY_IDLE}s"; sleep "$EMPTY_IDLE"; continue
    fi

    # Round-robin over the enabled loop roles (re-enumerated every tick so a
    # config edit applies on the next session). Enumeration failure falls
    # back to coder-only -- the conservative default; preflight's doctor
    # check still gates a truly broken pack. NO roles enabled = idle, same
    # as an empty board.
    if ! dispatch_list="$(resolve_dispatch_roles)"; then
      log "WARN role enumeration failed -- coder-only fallback (see supervisor.log)"
      dispatch_list="coder"
    fi
    if [ -z "$dispatch_list" ]; then
      log "no loop roles enabled -- idle ${EMPTY_IDLE}s"; sleep "$EMPTY_IDLE"; continue
    fi
    # shellcheck disable=SC2086  # intentional split: names are [A-Za-z0-9._-] tokens
    role="$(select_role "$role_rr" $dispatch_list)"
    role_rr=$(( (role_rr + 1) % 86400 ))

    run_session "$role"; outcome=$?
    case $outcome in
      0) log "session clean (open issues ~$open_count). pace ${PACE}s"
         err_backoff=$ERR_BACKOFF_START; limit_backoff=$LIMIT_BACKOFF_START
         clear_reset_state
         sleep "$PACE" ;;
      # NOTE: usage-limit state is one marker per supervisor (engine.account_key),
      # so a limit on one role's account pauses every role in this loop -- with
      # per-role accounts this over-waits (safe direction). Proper per-account
      # limit state is issue #3's scope.
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
      2) log "preflight/dispatch skip -- wait ${ERR_BACKOFF_START}s"; sleep "$ERR_BACKOFF_START" ;;
      *) log "session error (rc=$outcome) -- backoff ${err_backoff}s"
         sleep "$err_backoff"
         err_backoff=$(( err_backoff*2 < ERR_BACKOFF_MAX ? err_backoff*2 : ERR_BACKOFF_MAX )) ;;
    esac
  done
fi
