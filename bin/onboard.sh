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

copied=0
skipped=0
for f in "$TEMPLATE_DIR"/*; do
  name="$(basename "$f")"
  dest="$PACK_DIR/$name"
  if [ -f "$dest" ]; then
    echo "onboard.sh: SKIP $name (already exists)"
    skipped=$((skipped + 1))
  else
    cp "$f" "$dest"
    echo "onboard.sh: created $name"
    copied=$((copied + 1))
  fi
done

echo "onboard.sh: $copied file(s) created, $skipped already present. Edit $PACK_DIR/config.yaml before running the loop."
