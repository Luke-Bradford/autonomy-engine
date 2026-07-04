#!/usr/bin/env bash
# tests/test_safe_merge_config_get.sh -- CONFIG_GET must be TOTAL: a missing
# optional key returns empty + rc 0 so `${VAR:-default}` applies. The
# non-total version killed every safe_merge run silently under `set -e` the
# moment #192 added a read of a key (doc_only_paths) absent from every
# existing config -- APPROVE'd PRs piled up unmerged (2026-07-05 incident).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/../bin/safe_merge.sh"

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/.autonomy"
cat > "$tmp/.autonomy/config.yaml" <<'EOF'
merge_gate:
  strategy: bot_comment
EOF

# CONFIG_GET reads .autonomy/config.yaml relative to CWD
cd "$tmp"

v="$(CONFIG_GET merge_gate.strategy)"; rc=$?
check "present key: value"          "bot_comment" "$v"
check "present key: rc 0"           "0" "$rc"

v="$(CONFIG_GET merge_gate.doc_only_paths)"; rc=$?
check "missing key: empty"          "" "$v"
check "missing key: rc 0 (TOTAL)"   "0" "$rc"

# the incident shape: assignment + pipeline + default, in a `set -e` subshell
# exactly like the executable body -- must survive and take the default.
out="$(set -e
  doc_only_paths="$(CONFIG_GET merge_gate.doc_only_paths | paste -sd, -)"
  doc_only_paths="${doc_only_paths:-docs/}"
  printf '%s' "$doc_only_paths")"
check "set -e caller survives missing key and defaults" "docs/" "$out"

# absent config FILE entirely: still total (empty + rc 0), strategy default
# path stays reachable
cd /
v="$(cd "$tmp"; rm -rf .autonomy; CONFIG_GET merge_gate.strategy)"; rc=$?
check "missing config file: empty"  "" "$v"
check "missing config file: rc 0"   "0" "$rc"

echo
if [ "$fails" -gt 0 ]; then echo "$fails FAILURES"; exit 1; fi
echo "ALL PASS"
