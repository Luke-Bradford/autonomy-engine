#!/usr/bin/env bash
# bin/quickstart.sh -- guided single-entry onboarding for a target repo
# (issue #38). Chains the existing tools; adds NO new capability, only
# sequencing and prompting:
#
#   1. onboard.sh                  scaffold the .autonomy/ pack (idempotent)
#   2. guided minimum config       board.owner, board.project_title,
#                                  agent.model.primary, merge_gate.strategy
#                                  (writes via config_parser.py --set,
#                                  comment-preserving; Enter keeps current)
#   3. doctor.sh                   full readiness report, verbatim
#   4. optional setup_worktree.sh  worktree + launchd plist (y/N, default no)
#   5. optional dashboard register append the loop path to
#                                  ~/.config/autonomy/repos (y/N, default no)
#   6. printed next steps          the launchctl bootstrap + dashboard lines
#
# quickstart NEVER runs launchctl -- going live stays a deliberate operator
# step (same diagnostic-honest stance as doctor.sh). Idempotent: re-running
# and pressing Enter everywhere leaves config.yaml byte-identical.
#
# Usage: quickstart.sh <target-repo>
#          [--board-owner <login>] [--board-title <title>] [--model <id>]
#          [--merge-gate manual|ci_only|bot_comment|gh_review]
#          [--worktree yes|no] [--register yes|no]
# Every prompt has a flag twin, so the whole run can be non-interactive.
# Invalid flag values fail immediately; invalid interactive answers warn and
# re-prompt (EOF keeps the current value).
set -euo pipefail
ENGINE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Reused single-source functions: valid_model_id (supervisor.sh, kept in
# parity with dashboard_control._MODEL_RE), derive_slug/resolve_worktree_path
# + CONFIG_GET (setup_worktree.sh). Both files are functions-only when
# sourced (guarded executable bodies).
# shellcheck source=/dev/null
source "$ENGINE_HOME/bin/supervisor.sh"
# shellcheck source=/dev/null
source "$ENGINE_HOME/bin/setup_worktree.sh"

qs_valid_strategy() {
  case "$1" in manual|ci_only|bot_comment|gh_review) return 0 ;; *) return 1 ;; esac
}

# Prompt for one config value. $1 label, $2 current value, $3 optional
# validator function. Empty answer or EOF keeps the current value; an answer
# the validator rejects warns and re-prompts (EOF during re-prompt also keeps
# current, so a piped run can never loop forever). Prompts go to stderr; the
# chosen value is this function's stdout.
qs_prompt() {
  local label="$1" current="$2" validator="${3:-}" ans eof
  while :; do
    printf '%s [%s]: ' "$label" "$current" >&2
    eof=0
    IFS= read -r ans || eof=1   # EOF still fills $ans with a partial last line
    if [ -z "$ans" ]; then
      printf '%s' "$current"
      return 0
    fi
    if [ -z "$validator" ] || "$validator" "$ans"; then
      printf '%s' "$ans"
      return 0
    fi
    printf 'quickstart.sh: invalid value for %s: %s\n' "$label" "$ans" >&2
    if [ "$eof" -ne 0 ]; then
      printf '%s' "$current"
      return 0
    fi
  done
}

