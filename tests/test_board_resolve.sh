#!/usr/bin/env bash
# Unit test for board.sh's board_resolve_project -- user-then-org fallback.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
source "$HERE/../bin/board.sh"

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

USER_RESPONSE='{}'
ORG_RESPONSE='{}'
gh() {
  # $1=api $2=graphql -f query=... -f o=...
  # here-string, not `printf | grep -q`: under `set -o pipefail` a matching
  # grep -q exits before the producer finishes and SIGPIPEs it (prevention-log #7).
  if grep -q 'organization(login' <<<"$*"; then
    printf '%s' "$ORG_RESPONSE"
  else
    printf '%s' "$USER_RESPONSE"
  fi
}

USER_RESPONSE='{"data":{"user":{"projectsV2":{"nodes":[{"id":"PID_USER","title":"eBull engineering board","field":{"id":"FID_USER","options":[{"id":"OPT1","name":"In Progress"}]}}]}}}}'
ids="$(board_resolve_project "Luke-Bradford" "eBull engineering board" "In Progress")"
check "user-owned project found directly" "PID_USER FID_USER OPT1" "$ids"

USER_RESPONSE='{"data":{"user":{"projectsV2":{"nodes":[]}}}}'
ORG_RESPONSE='{"data":{"organization":{"projectsV2":{"nodes":[{"id":"PID_ORG","title":"org board","field":{"id":"FID_ORG","options":[]}}]}}}}'
ids="$(board_resolve_project "some-org" "org board" "")"
check "falls back to organization when user has no match" "PID_ORG FID_ORG " "$ids"

USER_RESPONSE='{"data":{"user":{"projectsV2":{"nodes":[]}}}}'
ORG_RESPONSE='{"data":{"organization":null}}'
ids="$(board_resolve_project "nobody" "nothing" "")"
check "neither user nor org match -> empty" "" "$(printf '%s' "$ids" | tr -d ' ')"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
