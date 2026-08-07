#!/usr/bin/env bash
# Scenario test for supervisor.sh session_end_park() against a throwaway repo.
#
# #245: an idle worktree must never hold the `main` branch ref. Git forbids one
# branch checked out in two worktrees, so if this loop's worktree parks on an
# attached `main` between tickets, a sibling primary checkout can no longer
# `git checkout main`. session_end_park() detaches HEAD off `main` after a
# session, on a clean tree only, best-effort/fail-safe.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
source "$HERE/../bin/supervisor.sh"
# shellcheck disable=SC2034  # consumed by log() in the sourced supervisor.sh
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
echo seed > seed.txt
git add seed.txt
git commit -q -m init
git branch -M main
git remote add origin "$origin"
git push -q -u origin main 2>/dev/null

# shellcheck disable=SC2034  # consumed by session_end_park() in the sourced supervisor.sh
AUTONOMY_TARGET_REPO="$work"

# --- clean tree, attached to main: must detach (releases the main ref) -------
git switch -q main
check "precondition: on attached main" "main" "$(git symbolic-ref -q --short HEAD || echo '')"
session_end_park; rc=$?
check "park returns 0 (best-effort)" 0 "$rc"
check "park detaches HEAD off main" "" "$(git symbolic-ref -q --short HEAD || echo '')"
check "park keeps HEAD at same commit" "$(git rev-parse main)" "$(git rev-parse HEAD)"
check "park leaves tree clean" "" "$(git status --porcelain)"
check "park preserves the main branch ref" "$(git rev-parse HEAD)" "$(git rev-parse main)"

# --- already detached: no-op, still detached ---------------------------------
session_end_park; rc=$?
check "park on detached HEAD returns 0" 0 "$rc"
check "park on detached HEAD stays detached" "" "$(git symbolic-ref -q --short HEAD || echo '')"

# --- clean tree on a feature branch: must NOT detach (only main blocks) -------
git switch -q -c feature/x
session_end_park; rc=$?
check "park on feature branch returns 0" 0 "$rc"
check "park leaves a feature branch attached" "feature/x" "$(git symbolic-ref -q --short HEAD || echo '')"

# --- dirty tree on main: must NOT detach (leave WIP for preflight recovery) ---
git switch -q main
echo wip > wip.txt
session_end_park; rc=$?
check "park over dirty main returns 0" 0 "$rc"
check "park does NOT detach over WIP" "main" "$(git symbolic-ref -q --short HEAD || echo '')"
check "park preserves the WIP" "wip" "$(cat wip.txt 2>/dev/null || echo MISSING)"
rm -f wip.txt

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
