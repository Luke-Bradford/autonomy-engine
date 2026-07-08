#!/usr/bin/env bash
# bin/supervisor.sh -- generic, repo-agnostic autonomy SUPERVISOR. Runs
# board-drain sessions back-to-back for days, unattended, with usage-limit
# backoff, against WHATEVER target repo is passed via --repo.
#
# Usage:
#   supervisor.sh --repo <path> [--agent-type claude|codex] [--model <id>]
#                 [--fallback-model <id>] [--effort <level>] [--label <slug>]
#                 [--lane <name>]
#
# --lane runs ONE lane of a multi-lane repo (dispatch/cron/events filter to it;
# default lane = today's behaviour). One supervisor per lane (SD-21).
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
# shellcheck source=/dev/null
source "$ENGINE_HOME/bin/lock_paths.sh"

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

# Structured liveness twin of the supervisor.log narration (#177): one
# machine-readable status line the dashboard can render as "what is happening
# and why now" instead of a bare IDLE. Sole writer (this supervisor), atomic
# (temp + mv so a reader never sees a torn line), under the gitignored LOGDIR.
# Best-effort: any write failure is swallowed -- a heartbeat hiccup must NEVER
# perturb the loop (mirrors board.sh's never-hard-fail contract).
# Fields are TAB-separated so the free-text reason (last) can hold spaces:
#   <ts_epoch> \t <phase> \t <until_epoch|''> \t <reason>
# until_epoch is the absolute UTC epoch a wait ends (dashboard counts down
# client-side), empty for an active/instantaneous phase.
heartbeat() {
  [ -n "${LOGDIR:-}" ] || return 0
  local phase="$1" reason="${2:-}" until_epoch="${3:-}"
  local hb="$LOGDIR/heartbeat" tmp="$LOGDIR/heartbeat.$$.tmp" now
  now="$(date -u +%s)"
  # Subshell with fd2 suppressed so even a redirection-OPEN failure (missing
  # LOGDIR) stays silent -- a heartbeat must never spew to the launchd err log.
  (
    printf '%s\t%s\t%s\t%s\n' "$now" "$phase" "$until_epoch" "$reason" > "$tmp" &&
      mv -f "$tmp" "$hb"
  ) 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
  return 0
}

# Record the engine sha this supervisor booted from (#166 slice 1). A running
# supervisor's bash function bodies are frozen at process start, so a merged fix
# to bin/supervisor.sh is NOT live until a restart. Written ONCE at boot to the
# gitignored $LOGDIR/engine_sha; the dashboard compares it to the engine's
# current HEAD and shows an "update available -- restart to apply" chip when they
# diverge. Best-effort like heartbeat(): a git-less / unwritable path is
# swallowed and never perturbs the loop (SD-6). Args default to the boot globals
# so tests can pass a temp checkout + dir.
write_engine_boot_sha() {
  local home="${1:-${ENGINE_HOME:-}}" logdir="${2:-${LOGDIR:-}}" sha
  [ -n "$home" ] && [ -n "$logdir" ] || return 0
  sha="$(git -C "$home" rev-parse HEAD 2>/dev/null)" || return 0
  [ -n "$sha" ] || return 0
  # Print the sha for the caller (#294 uses it as the re-exec baseline) even
  # if the best-effort file write below fails -- the sha itself is known.
  printf '%s\n' "$sha"
  local tmp="$logdir/engine_sha.$$.tmp"
  (
    printf '%s\n' "$sha" > "$tmp" && mv -f "$tmp" "$logdir/engine_sha"
  ) 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
  return 0
}

# #294: a long-lived supervisor's bash is frozen at process start, so merged
# engine code is inert until the process is replaced. The three functions
# below let the supervisor re-exec ITSELF at the session boundary (same pid,
# lock/pause/reset state all on disk), making the dashboard's "refresh at next
# session boundary" banner true instead of a display lie.

# "Update ready" is an EARNED verdict (prevention-log #18): prints the engine
# checkout's current HEAD and returns 0 ONLY when the HEAD is readable,
# non-empty, differs from the sha this process booted from, AND the engine
# tree is clean. Every failure path returns 1 -- a git hiccup or dirty tree
# means keep running the old code, never exec into an unknown state.
engine_update_ready() {
  local home="${1:-}" boot_sha="${2:-}" cur dirty
  [ -n "$home" ] && [ -n "$boot_sha" ] || return 1
  cur="$(git -C "$home" rev-parse HEAD 2>/dev/null)" || return 1
  [ -n "$cur" ] || return 1
  [ "$cur" != "$boot_sha" ] || return 1
  dirty="$(git -C "$home" status --porcelain 2>/dev/null)" || return 1
  [ -z "$dirty" ] || return 1
  printf '%s\n' "$cur"
  return 0
}

# The boundary decision: may THIS loop iteration re-exec? No when a prior
# exec attempt failed (never loop-exec), and no while last iteration's
# session.done edge is still pending -- resolve_event_wakes must consume it
# BEFORE the process image is replaced, or the event is silently dropped.
# Prints the new HEAD on yes (delegated to engine_update_ready).
should_reexec() {
  local disabled="${1:-1}" session_ran="${2:-1}" home="${3:-}" boot_sha="${4:-}"
  [ "$disabled" = "0" ] || return 1
  [ "$session_ran" = "0" ] || return 1
  engine_update_ready "$home" "$boot_sha"
}

# Replace this process with a fresh supervisor from the (updated) engine
# checkout. On success this never returns and the EXIT trap does NOT fire --
# the lock dir survives for the same-pid continuation (see
# acquire_supervisor_lock). On failure the process must SURVIVE: bash's
# default for a non-interactive shell is to exit when exec fails, so execfail
# is set for the attempt (and restored after, to leave the surviving old
# process's shell semantics untouched).
reexec_engine() {
  local home="$1"; shift
  local target="$home/bin/supervisor.sh"
  # exec-ing "/bin/bash $target" SUCCEEDS even when $target is missing or
  # broken -- the fresh bash then dies, taking the supervisor with it. So the
  # target must exist and parse (bash -n) BEFORE the point of no return.
  if [ ! -r "$target" ] || ! /bin/bash -n "$target" 2>/dev/null; then
    log "WARN: self-re-exec failed -- new supervisor.sh missing or does not parse; continuing on the old code (restart to apply)"
    return 1
  fi
  local had_execfail=0
  shopt -q execfail && had_execfail=1
  shopt -s execfail
  # shellcheck disable=SC2093  # continuing after exec is the point: execfail makes a failed exec return
  exec /bin/bash "$target" "$@"
  # Only reached when the exec itself failed (e.g. /bin/bash unrunnable).
  [ "$had_execfail" -eq 1 ] || shopt -u execfail
  log "WARN: self-re-exec failed -- continuing on the old code (restart to apply new engine code)"
  return 1
}

