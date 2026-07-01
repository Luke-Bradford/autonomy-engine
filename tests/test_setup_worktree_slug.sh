# tests/test_setup_worktree_slug.sh
#!/usr/bin/env bash
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

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
