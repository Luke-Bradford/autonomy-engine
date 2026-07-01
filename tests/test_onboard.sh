#!/usr/bin/env bash
# Unit test for onboard.sh's scaffolding idempotency.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_HOME="$(cd "$HERE/.." && pwd)"

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

"$ENGINE_HOME/bin/onboard.sh" "$tmp" >/dev/null 2>&1
check "config.yaml scaffolded" "0" "$([ -f "$tmp/.autonomy/config.yaml" ] && echo 0 || echo 1)"
check "loop_prompt.md scaffolded" "0" "$([ -f "$tmp/.autonomy/loop_prompt.md" ] && echo 0 || echo 1)"
check "hard_rules.md scaffolded" "0" "$([ -f "$tmp/.autonomy/hard_rules.md" ] && echo 0 || echo 1)"

echo "MY CUSTOM EDIT" > "$tmp/.autonomy/config.yaml"
"$ENGINE_HOME/bin/onboard.sh" "$tmp" >/dev/null 2>&1
check "idempotent -- does not clobber an existing file" "MY CUSTOM EDIT" "$(cat "$tmp/.autonomy/config.yaml")"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
