#!/usr/bin/env bash
# bin/safe_merge.sh -- generic mechanical merge gate. Refuses to merge unless
# the target repo's .autonomy/config.yaml merge_gate.strategy is satisfied on
# the PR's LATEST commit. Run FROM the target repo checkout.
#
# Usage: safe_merge.sh <pr-number>
set -euo pipefail
SAFE_MERGE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Doc-only predicate, parameterized by the strategy's configured extension
# list (comma-separated, e.g. ".md,.rst"). Pure string logic, unit-tested.
is_doc_only() {
  local files="$1" extensions_csv="$2"
  [ -n "$files" ] || return 1
  local ext pattern="" IFS=','
  read -ra exts <<<"$extensions_csv"
  for ext in "${exts[@]}"; do
    ext="$(printf '%s' "$ext" | sed 's/^\.//')"
    if [ -n "$pattern" ]; then pattern="$pattern|"; fi
    pattern="${pattern}\\.${ext}\$"
  done
  ! printf '%s\n' "$files" | grep -qvE "$pattern"
}

# CI check, generalized (Codex finding: a `gh` API failure must never look
# identical to "green"). Returns 0 = green, 1 = refuse.
ci_check() {
  local pr="$1" strategy="$2"
  local checks_json
  if ! checks_json="$(gh pr checks "$pr" --json name,state 2>/dev/null)"; then
    echo "safe_merge: REFUSE -- cannot verify CI state (gh pr checks failed) -- refusing rather than assuming green" >&2
    return 1
  fi
  if echo "$checks_json" | grep -qiE '"state":"(fail|failure|error|cancelled|timed_out)"'; then
    echo "safe_merge: REFUSE -- a CI check failed on #$pr" >&2
    return 1
  fi
  if echo "$checks_json" | grep -qiE '"state":"(pending|queued|in_progress)"'; then
    echo "safe_merge: REFUSE -- CI still running on #$pr (re-check later)" >&2
    return 1
  fi
  if [ "$strategy" = "ci_only" ] && [ "$checks_json" = "[]" ]; then
    echo "safe_merge: REFUSE -- ci_only requires at least one configured check; use manual for a repo with no CI, or add one" >&2
    return 1
  fi
  return 0
}

# ISO-8601 -> epoch seconds (#1). Python because it is portable (BSD/GNU date
# flags differ) and robust to fractional seconds / explicit offsets -- the
# exact formats that silently break a lexicographic compare ('.' sorts before
# 'Z', so a LATER ...00.500Z would string-compare as earlier than ...00Z).
# Nonzero rc on garbage -- callers refuse rather than guess.
iso_epoch() {
  python3 -c '
import sys
from datetime import datetime, timezone
try:
    dt = datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    print(int(dt.timestamp()))
except (ValueError, IndexError):
    sys.exit(1)' "$1" 2>/dev/null
}

# rc 0 = review at/after head commit; 1 = review predates head (gate reset by
# the push); 2 = a timestamp would not parse (caller REFUSES -- fail-safe,
# never guesses chronology).
review_postdates_head() {
  local review_epoch head_epoch
  review_epoch="$(iso_epoch "$1")" || return 2
  head_epoch="$(iso_epoch "$2")" || return 2
  [ "$review_epoch" -ge "$head_epoch" ]
}

