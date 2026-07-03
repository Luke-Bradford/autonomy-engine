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

check "roles/qa.md scaffolded (subdirectory, #13)" "0" "$([ -f "$tmp/.autonomy/roles/qa.md" ] && echo 0 || echo 1)"
check "roles/researcher.md scaffolded (W5b, #127)" "0" "$([ -f "$tmp/.autonomy/roles/researcher.md" ] && echo 0 || echo 1)"
check "qa/decide.sh scaffolded (subdirectory, #13)" "0" "$([ -f "$tmp/.autonomy/qa/decide.sh" ] && echo 0 || echo 1)"

echo "MY CUSTOM EDIT" > "$tmp/.autonomy/config.yaml"
echo "MY QA PROMPT" > "$tmp/.autonomy/roles/qa.md"
"$ENGINE_HOME/bin/onboard.sh" "$tmp" >/dev/null 2>&1
check "idempotent -- does not clobber an existing file" "MY CUSTOM EDIT" "$(cat "$tmp/.autonomy/config.yaml")"
check "idempotent in subdirectories too" "MY QA PROMPT" "$(cat "$tmp/.autonomy/roles/qa.md")"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