# Take (or keep) the one-supervisor-per-repo lock. Returns 0 = we hold the
# lock, 1 = another live supervisor holds it (caller exits 0, as before --
# this is the pre-#294 inline block extracted for the re-exec identity case).
# pid == $$ IS proof of identity (prevention-log #10): after a self-re-exec
# the SAME pid re-runs startup and must keep its own lock, not refuse it.
# A malformed pidfile (non-decimal) is treated as stale, never fed to kill.
acquire_supervisor_lock() {
  local lock="$1" pid
  if ! mkdir "$lock" 2>/dev/null; then
    pid="$(cat "$lock/pid" 2>/dev/null || echo)"
    case "$pid" in
      ''|*[!0-9]*) pid="" ;;   # empty or non-decimal -> stale
    esac
    if [ -n "$pid" ] && [ "$pid" = "$$" ]; then
      return 0   # our own lock, carried across a self-re-exec -- keep it
    fi
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      log "supervisor already running (pid $pid); exiting."
      return 1
    fi
    rm -rf "$lock"
    mkdir "$lock" 2>/dev/null || { log "lost lock race; exiting."; return 1; }
  fi
  echo $$ >"$lock/pid"
  return 0
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

# #245: an idle worktree must never hold the `main` branch ref. Git forbids one
# branch from being checked out in two worktrees at once, so if this loop's
# worktree parks on an ATTACHED `main` between tickets, a sibling primary
# checkout (the dev stack) can no longer `git checkout main`. preflight()
# re-parks to a DETACHED origin/main at session START -- but the agent may end
# its ticket sitting on an attached `main`, holding that ref for the whole idle
# window until the next preflight runs. Close the window at session END: detach
# HEAD off `main` (releasing the ref) after every session.
#
# Detach at the CURRENT commit -- no network, no fetch: the goal is only to
# release the `main` ref during the idle window; preflight re-parks to a fresh
# origin/main next session. Best-effort and fail-safe (SD #4/#6): only act on a
# clean tree attached to `main` -- never detach over uncommitted work (WIP is
# preflight's dirty-tree recovery to own), never touch a feature branch or an
# already-detached HEAD (neither blocks a sibling worktree), and never hard-fail
# the loop on a git hiccup (preflight will re-park regardless).
session_end_park() {
  cd "$AUTONOMY_TARGET_REPO" 2>/dev/null || return 0
  # Only an ATTACHED `main` blocks a sibling worktree -- a detached HEAD or a
  # feature branch does not. symbolic-ref fails (non-zero, empty) when detached.
  [ "$(git symbolic-ref -q --short HEAD 2>/dev/null || echo '')" = "main" ] || return 0
  # Never detach over WIP: leave a dirty tree for preflight's recovery to handle.
  # A `git status` FAILURE is not "clean" -- treat unknown state as fail-safe and
  # leave the worktree untouched (split `local` from assignment so the command
  # substitution's rc is not masked). preflight re-parks on the next tick.
  local dirty
  dirty="$(git status --porcelain 2>>"$SUPLOG")" || {
    log "session-end park: 'git status' failed -- leaving worktree as-is (preflight will re-park)"
    return 0
  }
  if [ -n "$dirty" ]; then
    log "session-end park: tree dirty on main -- leaving for preflight recovery"
    return 0
  fi
  if git switch --detach -q 2>>"$SUPLOG"; then
    log "session-end park: detached HEAD off main (an idle worktree must not hold the main ref)"
  else
    log "session-end park: detach failed -- preflight will re-park next session"
  fi
  return 0
}

# #252: keep the board honest each iteration. GitHub ProjectV2's built-in
# "closed -> Done" workflow can't be enabled via API, so closed issues freeze in
# their old column. board.sh's `sweep` command moves them to Done (idempotent,
# rate-limit-gated). Wired here -- the engine side, repo-agnostic -- rather than
# in the pack's loop_prompt (a guardrail), so every consumer gets it with no
# pack edit. Best-effort: board.sh warns + exits 0 on every failure path, and
# `|| true` is belt-and-suspenders so a board hiccup can never perturb dispatch.
sweep_board() {
  ( cd "$AUTONOMY_TARGET_REPO" && "$ENGINE_HOME/bin/board.sh" sweep ) >>"$SUPLOG" 2>&1 || true
}

# --- live model/effort settings (#24) ---------------------------------------
# Strict token check for model ids -- the value came over the dashboard's
# control channel and lands in a CLI argv; nothing shell-metacharish allowed.
# Kept in PARITY with dashboard_control.MODEL_RE (start alnum, allowed set,
# max 64 chars) so the defense-in-depth line is as strict as the first. The
# allowed set includes ':' for local-LLM ids (Ollama-style name:tag, e.g.
# qwen3:14b) -- a colon is shell-safe in an exec argv token, and blanking a
# valid local id would silently fall back to the agent.* default (#213).
# (In the negated bracket set `]` must come first.)
valid_model_id() {
  case "$1" in
    '') return 1 ;;
    [!A-Za-z0-9]*) return 1 ;;
    *[!]A-Za-z0-9:._[-]*) return 1 ;;
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
  read_config_overlay
  MODEL="$(resolve_config_value "$CFG" agent.model.primary "${MODEL_OVERRIDE:-${ROLE_MODEL:-$OVERLAY_MODEL}}" claude-sonnet-5)"
  FALLBACK_MODEL="$(resolve_config_value "$CFG" agent.model.fallback "${FALLBACK_MODEL_OVERRIDE:-$OVERLAY_FALLBACK}" claude-sonnet-4-6)"
  EFFORT="$(resolve_config_value "$CFG" agent.effort "${EFFORT_OVERRIDE:-${ROLE_EFFORT:-$OVERLAY_EFFORT}}" "")"
  consume_model_override "$LOGDIR/model-override"
}

