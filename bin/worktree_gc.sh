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

# #353: the target's default branch (engine.default_branch, 'main' when
# unset/invalid) -- total under set -e (prevention-log #17), charset-gated
# before git argv (prevention-log #6). Resolved BEFORE the cd so a
# relative invocation path still finds the engine.
ENGINE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_BRANCH="$(python3 "$ENGINE_HOME/lib/config_parser.py" "$REPO/.autonomy/config.yaml" engine.default_branch 2>/dev/null || true)"
case "$DEFAULT_BRANCH" in
  ""|-*|*[!A-Za-z0-9._/-]*) DEFAULT_BRANCH=main ;;
esac

cd "$REPO" || exit 1

echo "== prune stale worktree admin entries =="
git worktree prune -v

# orphan run-outcome sidecar sweep (#378): LOCAL, so it runs BEFORE the fetch
# gate below (which exit 0s on a network failure). config_parser exits rc1
# (empty) for BOTH an unset key and an unreadable config; both collapse to the
# prune DEFAULT (safe -- detection is config-independent). A PRESENT junk value
# -> report (never earns prune, prevention-log #6). `|| true` keeps it total
# under set -e (#17). Post-cd, read via $PWD (absolute) so a relative --repo
# still resolves the config.
_action="$(python3 "$ENGINE_HOME/lib/config_parser.py" "$PWD/.autonomy/config.yaml" pipelines.orphan_sidecar_action 2>/dev/null || true)"
case "$_action" in off|report|prune) ;; "") _action=prune ;; *) _action=report ;; esac
if [ "$_action" = "off" ]; then
  echo "== orphaned pipeline run-outcome sidecars: sweep disabled (pipelines.orphan_sidecar_action=off) =="
else
  echo "== orphaned pipeline run-outcome sidecars (pipelines.orphan_sidecar_action=$_action) =="
  _oflag=""; [ "$_action" = "prune" ] && _oflag="--prune"
  # $_oflag is intentionally unquoted: an empty flag must vanish from argv,
  # not become an empty positional arg (shellcheck -S warning does not flag
  # this pattern; no disable needed -- verified empirically at write time).
  if ! _osweep="$(python3 "$ENGINE_HOME/lib/pipeline.py" orphans "$PWD" $_oflag 2>/dev/null)"; then
    echo "  SKIP: could not sweep run-outcome sidecars (logdir unreadable) -- nothing pruned"
  else
    _opruned=0
    while IFS=$'\t' read -r _otag _oval; do
      case "$_otag" in
        PRUNED)     echo "  pruned orphan sidecar: $_oval"; _opruned=$((_opruned + 1)) ;;
        ORPHAN)     echo "  orphan sidecar (report-only): $_oval" ;;
        UNREADABLE) echo "  SKIP: $_oval unreadable state file(s) -- not pruning (a corrupt live parent may still own a sidecar)" ;;
      esac
    done <<EOF
$_osweep
EOF
    [ "$_action" = "prune" ] && echo "  ($_opruned orphan sidecar(s) removed)"
  fi
fi

echo "== delete local branches merged into origin/$DEFAULT_BRANCH =="
if ! git fetch origin -q 2>/dev/null || ! git rev-parse --verify -q "origin/$DEFAULT_BRANCH" >/dev/null 2>&1; then
  echo "  SKIP: 'git fetch origin' failed or origin/$DEFAULT_BRANCH unresolved -- not deleting against a stale ref"
  echo "== remaining worktrees (loop/agent-specific = KEEP) =="
  git worktree list
  exit 0
fi
current="$(git branch --show-current 2>/dev/null || echo)"
deleted=0
while IFS= read -r b; do
  case "$b" in "$DEFAULT_BRANCH"|"$current"|'') continue ;; esac
  if git merge-base --is-ancestor "$b" "origin/$DEFAULT_BRANCH" 2>/dev/null; then
    if git branch -D "$b" >/dev/null 2>&1; then
      echo "  deleted merged branch: $b"; deleted=$((deleted + 1))
    fi
  fi
done < <(git for-each-ref --format='%(refname:short)' refs/heads)
echo "  ($deleted merged branch(es) removed)"

echo "== remaining worktrees (loop/agent-specific = KEEP) =="
git worktree list
