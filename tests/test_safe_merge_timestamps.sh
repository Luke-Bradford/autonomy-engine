#!/usr/bin/env bash
# Unit test for #1: the review-postdates-head compare must be EPOCH-based, not
# lexicographic. GitHub's fixed-width Zulu format makes string compare work by
# luck; the day one field grows fractional seconds, '.' < 'Z' makes a LATER
# review compare as earlier. These tests pin the exact break case.
# NB: sourcing safe_merge.sh imports its `set -euo pipefail`, so every
# expected-failure call is rc-captured with `|| rc=$?`.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
source "$HERE/../bin/safe_merge.sh"

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}
rc_of() { rc=0; "$@" >/dev/null 2>&1 || rc=$?; echo "$rc"; }

# --- iso_epoch ---
check "plain zulu" "60" "$(iso_epoch "1970-01-01T00:01:00Z")"
check "fractional seconds parse" "60" "$(iso_epoch "1970-01-01T00:01:00.500Z")"
check "explicit offset" "60" "$(iso_epoch "1970-01-01T01:01:00+01:00")"
check "garbage -> nonzero rc" "1" "$(rc_of iso_epoch "not-a-date")"
check "empty -> nonzero rc" "1" "$(rc_of iso_epoch "")"

# --- review_postdates_head ---
check "review after head -> pass" "0" \
  "$(rc_of review_postdates_head "2026-07-01T10:00:01Z" "2026-07-01T10:00:00Z")"
check "review equal to head -> pass" "0" \
  "$(rc_of review_postdates_head "2026-07-01T10:00:00Z" "2026-07-01T10:00:00Z")"
check "review before head -> refuse" "1" \
  "$(rc_of review_postdates_head "2026-07-01T09:59:59Z" "2026-07-01T10:00:00Z")"
# THE issue-#1 break case: lexicographically '...00.500Z' < '...00Z' ('.'<'Z'),
# but chronologically the review is LATER -- epoch compare must pass it
check "fractional-second later review -> pass (lexicographic would refuse)" "0" \
  "$(rc_of review_postdates_head "2026-07-01T10:00:00.500Z" "2026-07-01T10:00:00Z")"
check "unparseable review time -> rc 2 (caller refuses, fail-safe)" "2" \
  "$(rc_of review_postdates_head "garbage" "2026-07-01T10:00:00Z")"
check "empty head time -> rc 2" "2" \
  "$(rc_of review_postdates_head "2026-07-01T10:00:00Z" "")"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