# Persistent operator overrides written by the dashboard's 'save default'
# (#202). Lives in the gitignored var/autonomy-logs (same home as the one-shot
# model-override) so it survives the preflight stash-recovery that would sweep
# a tracked config.yaml edit. Values are re-validated here (defense in depth,
# parity with consume_model_override); an absent/invalid overlay leaves the
# OVERLAY_* vars empty so resolution falls back to the committed config.yaml.
# It sits WITHIN the agent.* tier: role/CLI/one-shot still win (settled #13).
read_config_overlay() {
  OVERLAY_MODEL=""; OVERLAY_FALLBACK=""; OVERLAY_EFFORT=""
  local overlay_file="$LOGDIR/config-overrides" line key val
  [ -f "$overlay_file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    key="${line%%=*}"; val="${line#*=}"
    case "$key" in
      model)    if valid_model_id "$val"; then OVERLAY_MODEL="$val"; fi ;;
      fallback) if valid_model_id "$val"; then OVERLAY_FALLBACK="$val"; fi ;;
      effort)   if valid_effort "$val"; then OVERLAY_EFFORT="$val"; fi ;;
    esac
  done <"$overlay_file"
  return 0
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

# --- #318: deterministic pre-session fingerprint gate ------------------------
# A full agent session every PACE seconds is pure token burn when the
# observable world has not moved. The gate skips a loop-role session ONLY on
# an EARNED, exact sha256 match between the world as it looks now and the
# world as it looked when a previous session for this role COMPLETED cleanly.
# Every doubt -- a gh/git failure, a page cap, a pending one-shot override, a
# path-unsafe name -- REFUSES the skip so the session runs (pre-#318
# behaviour): staleness can only cost tokens, never bury work. Fail toward
# work, never toward silence.

# The ONLY constructor for fingerprint state paths (role+lane are an explicit
# interface, no hidden globals). Names are charset-gated at the point of use
# (prevention-log #6) exactly like the cron/event marker paths.
fingerprint_state_file() {
  local role="$1" lane="$2"
  [ -n "$role" ] || return 1
  _role_name_path_safe "$role" || return 1
  if [ -n "$lane" ]; then
    _role_name_path_safe "$lane" || return 1
    printf '%s/.fingerprint-%s--%s' "$LOGDIR" "$role" "$lane"
  else
    printf '%s/.fingerprint-%s' "$LOGDIR" "$role"
  fi
}

# Print the current fingerprint for <role> (sha256 hex), or rc 1 when the
# world is unfingerprintable. Material (canonicalised, sorted -- never raw
# JSON byte order): open issues (number+updatedAt; labels/comments touch
# updatedAt, and per SD-23 Projects v2 is display-only so issue state IS the
# board), open PRs (number+head+updatedAt), remote main head, the role's
# RESOLVED dispatch contract (roles.py dispatch output: account/agent/model/
# effort/prompt/scope), EVERY file under .autonomy/ plus the role's prompt
# file wherever it lives (CP2: a prompt outside .autonomy, any extension,
# must still bust the hash), the persistent config-overrides overlay, the CLI
# override set, and role+lane. A pending one-shot model-override is a
# next-session CONTRACT -- it forces a run rather than joining the hash.
# Exactly the page limit of results means "maybe truncated" -> refuse. Pack
# traversal happens INSIDE the python hasher with onerror=raise (CP2: a
# suppressed find/cat failure must never hash partial material -- any read
# error exits nonzero and the caller refuses). Compute-only: this function
# never writes state (sole-writer stays with the supervisor loop).
role_fingerprint() {
  local role="$1" lane="${AUTONOMY_LANE:-}" issues prs main_head n
  local dispatch_out prompt_rel line fp_live_cfg
  # Workstreams slice 1: the var-live config shadow, when present, IS the
  # effective config (config_parser resolver) -- its bytes join the material
  # as a REQUIRED extra so a live edit can never hide behind an unchanged
  # hash and be skipped.
  fp_live_cfg="$AUTONOMY_TARGET_REPO/var/autonomy/config.yaml"
  [ -f "$fp_live_cfg" ] || fp_live_cfg=""
  [ -f "$LOGDIR/model-override" ] && return 1
  _role_name_path_safe "$role" || return 1
  if [ -n "$lane" ]; then _role_name_path_safe "$lane" || return 1; fi
  if ! dispatch_out="$(python3 "$ENGINE_HOME/lib/roles.py" dispatch "$AUTONOMY_TARGET_REPO" "$role" 2>>"$SUPLOG")"; then
    return 1
  fi
  prompt_rel=""
  while IFS= read -r line; do
    case "$line" in PROMPT=*) prompt_rel="${line#PROMPT=}"; break ;; esac
  done <<<"$dispatch_out"
  if ! issues="$(cd "$AUTONOMY_TARGET_REPO" && gh issue list --state open -L 200 \
      --json number,updatedAt \
      --jq 'sort_by(.number) | map("\(.number) \(.updatedAt)") | .[]' 2>>"$SUPLOG")"; then
    return 1
  fi
  # `|| true` covers grep -c's rc-1-on-zero-matches (an empty board is a
  # valid count of 0, not an error); a genuinely broken grep would also land
  # on n=0, which only RUNS more sessions -- the safe direction.
  n="$(grep -c . <<<"$issues" || true)"; n="${n:-0}"
  [ "$n" -ge 200 ] && return 1
  if ! prs="$(cd "$AUTONOMY_TARGET_REPO" && gh pr list --state open -L 100 \
      --json number,headRefOid,updatedAt \
      --jq 'sort_by(.number) | map("\(.number) \(.headRefOid) \(.updatedAt)") | .[]' 2>>"$SUPLOG")"; then
    return 1
  fi
  n="$(grep -c . <<<"$prs" || true)"; n="${n:-0}"
  [ "$n" -ge 100 ] && return 1
  # --symref origin HEAD observes the remote's ACTUAL default branch (no
  # hardcoded name -- a `master`/other-default repo works; and ls-remote of a
  # nonexistent ref exits 0 with EMPTY output, so emptiness must refuse too:
  # a silently-constant material component could never bust the fingerprint).
  if ! main_head="$(cd "$AUTONOMY_TARGET_REPO" && git ls-remote --symref origin HEAD 2>>"$SUPLOG")"; then
    return 1
  fi
  [ -n "$main_head" ] || return 1
  {
    printf 'role=%s\nlane=%s\ncli=%s|%s|%s|%s\n' "$role" "$lane" \
      "${AGENT_TYPE_OVERRIDE:-}" "${MODEL_OVERRIDE:-}" \
      "${FALLBACK_MODEL_OVERRIDE:-}" "${EFFORT_OVERRIDE:-}"
    printf -- '--dispatch--\n%s\n' "$dispatch_out"
    printf -- '--issues--\n%s\n--prs--\n%s\n--main--\n%s\n' "$issues" "$prs" "$main_head"
  } | python3 -c '
import hashlib, os, sys
h = hashlib.sha256()