merge_gate_bot_comment() {
  local pr="$1" author_login="$2" marker="$3" doc_only_extensions="$4"
  local head_time; head_time="$(gh pr view "$pr" --json commits -q '.commits[-1].committedDate')"
  [ -n "$head_time" ] || { echo "safe_merge: cannot resolve PR #$pr head commit time" >&2; return 1; }

  local files n_listed n_changed
  files="$(gh api --paginate "repos/{owner}/{repo}/pulls/$pr/files" --jq '.[].filename')"
  n_listed="$(printf '%s\n' "$files" | grep -c . || true)"
  n_changed="$(gh pr view "$pr" --json changedFiles -q '.changedFiles')"
  if [ "$n_listed" = "$n_changed" ] && is_doc_only "$files" "$doc_only_extensions"; then
    local doc_block
    doc_block="$(gh pr view "$pr" --json comments -q \
      "[.comments[] | select(.author.login==\"$author_login\" and (.body|contains(\"$marker\")))]
       | sort_by(.createdAt) | last | .body // \"\"")"
    if printf '%s' "$doc_block" | grep -qiE 'REQUEST CHANGES|\[BLOCKING\]|must fix before merge'; then
      echo "safe_merge: REFUSE -- doc-only PR #$pr but latest bot comment blocks" >&2
      return 1
    fi
    echo "safe_merge: doc-only PR #$pr (every changed file matches doc_only_extensions), CI green, no blocking comment -- merging."
    return 0
  fi

  local latest
  latest="$(gh pr view "$pr" --json comments -q \
    "[.comments[] | select(.author.login==\"$author_login\" and (.body|contains(\"$marker\")))]
     | sort_by(.createdAt) | last")"
  [ -n "$latest" ] && [ "$latest" != "null" ] || {
    echo "safe_merge: REFUSE -- no review comment from $author_login on #$pr yet" >&2; return 1; }
  local review_time review_body
  review_time="$(printf '%s' "$latest" | python3 -c 'import sys,json;print(json.load(sys.stdin)["createdAt"])')"
  review_body="$(printf '%s' "$latest" | python3 -c 'import sys,json;print(json.load(sys.stdin)["body"])')"

  review_postdates_head "$review_time" "$head_time"
  case $? in
    1) echo "safe_merge: REFUSE -- latest review ($review_time) predates head commit ($head_time); push reset the gate" >&2
       return 1 ;;
    2) echo "safe_merge: REFUSE -- cannot parse review/head timestamps ('$review_time' vs '$head_time') -- refusing rather than guessing chronology" >&2
       return 1 ;;
  esac
  if printf '%s' "$review_body" | grep -qiE 'REQUEST CHANGES|\[BLOCKING\]|must fix before merge'; then
    echo "safe_merge: REFUSE -- latest review requests changes / has blocking findings" >&2
    return 1
  fi
  if ! printf '%s' "$review_body" | grep -qiE 'APPROVE'; then
    echo "safe_merge: REFUSE -- latest review is not an APPROVE" >&2
    return 1
  fi
  echo "safe_merge: gates pass on #$pr (review $review_time >= head $head_time) -- merging."
  return 0
}

merge_gate_gh_review() {
  local pr="$1" reviewer_login="$2"
  [ -n "$reviewer_login" ] || { echo "safe_merge: REFUSE -- merge_gate.strategy=gh_review but reviewer_login is not set in config.yaml" >&2; return 1; }
  local head_time; head_time="$(gh pr view "$pr" --json commits -q '.commits[-1].committedDate')"
  [ -n "$head_time" ] || { echo "safe_merge: cannot resolve PR #$pr head commit time" >&2; return 1; }

  local latest
  latest="$(gh pr view "$pr" --json reviews -q \
    "[.reviews[] | select(.author.login==\"$reviewer_login\")] | sort_by(.submittedAt) | last")"
  [ -n "$latest" ] && [ "$latest" != "null" ] || {
    echo "safe_merge: REFUSE -- no review from $reviewer_login on #$pr yet" >&2; return 1; }
  local review_time review_state
  review_time="$(printf '%s' "$latest" | python3 -c 'import sys,json;print(json.load(sys.stdin)["submittedAt"])')"
  review_state="$(printf '%s' "$latest" | python3 -c 'import sys,json;print(json.load(sys.stdin)["state"])')"

  review_postdates_head "$review_time" "$head_time"
  case $? in
    1) echo "safe_merge: REFUSE -- latest review from $reviewer_login ($review_time) predates head commit ($head_time)" >&2
       return 1 ;;
    2) echo "safe_merge: REFUSE -- cannot parse review/head timestamps ('$review_time' vs '$head_time') -- refusing rather than guessing chronology" >&2
       return 1 ;;
  esac
  if [ "$review_state" != "APPROVED" ]; then
    echo "safe_merge: REFUSE -- latest review from $reviewer_login is '$review_state', not APPROVED" >&2
    return 1
  fi
  echo "safe_merge: gates pass on #$pr ($reviewer_login APPROVED at $review_time >= head $head_time) -- merging."
  return 0
}

# Merge the PR and delete its remote branch. Deliberately NOT `gh pr merge
# --delete-branch`: that does a post-merge LOCAL `git checkout <base>` to move
# off the merged branch, which git refuses under a sibling-worktree topology
# (the base branch checked out in another worktree) with
# `fatal: '<base>' is already used by worktree` -- the merge still succeeds but
# the confusing error prints and local cleanup is skipped (#72). So merge via
# the API only, then delete the remote ref explicitly -- no local branch touch.
# A failed remote-branch delete is cosmetic and never fails the merge.
complete_merge() {
  local pr="$1" info state head_branch is_fork
  gh pr merge "$pr" --squash || return 1
  # Confirm the merge actually LANDED before treating it as done: `gh pr merge`
  # can succeed by enabling auto-merge / queueing rather than merging now, and
  # a caller must never run post-merge steps on an unmerged PR (fail-safe).
  info="$(gh pr view "$pr" --json state,headRefName,isCrossRepository \
          -q '.state + " " + .headRefName + " " + (.isCrossRepository|tostring)' 2>/dev/null)"
  read -r state head_branch is_fork <<EOF
$info
EOF
  if [ "$state" != "MERGED" ]; then
    echo "safe_merge: REFUSE -- 'gh pr merge' returned success but PR #$pr state is '${state:-unknown}', not MERGED" >&2
    return 1
  fi
  # Delete the remote branch explicitly. Skip fork PRs: their head branch lives
  # in ANOTHER repo, so deleting repos/{owner}/{repo}/refs/heads/<name> would
  # hit the base repo -- possibly an unrelated same-named branch. A failed
  # delete is cosmetic and never fails the merge.
  if [ -n "$head_branch" ] && [ "$is_fork" != "true" ]; then
    gh api -X DELETE "repos/{owner}/{repo}/git/refs/heads/$head_branch" >/dev/null 2>&1 \
      || echo "safe_merge: note -- merged #$pr but could not delete remote branch '$head_branch' (delete it manually)" >&2
  fi
  return 0
}

[ "${BASH_SOURCE[0]}" = "${0}" ] || return 0

PR="${1:?usage: safe_merge.sh <pr-number>}"
CONFIG_GET() { python3 "$SAFE_MERGE_HOME/lib/config_parser.py" .autonomy/config.yaml "$1" 2>/dev/null; }

STRATEGY="$(CONFIG_GET merge_gate.strategy)"; STRATEGY="${STRATEGY:-manual}"

if [ "$STRATEGY" = "manual" ]; then
  echo "safe_merge: manual-mode -- PR #$PR left open for the operator to review/merge."
  exit 0
fi

ci_check "$PR" "$STRATEGY" || exit 1

case "$STRATEGY" in
  ci_only)
    echo "safe_merge: CI green, ci_only strategy -- merging #$PR."
    ;;
  bot_comment)
    author_login="$(CONFIG_GET merge_gate.author_login)"; author_login="${author_login:-github-actions}"
    marker="$(CONFIG_GET merge_gate.marker)"; marker="${marker:-Claude Code Review}"
    doc_only_extensions="$(CONFIG_GET merge_gate.doc_only_extensions | paste -sd, -)"; doc_only_extensions="${doc_only_extensions:-.md}"
    merge_gate_bot_comment "$PR" "$author_login" "$marker" "$doc_only_extensions" || exit 1
    ;;
  gh_review)
    reviewer_login="$(CONFIG_GET merge_gate.reviewer_login)"
    merge_gate_gh_review "$PR" "$reviewer_login" || exit 1
    ;;
  *)
    echo "safe_merge: REFUSE -- unknown merge_gate.strategy '$STRATEGY' in config.yaml" >&2
    exit 1
    ;;
esac

complete_merge "$PR" || exit 1
"$SAFE_MERGE_HOME/bin/unblock_dependents.sh" "$PR" || true