# y/N confirm. Returns 0 only on an explicit yes; empty answer or EOF means no.
qs_confirm() {
  local ans
  printf '%s [y/N]: ' "$1" >&2
  IFS= read -r ans || ans=""
  case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# Comment-preserving config write; no-op (byte-identical) on an unchanged value.
qs_set() {
  python3 "$ENGINE_HOME/lib/config_parser.py" --set "$1" "$2" "$3"
}

# Append-if-missing registration for dashboard.py's repo discovery.
qs_register_repo() {
  local repos_file="$1" path="$2"
  mkdir -p "$(dirname "$repos_file")"
  if [ -f "$repos_file" ] && grep -qxF "$path" "$repos_file"; then
    echo "already registered in $repos_file"
  else
    printf '%s\n' "$path" >> "$repos_file"
    echo "registered $path in $repos_file"
  fi
}

qs_usage() {
  cat >&2 <<'EOF'
usage: quickstart.sh <target-repo>
         [--board-owner <login>] [--board-title <title>] [--model <id>]
         [--merge-gate manual|ci_only|bot_comment|gh_review]
         [--worktree yes|no] [--register yes|no]

Guided single-entry onboarding: onboard -> minimum config -> doctor ->
optional worktree -> optional dashboard registration -> printed next steps.
Every prompt has a flag twin for non-interactive use. Never runs launchctl.
EOF
}

[ "${BASH_SOURCE[0]}" = "${0}" ] || return 0

TARGET=""
BOARD_OWNER="" BOARD_TITLE="" MODEL="" MERGE_GATE=""
WORKTREE_MODE="" REGISTER_MODE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --board-owner)  BOARD_OWNER="${2:?--board-owner needs a value}"; shift 2 ;;
    --board-title)  BOARD_TITLE="${2:?--board-title needs a value}"; shift 2 ;;
    --model)        MODEL="${2:?--model needs a value}"; shift 2 ;;
    --merge-gate)   MERGE_GATE="${2:?--merge-gate needs a value}"; shift 2 ;;
    --worktree)     WORKTREE_MODE="${2:?--worktree needs yes|no}"; shift 2 ;;
    --register)     REGISTER_MODE="${2:?--register needs yes|no}"; shift 2 ;;
    -h|--help)      qs_usage; exit 0 ;;
    -*)             echo "quickstart.sh: unknown flag $1" >&2; qs_usage; exit 2 ;;
    *)              if [ -z "$TARGET" ]; then TARGET="$1"; shift
                    else echo "quickstart.sh: unexpected argument $1" >&2; qs_usage; exit 2; fi ;;
  esac
done

[ -n "$TARGET" ] || { qs_usage; exit 2; }
[ -d "$TARGET" ] || { echo "quickstart.sh: target '$TARGET' is not a directory" >&2; exit 2; }
TARGET_REPO="$(cd "$TARGET" && pwd)"

# Flag values fail loud up-front -- a non-interactive run must never silently
# keep the old value because a flag was mistyped.
if [ -n "$MERGE_GATE" ] && ! qs_valid_strategy "$MERGE_GATE"; then
  echo "quickstart.sh: invalid --merge-gate '$MERGE_GATE' (valid: manual|ci_only|bot_comment|gh_review)" >&2
  exit 2
fi
if [ -n "$MODEL" ] && ! valid_model_id "$MODEL"; then
  echo "quickstart.sh: invalid --model '$MODEL'" >&2
  exit 2
fi
case "$WORKTREE_MODE" in ""|yes|no) ;; *) echo "quickstart.sh: --worktree takes yes|no" >&2; exit 2 ;; esac
case "$REGISTER_MODE" in ""|yes|no) ;; *) echo "quickstart.sh: --register takes yes|no" >&2; exit 2 ;; esac

echo "== quickstart: $TARGET_REPO =="

echo ""
echo "-- step 1/5: scaffold the .autonomy/ pack (idempotent, never overwrites)"
"$ENGINE_HOME/bin/onboard.sh" "$TARGET_REPO"
CFG="$TARGET_REPO/.autonomy/config.yaml"

echo ""
echo "-- step 2/5: minimum config (Enter keeps the value shown in brackets)"
cur="$(CONFIG_GET "$CFG" board.owner || printf '')"
val="${BOARD_OWNER:-$(qs_prompt "board.owner" "$cur")}"
qs_set "$CFG" board.owner "$val"
cur="$(CONFIG_GET "$CFG" board.project_title || printf '')"
val="${BOARD_TITLE:-$(qs_prompt "board.project_title" "$cur")}"
qs_set "$CFG" board.project_title "$val"
cur="$(CONFIG_GET "$CFG" agent.model.primary || printf '')"
val="${MODEL:-$(qs_prompt "agent.model.primary" "$cur" valid_model_id)}"
qs_set "$CFG" agent.model.primary "$val"
cur="$(CONFIG_GET "$CFG" merge_gate.strategy || printf '')"
val="${MERGE_GATE:-$(qs_prompt "merge_gate.strategy (manual|ci_only|bot_comment|gh_review)" "$cur" qs_valid_strategy)}"
qs_set "$CFG" merge_gate.strategy "$val"

