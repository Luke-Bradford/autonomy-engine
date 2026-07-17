#!/usr/bin/env bash
# Tests for lib/ci_retry.sh -- sources the REAL retry() and drives it with a
# real flaky command (a counter file), no assertions-on-mocks.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$HERE/../lib/ci_retry.sh"

fail=0
assert_eq() {
  if [ "$1" = "$2" ]; then
    echo "ok: $3"
  else
    echo "FAIL: $3 -- got '$1', want '$2'"
    fail=1
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
COUNT="$TMP/count"

# A command that fails until its call-count reaches $OK_AT, then succeeds.
# Counts every invocation to a file so the test can assert HOW MANY times retry
# actually called it.
flaky() {
  fk_n="$(cat "$COUNT" 2>/dev/null || echo 0)"
  fk_n=$(( fk_n + 1 ))
  echo "$fk_n" > "$COUNT"
  [ "$fk_n" -ge "$OK_AT" ]
}

# 1. Recovers: fails twice, succeeds on the 3rd attempt, within max=4.
echo 0 > "$COUNT"; OK_AT=3
retry 4 0 flaky
assert_eq "$?" "0" "returns 0 when the command recovers within max attempts"
assert_eq "$(cat "$COUNT")" "3" "stops calling the moment the command succeeds"

# 2. Gives up: never succeeds -> returns the command's failure after exactly max.
echo 0 > "$COUNT"; OK_AT=99
retry 3 0 flaky
assert_eq "$?" "1" "returns non-zero when the command never recovers"
assert_eq "$(cat "$COUNT")" "3" "makes exactly <max> attempts, no more, before giving up"

# 3. First-try success makes exactly one call (no needless retries).
echo 0 > "$COUNT"; OK_AT=1
retry 5 0 flaky
assert_eq "$?" "0" "returns 0 on first-try success"
assert_eq "$(cat "$COUNT")" "1" "makes exactly one call when the first attempt succeeds"

# 4. Propagates the command's SPECIFIC exit status (not a generic 1) -- a caller
#    that switches on the code (permanent-vs-transient HTTP) depends on this.
code7() { return 7; }
retry 2 0 code7
assert_eq "$?" "7" "propagates the command's own exit status when it gives up"

if [ "$fail" = 0 ]; then
  echo "ALL PASS"
else
  echo "FAILURES"
  exit 1
fi
