#!/usr/bin/env bash
# Unit tests for safe_merge.sh's ci_check -- the fail-safe fix (Codex finding:
# a gh API failure must never look identical to "green").
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/../bin/safe_merge.sh"

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

MOCK_CHECKS_JSON=""
gh() {
  if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then
    if [ "$MOCK_CHECKS_JSON" = "__FAIL__" ]; then return 1; fi
    echo "$MOCK_CHECKS_JSON"
    return 0
  fi
  echo "unmocked gh call: $*" >&2
  return 1
}

MOCK_CHECKS_JSON='[{"name":"lint","state":"SUCCESS"}]'
check "all green -> ci_check passes" "0" "$(ci_check 1 bot_comment >/dev/null 2>&1; echo $?)"

MOCK_CHECKS_JSON='[{"name":"lint","state":"FAILURE"}]'
check "a failing check -> refuse" "1" "$(ci_check 1 bot_comment >/dev/null 2>&1; echo $?)"

MOCK_CHECKS_JSON='[{"name":"lint","state":"PENDING"}]'
check "a pending check -> refuse" "1" "$(ci_check 1 bot_comment >/dev/null 2>&1; echo $?)"

MOCK_CHECKS_JSON='[]'
check "zero checks, ci_only -> refuse" "1" "$(ci_check 1 ci_only >/dev/null 2>&1; echo $?)"
check "zero checks, bot_comment -> pass (approval is the real gate)" "0" "$(ci_check 1 bot_comment >/dev/null 2>&1; echo $?)"

MOCK_CHECKS_JSON="__FAIL__"
check "gh call itself fails -> refuse, not silently green" "1" "$(ci_check 1 ci_only >/dev/null 2>&1; echo $?)"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails FAILED"; exit 1; fi
