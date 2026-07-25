#!/usr/bin/env bash
# tests/run_all.sh -- run every test in this suite, bash and python.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/.." || exit 1

fail=0
for t in tests/test_*.sh; do
  echo "=== $t ==="
  bash "$t" || fail=1
done

# Every tests/test_*.py, discovered by GLOB rather than a hand-kept list. The list
# form silently skipped a newly added suite (the guard hook's tests), which is the
# worst failure mode a test runner has: the file exists, looks covered, and never
# runs. A glob cannot drift. (bash 3.2: no globstar needed, tests/ is flat.)
for t in tests/test_*.py; do
  mod="tests.$(basename "$t" .py)"
  echo "=== python: $mod ==="
  python3 -m unittest "$mod" -v || fail=1
done

if [ "$fail" -eq 0 ]; then echo "ALL SUITES PASS"; exit 0; else echo "ONE OR MORE SUITES FAILED"; exit 1; fi
