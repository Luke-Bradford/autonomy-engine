#!/usr/bin/env bash
# bin/doctor.sh -- diagnostic readiness check for a target repo. Two entry
# points:
#   doctor_preflight_check <target-repo>  -- fast, local-only, called by
#     supervisor.sh on every loop iteration. Hard-fails only on what would
#     actually break the loop.
#   doctor_full_report <target-repo>      -- the full report (adds network
#     calls: gh auth scopes, review-bot workflow, GH Projects v2 board,
#     branch protection). Diagnostic/read-only -- never provisions anything.
#
# Run standalone:  bin/doctor.sh <target-repo>
set -uo pipefail
DOCTOR_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

doctor_preflight_check() {
  local repo="$1"
  if [ ! -f "$repo/.autonomy/config.yaml" ]; then
    echo "doctor: FAIL -- $repo/.autonomy/config.yaml not found" >&2
    return 1
  fi
  if ! python3 "$DOCTOR_HOME/lib/config_parser.py" "$repo/.autonomy/config.yaml" __validate__ >/dev/null 2>&1; then
    echo "doctor: FAIL -- $repo/.autonomy/config.yaml does not parse" >&2
    return 1
  fi
  local requires_md
  requires_md="$(python3 "$DOCTOR_HOME/lib/config_parser.py" "$repo/.autonomy/config.yaml" engine.requires_claude_md 2>/dev/null || echo false)"
  # Claude Code loads CLAUDE.md from the repo root AND .claude/; accept either.
  if [ "$requires_md" = "true" ] \
     && [ ! -f "$repo/CLAUDE.md" ] && [ ! -f "$repo/.claude/CLAUDE.md" ]; then
    echo "doctor: FAIL -- engine.requires_claude_md is true but neither $repo/CLAUDE.md nor $repo/.claude/CLAUDE.md exists -- scaffold a starter with 'bin/onboard.sh $repo --claude-md' (or run /init in Claude Code)" >&2
    return 1
  fi
  return 0
}

# QA role readiness (#13): enabled-with-actions-substrate needs the
# qa-merge-gate workflow installed in the target repo; a routine substrate
# can't be verified locally. Prints exactly one OK/WARN line, or nothing when
# the QA role is not enabled. Diagnostic-only, never provisions.
doctor_qa_role_check() {
  local repo="$1" cfg="$1/.autonomy/config.yaml" qa_enabled qa_sub
  qa_enabled="$(python3 "$DOCTOR_HOME/lib/config_parser.py" "$cfg" roles.qa.enabled 2>/dev/null || echo false)"
  [ "$qa_enabled" = "true" ] || return 0
  qa_sub="$(python3 "$DOCTOR_HOME/lib/config_parser.py" "$cfg" roles.qa.substrate 2>/dev/null || echo)"
  case "$qa_sub" in
    actions)
      if grep -rlq "qa-gate" "$repo/.github/workflows" 2>/dev/null; then
        echo "OK   qa role (actions): qa-merge-gate workflow found under .github/workflows"
      else
        echo "WARN qa role enabled with substrate=actions but no qa-gate workflow under .github/workflows -- copy the engine's templates/qa-merge-gate.yml (and set the ANTHROPIC_API_KEY secret) or the role never fires"
      fi ;;
    routine)
      echo "WARN qa role uses substrate=routine -- cannot be verified locally; confirm the routine exists in claude.ai and points at this repo" ;;
    *)
      echo "WARN qa role enabled with substrate='${qa_sub:-unset}' -- the QA merge gate ships for 'actions' (or 'routine'); other substrates are not implemented" ;;
  esac
}

