#!/usr/bin/env bash
# tests/test_safe_merge_complete.sh -- complete_merge() merges via the API and
# deletes the remote ref WITHOUT `gh pr merge --delete-branch`, whose post-merge
# local `git checkout <base>` fails under a sibling-worktree topology (the base
# branch checked out in another worktree) -- #72. It also (a) verifies the PR
# actually reached MERGED before treating the merge as done, and (b) skips the
# remote-branch delete for fork PRs (their branch lives in another repo).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/../bin/safe_merge.sh"   # NB: this runs `set -e` in our shell too

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
calls="$tmp/gh_calls"

# Mock the gh boundary: record every call. `gh pr view` returns
# "<state> <branch> <isCrossRepository>" (what complete_merge parses). Patterns
# match "$*" with a trailing glob so `api -X DELETE ...` matches `api*`.
# $VIEW is the pr-view line each scenario wants returned.
VIEW="MERGED feature-x false"
gh() {
  printf '%s\n' "gh $*" >> "$calls"
  case "$*" in
    "pr view"*) printf '%s\n' "$VIEW" ;;
  esac
  return 0
}

: > "$calls"; VIEW="MERGED feature-x false"
merge_rc=0; complete_merge 42 || merge_rc=$?
check "complete_merge succeeds on a landed merge" "0" "$merge_rc"
check "merges via --squash" "yes" "$(grep -q 'gh pr merge 42 --squash' "$calls" && echo yes || echo no)"
check "does NOT pass --delete-branch (#72 local-checkout trigger)" "yes" "$(grep -q 'delete-branch' "$calls" && echo no || echo yes)"
check "deletes the remote ref explicitly" "yes" "$(grep -q 'api -X DELETE repos/{owner}/{repo}/git/refs/heads/feature-x' "$calls" && echo yes || echo no)"

# gh pr merge succeeded but the PR is NOT actually MERGED (queued/auto-merge) --
# must REFUSE, not report success, and not delete any branch.
: > "$calls"; VIEW="OPEN feature-q false"
merge_rc=0; complete_merge 43 2>/dev/null || merge_rc=$?
check "unmerged state refuses (return 1)" "1" "$merge_rc"
check "no remote-delete when not MERGED" "yes" "$(grep -q 'api -X DELETE' "$calls" && echo no || echo yes)"

# Fork PR: merged, but the head branch lives in another repo -- skip the delete
# (deleting repos/{owner}/{repo}/... could hit an unrelated base branch).
: > "$calls"; VIEW="MERGED feature-fork true"
merge_rc=0; complete_merge 44 || merge_rc=$?
check "fork PR merge succeeds" "0" "$merge_rc"
check "fork PR: remote-delete SKIPPED" "yes" "$(grep -q 'api -X DELETE' "$calls" && echo no || echo yes)"

# A failed remote-branch delete is cosmetic -- must NOT fail the merge.
gh() {
  printf '%s\n' "gh $*" >> "$calls"
  case "$*" in
    "pr view"*) printf '%s\n' "$VIEW" ;;
    "api"*) return 1 ;;
  esac
  return 0
}
: > "$calls"; VIEW="MERGED feature-y false"
merge_rc=0; complete_merge 45 2>/dev/null || merge_rc=$?
check "merge still succeeds when remote-branch delete fails" "0" "$merge_rc"

# A failed merge itself must propagate (return 1) -- never a false success,
# and never reach the state-check / delete.
gh() { printf '%s\n' "gh $*" >> "$calls"; case "$*" in "pr merge"*) return 1 ;; esac; return 0; }
: > "$calls"; VIEW="MERGED feature-z false"
merge_rc=0; complete_merge 46 2>/dev/null || merge_rc=$?
check "merge failure propagates (return 1)" "1" "$merge_rc"
check "no state-check/delete after a failed merge" "yes" "$(grep -qE 'pr view|api -X DELETE' "$calls" && echo no || echo yes)"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails FAILED"; exit 1; fi
