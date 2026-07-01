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