doctor_full_report() {
  local repo="$1" hard_fail=0
  echo "== doctor.sh report: $repo =="

  if doctor_preflight_check "$repo" 2>/tmp/doctor_preflight_err.$$; then
    echo "OK   .autonomy/ present, config.yaml valid"
  else
    cat /tmp/doctor_preflight_err.$$
    hard_fail=1
  fi
  rm -f /tmp/doctor_preflight_err.$$

  if [ -f "$repo/CLAUDE.md" ]; then
    echo "OK   CLAUDE.md present (repo root)"
  elif [ -f "$repo/.claude/CLAUDE.md" ]; then
    echo "OK   .claude/CLAUDE.md present"
  else
    local requires_md
    requires_md="$(python3 "$DOCTOR_HOME/lib/config_parser.py" "$repo/.autonomy/config.yaml" engine.requires_claude_md 2>/dev/null || echo false)"
    if [ "$requires_md" != "true" ]; then
      echo "WARN no CLAUDE.md found (repo root or .claude/) -- scaffold a starter with 'bin/onboard.sh $repo --claude-md', run /init in Claude Code, or use the claude-md-management:claude-md-improver skill"
    fi
  fi

  local strategy
  strategy="$(python3 "$DOCTOR_HOME/lib/config_parser.py" "$repo/.autonomy/config.yaml" merge_gate.strategy 2>/dev/null || echo manual)"
  strategy="${strategy:-manual}"
  if [ "$strategy" = "bot_comment" ]; then
    if [ -d "$repo/.github/workflows" ] && grep -rlE 'anthropic\.com/v1/messages|ANTHROPIC_API_KEY' "$repo/.github/workflows" >/dev/null 2>&1; then
      echo "OK   review-bot workflow found under .github/workflows (merge_gate.strategy=bot_comment)"
    else
      echo "WARN no review-bot workflow found under .github/workflows -- merge_gate.strategy=bot_comment will never see an APPROVE and every PR will stall. Add a workflow, or switch to manual/ci_only."
    fi
  fi

  # roles: block (multi-role org, #12) -- absent is fine (defaults: coder
  # only); present-but-invalid is a hard misconfig worth failing the report.
  # roles.py's exit code carries the whole verdict (0 valid / 3 valid-absent /
  # else invalid) and 2>&1 keeps its parse errors in the FAIL detail.
  local roles_out roles_rc
  roles_out="$(python3 "$DOCTOR_HOME/lib/roles.py" "$repo" 2>&1)"; roles_rc=$?
  case "$roles_rc" in
    0) echo "OK   roles: block valid" ;;
    3) echo "OK   no roles: block -- defaults apply (coder loop only)" ;;
    2) echo "FAIL roles: cannot read config.yaml:"
       echo "$roles_out" | sed 's/^/     /'
       hard_fail=1 ;;
    *) echo "FAIL roles: block invalid:"
       echo "$roles_out" | sed 's/^/     /'
       hard_fail=1 ;;
  esac
  doctor_qa_role_check "$repo"

  if (cd "$repo" && gh auth status >/dev/null 2>&1); then
    echo "OK   gh auth status ok"
  else
    echo "WARN gh auth status failed -- run 'gh auth login' (need repo + project scopes)"
  fi

  local owner project_title
  owner="$(python3 "$DOCTOR_HOME/lib/config_parser.py" "$repo/.autonomy/config.yaml" board.owner 2>/dev/null || echo)"
  project_title="$(python3 "$DOCTOR_HOME/lib/config_parser.py" "$repo/.autonomy/config.yaml" board.project_title 2>/dev/null || echo)"
  if [ -n "$owner" ] && [ -n "$project_title" ]; then
    # shellcheck source=/dev/null
    source "$DOCTOR_HOME/bin/board.sh"
    ids="$(board_resolve_project "$owner" "$project_title")"
    read -r pid _ _ <<<"$ids"
    if [ -n "$pid" ]; then
      echo "OK   board '$project_title' found under '$owner'"
    else
      echo "WARN GitHub Projects v2 board '$project_title' not found under '$owner' -- board.sh will silently skip status updates"
    fi
  else
    echo "WARN board.owner/board.project_title not set in config.yaml -- board status updates will be skipped"
  fi

  if (cd "$repo" && gh api "repos/{owner}/{repo}/branches/main/protection" >/dev/null 2>&1); then
    echo "OK   branch protection configured on main"
  else
    echo "WARN no branch protection detected on main -- safe_merge.sh is the *local* gate only; consider adding required status checks"
  fi

  return "$hard_fail"
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  TARGET="${1:?usage: doctor.sh <target-repo>}"
  doctor_full_report "$(cd "$TARGET" && pwd)"
  exit $?
fi
