#!/usr/bin/env bash
# Unit test for the claude adapter's reset-epoch extraction/classification.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
source "$HERE/../bin/agents/claude.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}
between() {
  if [ -n "$4" ] && [ "$4" -ge "$2" ] && [ "$4" -le "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (want [$2,$3], got '$4')"; fails=$((fails + 1)); fi
}

mklog() { printf '%s\n' "$1" > "$tmp/log.jsonl"; echo "$tmp/log.jsonl"; }
ISO_EPOCH="$(python3 -c 'from datetime import datetime,timezone;print(int(datetime(2030,6,30,12,0,0,tzinfo=timezone.utc).timestamp()))')"

f="$(mklog '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":"2030-06-30T12:00:00Z"}}')"
check "ISO-8601 'resetsAt' -> epoch" "$ISO_EPOCH" "$(extract_reset_epoch "$f")"

f="$(mklog '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","reset":4102444800}}')"
check "epoch-seconds 'reset'" 4102444800 "$(extract_reset_epoch "$f")"

f="$(mklog '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetAt":4102444800000}}')"
check "epoch-millis 'resetAt' -> seconds" 4102444800 "$(extract_reset_epoch "$f")"

now="$(date +%s)"
f="$(mklog '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","retryAfter":1800}}')"
between "relative 'retryAfter' -> now+secs" "$((now + 1790))" "$((now + 1815))" "$(extract_reset_epoch "$f")"

f="$(mklog '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","retryAfter":"inf"}}')"
check "non-finite retryAfter -> no reset (no crash)" "" "$(extract_reset_epoch "$f" 2>/dev/null)"

f="$(mklog '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","isUsingOverage":true,"resetsAt":"2030-06-30T12:00:00Z"}}')"
check "overage-covered rejection yields no reset" "" "$(extract_reset_epoch "$f")"

f="$(mklog '{"type":"assistant","message":{"content":"rate limit reset at 9999999999"}}')"
check "content text is never parsed" "" "$(extract_reset_epoch "$f")"

f="$(mklog '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}')"
if is_usage_limit_hit "$f"; then r=blocked; else r=ok; fi
check "rejected + no terminal result = blocked" blocked "$r"

printf '%s\n%s\n' \
  '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}' \
  '{"type":"result","is_error":false}' > "$tmp/log.jsonl"
if is_usage_limit_hit "$tmp/log.jsonl"; then r=blocked; else r=ok; fi
check "rejected BUT session succeeded = not blocked" ok "$r"

f="$(mklog '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":"2030-06-30T12:00:00Z"}}')"
check "agent_classify_outcome reports usage_limit + epoch" "usage_limit $ISO_EPOCH" "$(agent_classify_outcome "$f" 1)"

printf '%s\n' '{"type":"result","is_error":false}' > "$tmp/log.jsonl"
check "agent_classify_outcome reports success" "success" "$(agent_classify_outcome "$tmp/log.jsonl" 0)"

printf '%s\n' '{"type":"result","is_error":true}' > "$tmp/log.jsonl"
check "agent_classify_outcome reports error" "error" "$(agent_classify_outcome "$tmp/log.jsonl" 1)"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
