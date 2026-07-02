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

echo "=== python: test_config_parser ==="
python3 -m unittest tests.test_config_parser -v || fail=1

echo "=== python: test_roles ==="
python3 -m unittest tests.test_roles -v || fail=1

echo "=== python: test_dashboard_server ===" && python3 -m unittest tests.test_dashboard_server -v || fail=1
echo "=== python: test_dashboard_state ==="
python3 -m unittest tests.test_dashboard_state -v || fail=1

echo "=== python: test_dashboard_control ==="
python3 -m unittest tests.test_dashboard_control -v || fail=1

echo "=== python: test_credentials ==="
python3 -m unittest tests.test_credentials -v || fail=1

echo "=== python: test_accounts ==="
python3 -m unittest tests.test_accounts -v || fail=1

echo "=== python: test_dashboard_registry_refuse ==="
python3 -m unittest tests.test_dashboard_registry_refuse -v || fail=1

if [ "$fail" -eq 0 ]; then echo "ALL SUITES PASS"; exit 0; else echo "ONE OR MORE SUITES FAILED"; exit 1; fi
