#!/usr/bin/env bash
# bin/onboard.sh -- scaffold .autonomy/ in a target repo from
# templates/autonomy-pack/. Idempotent: never overwrites an existing file.
#
# Usage: onboard.sh <target-repo> [--claude-md]
#   --claude-md   also scaffold a starter CLAUDE.md at the repo root when the
#                 repo has none (root or .claude/) -- opt-in, never overwrites
set -euo pipefail
ENGINE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TARGET=""
CLAUDE_MD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --claude-md) CLAUDE_MD=1; shift ;;
    -*)          echo "onboard.sh: unknown flag $1" >&2; exit 2 ;;
    *)           if [ -z "$TARGET" ]; then TARGET="$1"; shift
                 else echo "onboard.sh: unexpected argument $1" >&2; exit 2; fi ;;
  esac
done
[ -n "$TARGET" ] || { echo "usage: onboard.sh <target-repo> [--claude-md]" >&2; exit 2; }
TARGET_REPO="$(cd "$TARGET" && pwd)"
PACK_DIR="$TARGET_REPO/.autonomy"
TEMPLATE_DIR="$ENGINE_HOME/templates/autonomy-pack"

mkdir -p "$PACK_DIR"

# Recursive, per-file idempotent scaffold (the pack has subdirectories now:
# roles/, qa/ -- #13). bash-3.2: find -print0 loop, no globstar/mapfile.
copied=0
skipped=0
while IFS= read -r -d '' f; do
  rel="${f#"$TEMPLATE_DIR"/}"
  dest="$PACK_DIR/$rel"
  if [ -f "$dest" ]; then
    echo "onboard.sh: SKIP $rel (already exists)"
    skipped=$((skipped + 1))
  else
    mkdir -p "$(dirname "$dest")"
    cp "$f" "$dest"
    echo "onboard.sh: created $rel"
    copied=$((copied + 1))
  fi
done < <(find "$TEMPLATE_DIR" -type f -print0)

echo "onboard.sh: $copied file(s) created, $skipped already present. Edit $PACK_DIR/config.yaml before running the loop."

# Opt-in starter CLAUDE.md (#152). The whole prompt stack + role rails lean on
# the target repo's CLAUDE.md; a repo without one gets weaker sessions. Scaffold
# a placeholder starter ONLY when asked AND the repo has none -- Claude Code
# reads it from the repo root OR .claude/, so either location counts as present
# and we never overwrite (idempotent, matching the pack scaffold's contract).
if [ "$CLAUDE_MD" -eq 1 ]; then
  if [ -f "$TARGET_REPO/CLAUDE.md" ] || [ -f "$TARGET_REPO/.claude/CLAUDE.md" ]; then
    echo "onboard.sh: SKIP CLAUDE.md (already present)"
  else
    cp "$ENGINE_HOME/templates/starter-CLAUDE.md" "$TARGET_REPO/CLAUDE.md"
    echo "onboard.sh: created CLAUDE.md (starter scaffold -- fill it in; the loop reads it)"
  fi
fi