def record(tag, path_bytes, content):
    # Length-prefixed, so the serialization is INJECTIVE: file bytes that
    # happen to contain a marker can never collide with a different file set.
    h.update(("%s %d %d\n" % (tag, len(path_bytes), len(content))).encode())
    h.update(path_bytes)
    h.update(content)

h.update(sys.stdin.buffer.read())
root = sys.argv[1]
if not os.path.isdir(root):
    sys.exit(1)                       # a pack-less repo is unfingerprintable
def _raise(err):                      # os.walk must never skip-silently
    raise err
files = []
for dp, _dns, fns in os.walk(root, onerror=_raise):
    for fn in fns:
        files.append(os.path.join(dp, fn))
for f in sorted(files):
    with open(f, "rb") as fh:         # read error -> exception -> rc 1 -> refuse
        record("file", os.path.relpath(f, root).encode(), fh.read())
overlay = sys.argv[2]                 # optional -- but absence is ENCODED,
if os.path.exists(overlay):           # never identical to exists-but-empty
    with open(overlay, "rb") as fh:
        record("overlay", overlay.encode(), fh.read())
else:
    h.update(b"overlay-absent\n")
for extra in sys.argv[3:]:            # REQUIRED (the resolved prompt file):
    with open(extra, "rb") as fh:     # missing -> exception -> rc 1 -> refuse
        record("extra", extra.encode(), fh.read())
print(h.hexdigest())
' "$AUTONOMY_TARGET_REPO/.autonomy" "$LOGDIR/config-overrides" \
    ${prompt_rel:+"$AUTONOMY_TARGET_REPO/$prompt_rel"} \
    ${fp_live_cfg:+"$fp_live_cfg"} 2>>"$SUPLOG"
}

# rc 0 => skip this role's session. Side effect: FP_CURRENT holds the freshly
# computed fingerprint (empty when uncomputable) so the outcome-0 arm can
# record exactly what this tick OBSERVED, never a re-computed value.
FP_CURRENT=""
fingerprint_gate() {
  local role="$1" state_file recorded
  FP_CURRENT=""
  if ! FP_CURRENT="$(role_fingerprint "$role")"; then FP_CURRENT=""; return 1; fi
  [ -n "$FP_CURRENT" ] || return 1
  if ! state_file="$(fingerprint_state_file "$role" "${AUTONOMY_LANE:-}")"; then return 1; fi
  [ -f "$state_file" ] || return 1
  recorded="$(cat "$state_file" 2>/dev/null || true)"
  [ -n "$recorded" ] || return 1
  [ "$recorded" = "$FP_CURRENT" ] || return 1
  return 0
}

# Persist the pre-session fingerprint AFTER a clean session (outcome 0 only --
# a crash/limit/refusal must not bury unfinished work behind a match). The
# supervisor is the sole writer; atomic tmp+mv like every other state marker.
# Best-effort: an unwritable state file costs future skips, never the loop.
record_fingerprint() {
  local role="$1" lane="$2" fp="$3" state_file tmpf
  [ -n "$fp" ] || return 0
  if ! state_file="$(fingerprint_state_file "$role" "$lane")"; then return 0; fi
  tmpf="$state_file.$$"
  if ( printf '%s\n' "$fp" >"$tmpf" ) 2>/dev/null && mv -f "$tmpf" "$state_file" 2>/dev/null; then
    :
  else
    rm -f "$tmpf" 2>/dev/null
    log "WARN could not record fingerprint for $role -- next tick runs normally"
  fi
  return 0
}

# Consecutive-skip backoff schedule. In-memory counter only (a persisted
# absolute idle-until is clock-fragile); any session actually run resets it.
fingerprint_backoff() {
  case "$1" in
    1) echo 120 ;;
    2) echo 300 ;;
    3) echo 900 ;;
    *) echo 1800 ;;
  esac
}

# rc 0 when the repo declares any cron or event role. Long skip sleeps would
# starve the top-of-tick cron/event resolvers, so the caller caps the idle at
# 300s when this returns 0. Enumeration failure reads as "none" -- the same
# tick's own cron/event resolution would have failed too, and the cost is a
# longer sleep, not lost work.
has_scheduled_roles() {
  local names
  names="$(_cron_enumerate 2>/dev/null || true)"
  [ -n "$names" ] && return 0
  names="$(_event_enumerate 2>/dev/null || true)"
  [ -n "$names" ] && return 0
  return 1
}

# Pause-aware idle: sleep <secs> in PAUSE_POLL slices, returning early the
# moment the pause sentinel appears so an operator pause takes effect within
# one poll interval, never after a full backoff window.
idle_sleep() {
  local remaining="$1" slice
  while [ "$remaining" -gt 0 ]; do
    if pause_requested "$PAUSE_SENTINEL"; then return 0; fi
    slice="$PAUSE_POLL"
    if [ "$remaining" -lt "$slice" ]; then slice="$remaining"; fi
    sleep "$slice"
    remaining=$((remaining - slice))
  done
  return 0
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

# roles.py enumeration (dispatch/cron/events) with the active lane filter
# appended. This supervisor runs ONE lane: `--lane "$AUTONOMY_LANE"` when set,
# else the default lane (bare call = today's behaviour, byte-identical). Lane
# threading lives in this ONE place so all three seams stay in sync (#147
# Part 2, SD-21). `${AUTONOMY_LANE:-}` keeps sourcing-for-tests nounset-safe.
# NOT used by the per-role `dispatch <repo> <role>` settings call -- role+lane
# together is a roles.py usage error (settings do not depend on lane).
_roles_enumerate() {
  if [ -n "${AUTONOMY_LANE:-}" ]; then
    python3 "$ENGINE_HOME/lib/roles.py" "$@" --lane "$AUTONOMY_LANE" 2>>"$SUPLOG"
  else
    python3 "$ENGINE_HOME/lib/roles.py" "$@" 2>>"$SUPLOG"
  fi
}

# Refuse (rc 1, message to stderr) a `--lane "$AUTONOMY_LANE"` that is not a
# declared, validly-configured lane of the target repo; rc 0 (silent) when no
# lane is set. Startup calls `validate_lane || exit 1` so a typo'd or malformed
# lane FAILS LOUD instead of silently dispatching nothing (#147 item 6: refuse,
# do not silently clamp -- the engine's fail-safe convention). A module-level
# function (not inline) so tests exercise it without launching the loop.
# The authoritative gate is membership in `roles.py lanes` (which itself refuses
# a malformed `lanes:` block and only lists names matching the lane-name
# contract -- charset + <=64 -- so membership covers all of it). A non-zero
# roles.py rc is itself a refusal (fail-safe: a read/parse error never passes).
# The charset pre-check is defense-in-depth (prevention-log #6) before the value
# reaches argv/grep; `grep -qxF --` because a lane name may legally start with `-`.
validate_lane() {
  local lane="${AUTONOMY_LANE:-}"
  [ -n "$lane" ] || return 0
  case "$lane" in
    *[!A-Za-z0-9._-]*) echo "supervisor.sh: invalid --lane name: $lane" >&2; return 1 ;;
  esac
  if [ "${#lane}" -gt 64 ]; then
    echo "supervisor.sh: --lane name too long (max 64): $lane" >&2; return 1
  fi
  local declared
  if ! declared="$(python3 "$ENGINE_HOME/lib/roles.py" lanes "$AUTONOMY_TARGET_REPO" 2>>"$SUPLOG")"; then
    echo "supervisor.sh: could not resolve lanes for $AUTONOMY_TARGET_REPO (malformed lanes: block?) -- refusing --lane $lane" >&2
    return 1
  fi
  if ! printf '%s\n' "$declared" | grep -qxF -- "$lane"; then
    echo "supervisor.sh: --lane '$lane' is not a declared lane in $AUTONOMY_TARGET_REPO/.autonomy/config.yaml" >&2
    return 1
  fi
  return 0
}

