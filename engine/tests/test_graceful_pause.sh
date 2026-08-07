#!/usr/bin/env bash
# Unit test for the supervisor's graceful-stop PAUSE sentinel predicate.
# Sourcing supervisor.sh defines its functions (the guarded loop body does not
# run), so we can exercise pause_requested directly against a temp sentinel.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
source "$HERE/../bin/supervisor.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

sentinel="$tmp/autonomy-PAUSE"

# Absent sentinel -> not paused (non-zero rc).
if pause_requested "$sentinel"; then r=paused; else r=running; fi
check "no sentinel file -> running" running "$r"

# Present sentinel -> paused (zero rc).
: > "$sentinel"
if pause_requested "$sentinel"; then r=paused; else r=running; fi
check "sentinel present -> paused" paused "$r"

# Removed again -> running (resume).
rm -f "$sentinel"
if pause_requested "$sentinel"; then r=paused; else r=running; fi
check "sentinel removed -> running (resume)" running "$r"

# A directory at the sentinel path is NOT a pause request (must be a file).
mkdir "$sentinel.dir"
if pause_requested "$sentinel.dir"; then r=paused; else r=running; fi
check "directory at path -> running (file-only)" running "$r"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