echo ""
echo "-- step 3/5: readiness report (doctor.sh, diagnostic-only)"
doctor_rc=0
"$ENGINE_HOME/bin/doctor.sh" "$TARGET_REPO" || doctor_rc=$?

# Slug/worktree path via setup_worktree.sh's own functions, so the printed
# next steps name exactly what setup_worktree would (and did) create.
SLUG="$(derive_slug)"
WORKTREE="$(resolve_worktree_path "")"
LABEL="com.autonomy.${SLUG}.supervisor"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

echo ""
echo "-- step 4/5: dedicated worktree + launchd plist (setup_worktree.sh)"
do_worktree=no
case "$WORKTREE_MODE" in
  yes) do_worktree=yes ;;
  no)  echo "skipped (--worktree no)" ;;
  "")  if qs_confirm "create the dedicated worktree + install the launchd plist now?"; then
         do_worktree=yes
       else
         echo "skipped"
       fi ;;
esac
worktree_failed=0
if [ "$do_worktree" = yes ]; then
  if ! "$ENGINE_HOME/bin/setup_worktree.sh" "$TARGET_REPO"; then
    worktree_failed=1
    echo "quickstart.sh: WARN setup_worktree.sh failed -- fix the cause and re-run quickstart; continuing" >&2
  fi
fi

# The path the loop (and so the dashboard) runs against: the worktree once it
# exists, else the target repo itself.
LOOP_PATH="$TARGET_REPO"
if [ -d "$WORKTREE" ]; then LOOP_PATH="$WORKTREE"; fi

echo ""
echo "-- step 5/5: dashboard repo registration (~/.config/autonomy/repos)"
do_register=no
case "$REGISTER_MODE" in
  yes) do_register=yes ;;
  no)  echo "skipped (--register no)" ;;
  "")  if qs_confirm "register $LOOP_PATH for dashboard.py's default discovery?"; then
         do_register=yes
       else
         echo "skipped"
       fi ;;
esac
if [ "$do_register" = yes ]; then
  qs_register_repo "$HOME/.config/autonomy/repos" "$LOOP_PATH"
fi

echo ""
echo "== next steps (deliberate operator actions -- quickstart NEVER runs these) =="
if [ "$do_worktree" != yes ] || [ "$worktree_failed" -ne 0 ]; then
  echo "  create the worktree + plist when ready:"
  echo "    $ENGINE_HOME/bin/setup_worktree.sh \"$TARGET_REPO\""
fi
cat <<EOF
  go live (loads the supervisor; survives reboot via the plist's RunAtLoad):
    launchctl bootout   gui/\$(id -u)/$LABEL 2>/dev/null || true
    launchctl bootstrap gui/\$(id -u) "$PLIST"
  watch it:
    tail -f "$LOOP_PATH/var/autonomy-logs/supervisor.log"
    $ENGINE_HOME/bin/dashboard.py --repo "$LOOP_PATH"   # then open http://127.0.0.1:8787/
  pause / resume without killing a session:
    touch "$LOOP_PATH/var/autonomy-logs/autonomy-PAUSE"   # graceful stop
    rm    "$LOOP_PATH/var/autonomy-logs/autonomy-PAUSE"   # resume
EOF

rc=0
if [ "$worktree_failed" -ne 0 ]; then rc=1; fi
if [ "$doctor_rc" -ne 0 ]; then
  echo "quickstart.sh: doctor reported hard failures above -- fix them before going live" >&2
  rc=1
fi
exit "$rc"
