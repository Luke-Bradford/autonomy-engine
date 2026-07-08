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

# #320: the planner/coder pair is the DEFAULT coding shape -- scaffold the
# planner subagent where Claude Code reads it (.claude/agents/, NOT inside
# .autonomy/). Same idempotent contract as the pack: never overwrite. The
# agent file carries its own thinking-tier `model:` override; the coder
# session keeps the cheap executor model from agent.model in config.yaml.
if [ -f "$TARGET_REPO/.claude/agents/planner.md" ]; then
  echo "onboard.sh: SKIP .claude/agents/planner.md (already exists)"
elif [ -e "$TARGET_REPO/.claude/agents/planner.md" ]; then
  # A directory/symlink/etc squatting the path: cp would land INSIDE it and
  # this script would claim success while Claude Code sees no agent file.
  # Surface it instead of faking a scaffold (fail-safe).
  echo "onboard.sh: WARN .claude/agents/planner.md exists but is not a regular file -- planner agent NOT scaffolded" >&2
else
  mkdir -p "$TARGET_REPO/.claude/agents"
  cp "$ENGINE_HOME/templates/planner-agent.md" "$TARGET_REPO/.claude/agents/planner.md"
  echo "onboard.sh: created .claude/agents/planner.md (planner/coder pair default, #320)"
fi

# Workstreams slice 1: the dashboard's live config lives at
# var/autonomy/config.yaml -- the loop preflight's `git stash -u` would sweep
# an unignored var/, silently losing operator config. Ensure .gitignore covers
# var/ (idempotent: an existing `var/` or `var` line is respected verbatim;
# other lines never touched; file created when absent).
GITIGNORE="$TARGET_REPO/.gitignore"
var_covered=0
if [ -f "$GITIGNORE" ]; then
  while IFS= read -r gi_line; do
    case "$gi_line" in var/|var) var_covered=1; break ;; esac
  done <"$GITIGNORE"
fi
if [ "$var_covered" -eq 1 ]; then
  echo "onboard.sh: SKIP .gitignore (var/ already covered)"
else
  if [ -f "$GITIGNORE" ] && [ -n "$(tail -c 1 "$GITIGNORE" 2>/dev/null)" ]; then
    printf '\n' >>"$GITIGNORE"
  fi
  printf 'var/\n' >>"$GITIGNORE"
  echo "onboard.sh: added 'var/' to .gitignore (protects the live config + logs from the preflight sweep)"
fi

# Slice 3a: the planner agent file is MATERIALIZED per session from
# agent.planner.model -- it must be git-invisible or preflight's dirty check
# trips on it (and the materializer refuses to write a visible one).
planner_covered=0
if [ -f "$GITIGNORE" ]; then
  while IFS= read -r gi_line; do
    case "$gi_line" in .claude/agents/planner.md) planner_covered=1; break ;; esac
  done <"$GITIGNORE"
fi
if [ "$planner_covered" -eq 1 ]; then
  echo "onboard.sh: SKIP .gitignore (planner agent path already covered)"
else
  if [ -f "$GITIGNORE" ] && [ -n "$(tail -c 1 "$GITIGNORE" 2>/dev/null)" ]; then
    printf '\n' >>"$GITIGNORE"
  fi
  printf '.claude/agents/planner.md\n' >>"$GITIGNORE"
  echo "onboard.sh: added '.claude/agents/planner.md' to .gitignore (the engine materializes it from agent.planner.model)"
fi

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
