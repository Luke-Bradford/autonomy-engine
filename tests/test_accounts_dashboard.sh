#!/usr/bin/env bash
# Live round-trip: acct_set (subscription) via the dashboard, then GET
# /api/config shows it -- proving the server wiring, no Keychain needed.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_HOME="$(cd "$HERE/.." && pwd)"
fails=0
check(){ if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (want '$2' got '$3')"; fails=$((fails+1)); fi; }

tmp="$(mktemp -d)"; tmp="$(cd "$tmp" && pwd -P)"; trap 'kill "${pid:-}" 2>/dev/null; rm -rf "$tmp"' EXIT
export HOME="$tmp/home"; mkdir -p "$HOME/.config/autonomy"
mkdir -p "$tmp/repoA/.autonomy"; printf 'board:\n  owner: x\n' > "$tmp/repoA/.autonomy/config.yaml"

python3 "$ENGINE_HOME/bin/dashboard.py" --repo "$tmp/repoA" --port 8931 >/dev/null 2>&1 & pid=$!
sleep 1.5
tok="$(curl -s http://127.0.0.1:8931/ | grep -o 'ae-control-token" content="[^"]*' | sed 's/.*content="//')"

curl -s -X POST http://127.0.0.1:8931/api/control -H 'Content-Type: application/json' \
  -d "{\"action\":\"acct_set\",\"name\":\"claude-sub\",\"kind\":\"claude_subscription\",\"token\":\"$tok\"}" >/dev/null
check "account appears in /api/config" "claude-sub" \
  "$(curl -s http://127.0.0.1:8931/api/config | python3 -c 'import json,sys;print((json.load(sys.stdin)["accounts"] or [{}])[0].get("name",""))')"
check "account_kinds offered" "0" \
  "$(curl -s http://127.0.0.1:8931/api/config | python3 -c 'import json,sys;print(0 if "anthropic_api" in json.load(sys.stdin)["account_kinds"] else 1)')"

curl -s -X POST http://127.0.0.1:8931/api/control -H 'Content-Type: application/json' \
  -d "{\"action\":\"acct_delete\",\"name\":\"claude-sub\",\"token\":\"$tok\"}" >/dev/null
check "account removed" "0" \
  "$(curl -s http://127.0.0.1:8931/api/config | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["accounts"]))')"

echo "---"; if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAIL"; exit 1; fi
