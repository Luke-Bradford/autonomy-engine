#!/usr/bin/env bash
# tests/test_setup_worktree_slug.sh
# Unit test for setup_worktree.sh's repo-slug derivation (engine.label override
# vs basename-derived default).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
source "$HERE/../bin/setup_worktree.sh"

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/eBull/.autonomy"
TARGET_REPO="$tmp/eBull"
cat > "$TARGET_REPO/.autonomy/config.yaml" <<'YAML'
board:
  owner: someone
YAML
check "basename-derived slug, mixed case collapsed" "ebull" "$(derive_slug)"

mkdir -p "$tmp/My Weird Repo!/.autonomy"
TARGET_REPO="$tmp/My Weird Repo!"
cat > "$TARGET_REPO/.autonomy/config.yaml" <<'YAML'
board:
  owner: someone
YAML
check "non-alphanumeric collapsed to single dashes" "my-weird-repo" "$(derive_slug)"

mkdir -p "$tmp/eBull2/.autonomy"
TARGET_REPO="$tmp/eBull2"
cat > "$TARGET_REPO/.autonomy/config.yaml" <<'YAML'
engine:
  label: custom-label
YAML
check "engine.label overrides basename" "custom-label" "$(derive_slug)"

# --- WORKTREE path resolution (regression: an absent worktree.default_path must
#     NOT trip set -e and abort -- it should fall through to the derived default)
parent="$(cd "$tmp" && pwd)"

mkdir -p "$tmp/noWT/.autonomy"
TARGET_REPO="$tmp/noWT"; SLUG="nowt"
cat > "$TARGET_REPO/.autonomy/config.yaml" <<'YAML'
board:
  owner: someone
YAML
check "no worktree.default_path -> derived default (no crash)" "$parent/.nowt-autonomy" "$(resolve_worktree_path "")"

mkdir -p "$tmp/relWT/.autonomy"
TARGET_REPO="$tmp/relWT"; SLUG="relwt"
cat > "$TARGET_REPO/.autonomy/config.yaml" <<'YAML'
worktree:
  default_path: "../.{repo-slug}-autonomy"
YAML
check "relative default_path resolves vs parent, slug substituted" "$parent/.relwt-autonomy" "$(resolve_worktree_path "")"

mkdir -p "$tmp/absWT/.autonomy"
TARGET_REPO="$tmp/absWT"
# shellcheck disable=SC2034  # SLUG is read by the sourced resolve_worktree_path (unused only in the absolute-path branch)
SLUG="abswt"
cat > "$TARGET_REPO/.autonomy/config.yaml" <<YAML
worktree:
  default_path: "$tmp/custom-abs-wt"
YAML
check "absolute default_path used as-is" "$tmp/custom-abs-wt" "$(resolve_worktree_path "")"

check "positional arg wins over config + default" "/explicit/path" "$(resolve_worktree_path "/explicit/path")"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