# Enabled loop-role names, one per line (roles.py dispatch contract). The
# caller handles rc!=0 (fail back to coder-only) and empty output (idle).
resolve_dispatch_roles() {
  _roles_enumerate dispatch "$AUTONOMY_TARGET_REPO"
}

# --- cron scheduler (W1, issue #85) -----------------------------------------
# Enumerate the target repo's cron roles as NAME<TAB>SCHEDULE lines (roles.py
# cron contract; schedules never contain a tab). Behind a function so tests can
# override the enumeration seam without a real roles.py call. rc!=0 is the
# caller's cue to skip cron this tick -- best-effort, never crashes the loop.
_cron_enumerate() {
  _roles_enumerate cron "$AUTONOMY_TARGET_REPO"
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
# Write epoch $2 to marker file $1; rc!=0 on failure. The subshell contains the
# redirection so a failed '>' (e.g. permission denied) does NOT leak its error
# to the supervisor's stderr -- an inline `2>/dev/null` runs too late to catch a
# redirection-open failure, which bash reports before the command runs.
_cron_write_marker() {
  ( printf '%s' "$2" >"$1" ) 2>/dev/null
}

# rc 0 when a role name is safe to embed in a marker / seen-set filename -- the
# SAME charset roles.py allows (its _ROLE_NAME_RE = [A-Za-z0-9._-]). Single
# source so the cron and event resolvers can never drift on the gate (#110); a
# stricter gate here would silently drop a valid dotted role (e.g. pm.v2) that
# roles.py happily dispatches. No '/' is possible and a suffix is always
# appended, so a '.'/'..' name cannot traverse out of its dir (prevention-log
# #6: a config string crossing into a filesystem path is re-validated at the
# point of use). Emptiness is a separate concern the callers gate themselves.
_role_name_path_safe() {
  case "$1" in
    *[!A-Za-z0-9._-]*) return 1 ;;
  esac
  return 0
}

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
    # Charset-gate before the name reaches a marker path (_role_name_path_safe
    # is the single source shared with resolve_event_wakes, #110).
    if ! _role_name_path_safe "$name"; then
      log "WARN cron: role name '$name' has invalid path chars -- ignored"
      continue
    fi
    marker="$VARDIR/cron/$name.last_fire"
    if [ ! -f "$marker" ]; then
      _cron_write_marker "$marker" "$now" \
        || log "WARN cron: cannot initialise marker for '$name'"
      continue
    fi
    last="$(cat "$marker" 2>/dev/null)"
    case "$last" in
      ''|*[!0-9]*)
        # Marker exists but is unreadable/corrupt. Treat it like first-sight --
        # reinitialise to now WITHOUT firing -- rather than substituting epoch 0
        # (which would read as "never fired" and force a spurious immediate
        # fire). Under-fire, never over-fire, and self-healing next tick.
        log "WARN cron: marker for '$name' unreadable/corrupt -- reinitialising without firing"
        _cron_write_marker "$marker" "$now" \
          || log "WARN cron: cannot reinitialise marker for '$name'"
        continue ;;
    esac
    # roles.py owns the cron_next_fire math; unparseable/error -> not-due.
    due="$(python3 "$ENGINE_HOME/lib/roles.py" cron-due "$schedule" "$last" "$now" 2>>"$SUPLOG")" || continue
    [ "$due" = "due" ] || continue
    # Advance the marker to now BEFORE firing, and only fire if that write
    # succeeded. This ordering is fail-safe in the under-fire direction: a
    # marker-write failure skips the fire (never re-fires every tick), and a
    # crash mid-session leaves the marker already advanced (waits for the next
    # window) rather than re-firing. The session's own rc does not gate the
    # marker -- a refused/failed session still waits for its next slot.
    if _cron_write_marker "$marker" "$now"; then
      log "cron: role '$name' due (schedule '$schedule') -- firing"
      run_session "$name" || log "cron: role '$name' session rc=$? (see supervisor.log)"
    else
      log "WARN cron: cannot advance marker for '$name' -- skipping fire this tick (avoids re-fire)"
    fi
  done
  return 0
}

# --- event bus (W2, issue #86) ----------------------------------------------
# Enumerate the target repo's event roles as NAME<TAB>EVENT[,EVENT...] lines
# (roles.py events contract). Behind a function so tests can override the seam.
# rc!=0 -> caller skips events this tick (best-effort, never crashes the loop).
_event_enumerate() {
  _roles_enumerate events "$AUTONOMY_TARGET_REPO"
}

# Print the current fireable-item tokens for <event>, one per line (empty = none;
# rc!=0 -> caller skips this event this tick). Number-keyed events use the item
# number (monotonic, open/closed-independent via --state all); pr.synchronize
# uses NUMBER:SHA (a push changes the SHA -> a new token). `gh -q` is gh's
# built-in query (no external jq), the pattern the loop already uses.
_event_poll() {
  local event="$1"
  case "$event" in
    pr.opened)
      (cd "$AUTONOMY_TARGET_REPO" && gh pr list --state all --limit 200 --json number -q '.[].number') 2>>"$SUPLOG" ;;
    issue.created)
      (cd "$AUTONOMY_TARGET_REPO" && gh issue list --state all --limit 200 --json number -q '.[].number') 2>>"$SUPLOG" ;;
    merge.done)
      (cd "$AUTONOMY_TARGET_REPO" && gh pr list --state merged --limit 200 --json number -q '.[].number') 2>>"$SUPLOG" ;;
    pr.synchronize)
      (cd "$AUTONOMY_TARGET_REPO" && gh pr list --state open --limit 200 --json number,headRefOid -q '.[] | "\(.number):\(.headRefOid)"') 2>>"$SUPLOG" ;;
    *) return 1 ;;
  esac
}

