#!/usr/bin/env bash
# bin/onboard.sh -- scaffold .autonomy/ in a target repo from
# templates/autonomy-pack/. Idempotent: never overwrites an existing file.
#
# Usage: onboard.sh <target-repo>
set -euo pipefail
ENGINE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TARGET="${1:?usage: onboard.sh <target-repo>}"
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
