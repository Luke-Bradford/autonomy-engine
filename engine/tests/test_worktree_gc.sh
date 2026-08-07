#!/usr/bin/env bash
# Unit test for worktree_gc.sh's orphan run-outcome sidecar sweep (#378).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GC="$HERE/../bin/worktree_gc.sh"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); \
  echo "FAIL: $1 (want '$2' got '$3')"; fi; }

# A git repo (worktree_gc runs git; a real empty repo keeps it happy). The
# sidecar sweep runs BEFORE the fetch gate, so no origin is needed.
mkrepo() {
  local d; d="$(mktemp -d)"
  ( cd "$d" && git init -q ) >/dev/null 2>&1   # no commit needed: `git worktree prune` works on a commit-less repo (avoids the unset-user.identity failure)
  mkdir -p "$d/.autonomy" "$d/var/autonomy-logs"
  printf 'engine:\n  default_branch: main\n' > "$d/.autonomy/config.yaml"
  echo "$d"
}
orphan() { printf '{"run_id":"x","outcome":"success"}' \
  > "$1/var/autonomy-logs/.pipeline-run-$2.outcome.json"; }

# action=prune (default) -> the orphan is named + removed
d="$(mkrepo)"; orphan "$d" "run1.c0.callX"
out="$(bash "$GC" --repo "$d" 2>&1 || true)"
check "prune names the sidecar" "0" \
  "$(printf '%s' "$out" | grep -q 'pruned orphan sidecar: .pipeline-run-run1.c0.callX.outcome.json' && echo 0 || echo 1)"
check "prune actually removes it" "1" \
  "$([ -e "$d/var/autonomy-logs/.pipeline-run-run1.c0.callX.outcome.json" ] && echo 0 || echo 1)"
rm -rf "$d"

# action=report -> named but NOT removed
d="$(mkrepo)"; orphan "$d" "run1.c0.callX"
printf 'pipelines:\n  orphan_sidecar_action: report\n' >> "$d/.autonomy/config.yaml"
out="$(bash "$GC" --repo "$d" 2>&1 || true)"
check "report names it" "0" \
  "$(printf '%s' "$out" | grep -q 'orphan sidecar (report-only)' && echo 0 || echo 1)"
check "report leaves it on disk" "0" \
  "$([ -e "$d/var/autonomy-logs/.pipeline-run-run1.c0.callX.outcome.json" ] && echo 0 || echo 1)"
rm -rf "$d"

# action=off -> section skipped, nothing removed
d="$(mkrepo)"; orphan "$d" "run1.c0.callX"
printf 'pipelines:\n  orphan_sidecar_action: "off"\n' >> "$d/.autonomy/config.yaml"
out="$(bash "$GC" --repo "$d" 2>&1 || true)"
check "off -> disabled line" "0" \
  "$(printf '%s' "$out" | grep -q 'sweep disabled' && echo 0 || echo 1)"
check "off leaves it on disk" "0" \
  "$([ -e "$d/var/autonomy-logs/.pipeline-run-run1.c0.callX.outcome.json" ] && echo 0 || echo 1)"
rm -rf "$d"

# unreadable state holds the prune back
d="$(mkrepo)"; orphan "$d" "run1.c0.callX"
printf '{bad' > "$d/var/autonomy-logs/.pipeline-run-run9.json"
out="$(bash "$GC" --repo "$d" 2>&1 || true)"
check "unreadable -> SKIP not-pruning line" "0" \
  "$(printf '%s' "$out" | grep -q 'not pruning' && echo 0 || echo 1)"
check "unreadable -> orphan survives" "0" \
  "$([ -e "$d/var/autonomy-logs/.pipeline-run-run1.c0.callX.outcome.json" ] && echo 0 || echo 1)"
rm -rf "$d"

echo "worktree_gc orphan sweep: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