# Write the token set to a seen-file; rc!=0 on failure. Subshell contains the
# redirection so a failed '>' does not leak its error to stderr (as _cron_write_marker).
_event_write_seen() {
  ( printf '%s\n' "$2" >"$1" ) 2>/dev/null
}

# Process one event role's comma-separated on: list under the held lock. Split
# from resolve_event_wakes so the nested per-event loop stays readable.
_event_role_wakes() {
  local name="$1" events_csv="$2" session_ran="$3" event seen_file tokens new
  printf '%s\n' "$events_csv" | tr ',' '\n' | while IFS= read -r event; do
    [ -n "$event" ] || continue
    if [ "$event" = "session.done" ]; then
      # internal per-tick edge: a loop session ran this tick, never an
      # event/cron session (reentrancy guard -- no runaway self-trigger).
      [ "$session_ran" = "1" ] || continue
      log "event: role '$name' woken by session.done"
      run_session "$name" || log "event: role '$name' session rc=$? (see supervisor.log)"
      continue
    fi
    case "$event" in
      pr.opened|issue.created|merge.done|pr.synchronize) : ;;
      *) log "WARN event: unknown event '$event' for '$name' -- ignored"; continue ;;
    esac
    # The seen-set is the last-fired poll PAGE (bounded to --limit), not a
    # cumulative history -- correct because every v1 event token is monotonic or
    # terminal: PR/issue numbers only grow (--state all), merges are terminal. A
    # token that scrolls off the most-recent-N page can never re-enter it, so
    # replacing the seen-set with the current page never re-delivers an old item.
    # (A new event kind that is NOT monotonic would need a cumulative/high-water
    # cursor instead -- do not add one to this seen-set model naively.)
    seen_file="$VARDIR/events/${name}__${event}.seen"
    tokens="$(_event_poll "$event")" || continue   # poll failed -> skip this event
    if [ ! -f "$seen_file" ]; then
      _event_write_seen "$seen_file" "$tokens" \
        || log "WARN event: cannot seed seen-set for '$name/$event'"
      continue   # first-sight: baseline, no fire (no history replay)
    fi
    # New = current tokens not present as a full line in the seen FILE. grep
    # reads a file (no producer pipe to SIGPIPE, prevention-log #7); rc1 (no new)
    # is expected -> `|| true`.
    new="$(printf '%s\n' "$tokens" | grep -v '^[[:space:]]*$' | grep -Fxv -f "$seen_file" 2>/dev/null || true)"
    [ -n "$new" ] || continue
    log "event: role '$name' woken by $event ($(printf '%s' "$new" | tr '\n' ' '))"
    if run_session "$name"; then
      _event_write_seen "$seen_file" "$tokens" \
        || log "WARN event: cannot advance seen for '$name/$event' -- will re-deliver"
    else
      log "event: role '$name' session failed -- leaving seen (re-deliver next tick)"
    fi
  done
}

