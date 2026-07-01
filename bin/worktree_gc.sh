#!/usr/bin/env bash
# bin/worktree_gc.sh -- tidy the autonomy git worktrees + branches for a
# target repo:
#   - KEEP the persistent loop/agent worktree (the supervisor's tree) -- it's
#     reused across sessions, never torn down here.
#   - PRUNE stale worktree admin entries via `git worktree prune`.
#   - DELETE local feature branches already merged into origin/main.
#
# Only fully-merged branches are removed (tip is an ancestor of origin/main),
# so this can never drop unmerged work.
#
# Usage: worktree_gc.sh --repo <target-repo-path>
set -euo pipefail

REPO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done
[ -n "$REPO" ] || { echo "usage: worktree_gc.sh --repo <target-repo-path>" >&2; exit 1; }
cd "$REPO" || exit 1

echo "== prune stale worktree admin entries =="
git worktree prune -v

echo "== delete local branches merged into origin/main =="
if ! git fetch origin -q 2>/dev/null || ! git rev-parse --verify -q origin/main >/dev/null 2>&1; then
  echo "  SKIP: 'git fetch origin' failed or origin/main unresolved -- not deleting against a stale ref"
  echo "== remaining worktrees (loop/agent-specific = KEEP) =="
  git worktree list
  exit 0
fi
current="$(git branch --show-current 2>/dev/null || echo)"
deleted=0
while IFS= read -r b; do
  case "$b" in main|"$current"|'') continue ;; esac
  if git merge-base --is-ancestor "$b" origin/main 2>/dev/null; then
    if git branch -D "$b" >/dev/null 2>&1; then
      echo "  deleted merged branch: $b"; deleted=$((deleted + 1))
    fi
  fi
done < <(git for-each-ref --format='%(refname:short)' refs/heads)
echo "  ($deleted merged branch(es) removed)"

echo "== remaining worktrees (loop/agent-specific = KEEP) =="
git worktree list