# Fire every event role whose on: list matched a NEW item since its per-(role,
# event) seen-set. The supervisor is the SOLE writer of each seen-set
# ($VARDIR/events/<role>__<event>.seen) -- reset-epoch-split invariant
# generalised. Delivery is AT-LEAST-ONCE within the poll page: a seen-set
# advances only after a successful dispatch, so a failed/refused session
# re-delivers next tick (the deliberate inverse of cron's under-fire ordering --
# a missed real-world event loses work). First-sight seeds the baseline WITHOUT
# firing. $1 = whether a loop session ran this tick (drives session.done).
# Additive + best-effort: enumeration/poll/write failure skips events this tick
# and leaves loop dispatch byte-for-byte unchanged. NEVER returns non-zero. Role
# names are charset-gated before they reach the seen-set path (prevention-log #6).
resolve_event_wakes() {
  local session_ran="$1"
  local enum name events_csv
  enum="$(_event_enumerate)" || return 0
  [ -n "$enum" ] || return 0
  mkdir -p "$VARDIR/events" 2>/dev/null || {
    log "WARN event: cannot create $VARDIR/events -- skipping events this tick"; return 0; }
  printf '%s\n' "$enum" | while IFS="$(printf '\t')" read -r name events_csv; do
    [ -n "$name" ] || continue
    # Charset-gate before the name reaches a seen-set path (_role_name_path_safe
    # is the single source shared with resolve_cron_due, #110).
    if ! _role_name_path_safe "$name"; then
      log "WARN event: role name '$name' has invalid path chars -- ignored"
      continue
    fi
    _event_role_wakes "$name" "$events_csv" "$session_ran"
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
  ROLE_SCOPE=""
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

# fail-safe honesty (#149): log a NOTE for each knob role $2 sets but the engine
# does not (yet) consume -- single-sourced from `roles.py knob-notes`, so a
# validated-but-silent no-op is never invisible.
# Best-effort: a roles.py hiccup or empty result logs nothing and never breaks
# the session (honesty is diagnostic, not a gate).
log_knob_notes() {
  local repo="$1" role="$2" notes _kn
  notes="$(python3 "$ENGINE_HOME/lib/roles.py" knob-notes "$repo" "$role" 2>>"$SUPLOG")" || return 0
  [ -n "$notes" ] || return 0
  # Quoted here-string: expands $notes once, then inserts the content literally
  # (no second round of $/backtick/word expansion on the message text).
  while IFS= read -r _kn; do
    [ -n "$_kn" ] && log "NOTE $_kn"
  done <<<"$notes"
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

  log_knob_notes "$AUTONOMY_TARGET_REPO" "$role"

  local log_file; log_file="$LOGDIR/session-$(date +%Y%m%dT%H%M%S).log"
  # Role sidecar (#148): the dashboard attributes the live session to its role
  # from this marker, NOT by parsing the voice log (fragile, races the tail).
  # Written before the session runs, best-effort -- a marker-write failure must
  # never block the session (the card just falls back to its default badge).
  printf '%s\n' "$role" >"${log_file%.log}.role" 2>>"$SUPLOG" || \
    log "NOTE could not write role marker for '$role' (dashboard falls back to default badge)"
  log "session start (role=$role model=$MODEL effort=${EFFORT:-default} auth=$auth_note) -> $log_file"

  # #177: narrate the live phase at the moment the agent is actually invoked --
  # all prep (preflight, adapter, auth, prompt/rules, role marker) is done, the
  # very next line runs the agent. Emitting it HERE (not at the call site) means
  # every caller -- loop, cron, event -- narrates a running session uniformly;
  # the main loop's own `dispatching <role>` covers the prep window before this.
  heartbeat "session-running $role" "running a $role session" ""

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
  AUTONOMY_LANE=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --repo) AUTONOMY_TARGET_REPO="$2"; shift 2 ;;
      --agent-type) AGENT_TYPE_OVERRIDE="$2"; shift 2 ;;
      --model) MODEL_OVERRIDE="$2"; shift 2 ;;
      --fallback-model) FALLBACK_MODEL_OVERRIDE="$2"; shift 2 ;;
      --effort) EFFORT_OVERRIDE="$2"; shift 2 ;;
      --label) LABEL_OVERRIDE="$2"; shift 2 ;;
      --lane) AUTONOMY_LANE="$2"; shift 2 ;;
      *) echo "unknown argument: $1" >&2; exit 1 ;;
    esac
  done

  [ -n "$AUTONOMY_TARGET_REPO" ] || { echo "usage: supervisor.sh --repo <path> [--agent-type ...] [--model ...] [--fallback-model ...] [--effort ...] [--label ...] [--lane <name>]" >&2; exit 1; }
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

  # This supervisor runs exactly one lane (SD-21). Refuse a --lane that is not a
  # declared, validly-configured lane rather than silently dispatching nothing.
  export AUTONOMY_LANE
  validate_lane || exit 1

  CFG="$AUTONOMY_TARGET_REPO/.autonomy/config.yaml"
  ACCOUNT_KEY="$(resolve_account_key)"
  SHARED_RESET_STATE="$(resolve_shared_reset_state "$ACCOUNT_KEY")"
  AGENT_TYPE="$(resolve_config_value "$CFG" agent.type "$AGENT_TYPE_OVERRIDE" claude)"
  MODEL="$(resolve_config_value "$CFG" agent.model.primary "$MODEL_OVERRIDE" claude-sonnet-5)"
  FALLBACK_MODEL="$(resolve_config_value "$CFG" agent.model.fallback "$FALLBACK_MODEL_OVERRIDE" claude-sonnet-4-6)"

  LOCK="$(supervisor_lock_dir "$AUTONOMY_TARGET_REPO")"
  acquire_supervisor_lock "$LOCK" || exit 0
  trap 'rm -rf "$LOCK"; heartbeat "stopped" "supervisor exited" ""; log "supervisor stopped."; exit 0' EXIT INT TERM

  log "=== supervisor start (pid $$, repo=$AUTONOMY_TARGET_REPO, agent=$AGENT_TYPE, model=$MODEL) ==="
  # #166: record the engine sha we froze at (dashboard update chip); the same
  # sha, in memory, is the #294 re-exec baseline. Empty (unreadable HEAD)
  # keeps the re-exec gate closed for this process's whole life.
  ENGINE_BOOT_SHA="$(write_engine_boot_sha "$ENGINE_HOME" "$LOGDIR")"
  reexec_disabled=0
  # A self-re-exec relaunches from RESOLVED values, not the raw argv: the loop
  # cd's around (preflight), so an originally-relative --repo would resolve
  # wrong (or not at all) at exec time and the fresh image would exit -- with
  # no process left. $AUTONOMY_TARGET_REPO was absolutized above; an empty
  # override means "was not passed" (the resolve_config_value contract), so
  # dropping empties reconstructs the original semantics exactly.
  REEXEC_ARGS=(--repo "$AUTONOMY_TARGET_REPO")
  [ -n "$AGENT_TYPE_OVERRIDE" ]     && REEXEC_ARGS+=(--agent-type "$AGENT_TYPE_OVERRIDE")
  [ -n "$MODEL_OVERRIDE" ]          && REEXEC_ARGS+=(--model "$MODEL_OVERRIDE")
  [ -n "$FALLBACK_MODEL_OVERRIDE" ] && REEXEC_ARGS+=(--fallback-model "$FALLBACK_MODEL_OVERRIDE")
  [ -n "$EFFORT_OVERRIDE" ]         && REEXEC_ARGS+=(--effort "$EFFORT_OVERRIDE")
  [ -n "$LABEL_OVERRIDE" ]          && REEXEC_ARGS+=(--label "$LABEL_OVERRIDE")
  [ -n "$AUTONOMY_LANE" ]           && REEXEC_ARGS+=(--lane "$AUTONOMY_LANE")
  err_backoff=$ERR_BACKOFF_START
  limit_backoff=$LIMIT_BACKOFF_START
  paused_logged=0
  role_rr=0
  # #318: consecutive fingerprint-skip counter (in-memory only; any session
  # actually run -- whatever its outcome -- resets it, as does a restart).
  fp_skips=0
  # Whether a loop session ran in the PREVIOUS iteration -- drives the
  # session.done event edge (checked at the top of the next iteration, so
  # session.done has at most one loop-cadence tick of latency). Only loop
  # sessions set it; cron/event-fired sessions do not (the reentrancy guard).
  session_ran=0

  while true; do
    # #294 self-re-exec, between sessions only, BEFORE the pause check so a
    # paused fleet still adopts merged engine code. should_reexec defers
    # while a session.done edge is pending and after one failed exec attempt
    # (never loop-exec); on success exec never returns (same pid, lock kept).
    if new_sha="$(should_reexec "$reexec_disabled" "$session_ran" "$ENGINE_HOME" "$ENGINE_BOOT_SHA")"; then
      log "re-exec onto $new_sha (was $ENGINE_BOOT_SHA) -- adopting new engine code"
      reexec_engine "$ENGINE_HOME" "${REEXEC_ARGS[@]}" || reexec_disabled=1
    fi

    # Graceful stop: checked at the top so any in-flight session has already
    # finished (never a mid-session kill). Idle-poll until the sentinel is
    # removed (resume). Under launchd KeepAlive=true, exiting would just be
    # relaunched -- idling is the only stop that actually holds.
    if pause_requested "$PAUSE_SENTINEL"; then
      if [ "$paused_logged" -eq 0 ]; then
        log "PAUSE sentinel present ($PAUSE_SENTINEL) -- graceful stop: current session finished, idling (remove to resume)"
        paused_logged=1
      fi
      heartbeat "paused" "paused by operator -- remove the PAUSE sentinel to resume" ""
      sleep "$PAUSE_POLL"; continue
    fi
    if [ "$paused_logged" -eq 1 ]; then
      log "PAUSE sentinel gone -- resuming"
      paused_logged=0
    fi

    # #252: sweep closed issues -> Done once per active iteration (a paused loop
    # reaches `continue` above and skips this). Best-effort; never perturbs the
    # loop. Placed before cron/dispatch so the board reflects reality as early
    # in the tick as possible.
    sweep_board

    # Cron scheduler (W1, #85): fire due cron roles under the held lock, one at
    # a time. Run BEFORE the board-empty / no-loop-role gates below so a cron
    # PM/researcher still fires when the coder board is empty or no loop role is
    # enabled (a cron-only repo must schedule) -- the spec's whole point. Purely
    # additive and best-effort: with no cron roles this is a no-op and the loop
    # behaves byte-for-byte as before.
    heartbeat "cron-check" "checking scheduled roles" ""
    resolve_cron_due

    # Event bus (W2, #86): wake event roles on new board/PR state, under the
    # held lock, one at a time. Also runs BEFORE the board-empty gate so an
    # event role (e.g. QA on pr.opened) fires regardless of the coder board.
    # Passes last iteration's loop-session flag for the session.done edge, then
    # consumes it. Additive/best-effort: no event roles = no-op.
    heartbeat "polling-events" "polling board/PR events" ""
    resolve_event_wakes "$session_ran"
    session_ran=0

    open_count="$(cd "$AUTONOMY_TARGET_REPO" && gh issue list --state open --json number -q 'length' 2>/dev/null || echo -1)"
    if [ "$open_count" = "0" ]; then
      dirty_skips=0
      log "board empty -- idle ${EMPTY_IDLE}s"
      heartbeat "board-empty" "no open issues -- idle" "$(( $(date -u +%s) + EMPTY_IDLE ))"
      sleep "$EMPTY_IDLE"; continue
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
      log "no loop roles enabled -- idle ${EMPTY_IDLE}s"
      heartbeat "idle" "no loop roles enabled -- idle" "$(( $(date -u +%s) + EMPTY_IDLE ))"
      sleep "$EMPTY_IDLE"; continue
    fi
    # shellcheck disable=SC2086  # intentional split: names are [A-Za-z0-9._-] tokens
    role="$(select_role "$role_rr" $dispatch_list)"
    role_rr=$(( (role_rr + 1) % 86400 ))

    # #318: fingerprint gate -- skip the session (zero LLM tokens) ONLY when
    # the observable world exactly matches state a previous COMPLETED session
    # for this role already examined and declined to act on. Any doubt falls
    # through to dispatch. Runs AFTER the cron/event resolvers above, so
    # scheduled roles fire every active tick regardless of this gate; the
    # skip leaves session_ran untouched (no fabricated session.done edge).
    if fingerprint_gate "$role"; then
      fp_skips=$((fp_skips + 1))
      fp_wait="$(fingerprint_backoff "$fp_skips")"
      # Long sleeps would starve the top-of-tick cron/event resolvers -- cap
      # the idle when this repo schedules any (a skipped tick costs a few gh
      # calls, zero LLM tokens).
      if [ "$fp_wait" -gt 300 ] && has_scheduled_roles; then fp_wait=300; fi
      log "fingerprint unchanged for $role -- skip #$fp_skips, idle ${fp_wait}s (zero-token)"
      heartbeat "fingerprint-idle" "board unchanged since last completed $role session -- zero-token skip" "$(( $(date -u +%s) + fp_wait ))"
      idle_sleep "$fp_wait"
      continue
    fi

    # #177: the prep window (auth, preflight, worktree) narrates as `dispatching`
    # -- run_session flips it to `session-running <role>` the instant the agent
    # is actually invoked, so the card never reads "running a session" while it
    # is only getting ready to (or is about to refuse and back off).
    heartbeat "dispatching $role" "selected $role -- preparing session (auth, preflight, worktree)" ""
    run_session "$role"; outcome=$?
    # #318: a session actually RAN (whatever its outcome) -- only now does the
    # consecutive-skip backoff counter reset, exactly as documented.
    fp_skips=0
    # #245: release the `main` ref before the post-session idle window -- an
    # agent may end its ticket sitting on an attached `main`, which would block
    # a sibling primary checkout until the next preflight. No-op unless we are
    # on a clean, attached `main`; never detaches over WIP.
    session_end_park
    case $outcome in
      0) log "session clean (open issues ~$open_count). pace ${PACE}s"
         heartbeat "pace-wait" "session clean (open issues ~$open_count) -- next session soon" "$(( $(date -u +%s) + PACE ))"
         # A loop session actually COMPLETED -> session.done fires next tick.
         # Only outcome 0 counts: a preflight/dispatch REFUSAL (rc 2), a
         # usage-limit pause (rc 3), or a session error must NOT fabricate a
         # session.done edge for work that did not run (fail-safe).
         session_ran=1
         # #318: record what this tick OBSERVED before the session (FP_CURRENT
         # from fingerprint_gate) -- a clean session has now examined exactly
         # that world, so an identical future tick may skip. Outcome 0 only.
         record_fingerprint "$role" "${AUTONOMY_LANE:-}" "$FP_CURRENT"
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
           heartbeat "limit-backoff" "usage limit -- resuming at API-reported reset" "$(( $(date -u +%s) + reset_wait ))"
           sleep "$reset_wait"
           limit_backoff=$LIMIT_BACKOFF_START
         else
           log "USAGE LIMIT (no reset signal) -- exp backoff $((limit_backoff + jitter))s then retry"
           heartbeat "limit-backoff" "usage limit (no reset signal) -- exponential backoff" "$(( $(date -u +%s) + limit_backoff + jitter ))"
           sleep $((limit_backoff + jitter))
           limit_backoff=$(( limit_backoff*2 < LIMIT_BACKOFF_MAX ? limit_backoff*2 : LIMIT_BACKOFF_MAX ))
         fi ;;
      2) log "preflight/dispatch skip -- wait ${ERR_BACKOFF_START}s"
         heartbeat "preflight-hold" "preflight/dispatch skip (dirty tree or pack issue)" "$(( $(date -u +%s) + ERR_BACKOFF_START ))"
         sleep "$ERR_BACKOFF_START" ;;
      *) log "session error (rc=$outcome) -- backoff ${err_backoff}s"
         heartbeat "error-backoff" "session error (rc=$outcome) -- exponential backoff" "$(( $(date -u +%s) + err_backoff ))"
         sleep "$err_backoff"
         err_backoff=$(( err_backoff*2 < ERR_BACKOFF_MAX ? err_backoff*2 : ERR_BACKOFF_MAX )) ;;
    esac
  done
fi
