#!/bin/bash
# test_report_fire_usage.sh -- #988. Sources the REAL report_fire_usage.sh and
# drives it against fixture fire logs, with `curl` replaced by a shell function
# that captures the body. No network, no studio, no tokens.
#
# The cases are mostly about what the reporter REFUSES or reports as UNKNOWN: a
# monitoring reporter that always produces a confident number is the bug, not the
# feature -- a fire that measured nothing must say so rather than send zeros.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$HERE/report_fire_usage.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/logs"

fails=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (want [$3], got [$2])"; fi; }
contains() { case "$2" in *"$3"*) pass "$1" ;; *) fail "$1 (missing [$3] in $2)" ;; esac; }

# `curl` as a shell function, capturing to FILES rather than to variables. The
# real call site is `printf ... | curl ...`, and a pipeline runs its commands in
# SUBSHELLS -- so a stub that assigned to a variable would capture the body into
# a shell that exits immediately, and every assertion below would read an empty
# string and pass or fail for reasons unrelated to the code.
CURL_RC=0
curl() {
  cat > "$TMP/curl_body"
  for arg in "$@"; do printf '%s' "$arg" > "$TMP/curl_url"; done
  return "$CURL_RC"
}
capture_reset() { : > "$TMP/curl_body"; : > "$TMP/curl_url"; }
body() { cat "$TMP/curl_body" 2>/dev/null; }
url() { cat "$TMP/curl_url" 2>/dev/null; }

jsonf() { python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1], "<absent>"))' "$1" < "$TMP/curl_body"; }

write_fire() {
  # $1 = filename, $2 = "measured"|"empty", $3 = "result"|"noresult"
  path="$TMP/logs/$1"
  : > "$path"
  if [ "$2" = "measured" ]; then
    printf '%s\n' '{"type":"assistant","message":{"model":"claude-opus-5","usage":{"input_tokens":3,"output_tokens":7,"cache_read_input_tokens":1000,"cache_creation_input_tokens":40}}}' >> "$path"
    printf '%s\n' '{"type":"assistant","message":{"model":"claude-opus-5","usage":{"input_tokens":2,"output_tokens":5,"cache_read_input_tokens":500,"cache_creation_input_tokens":10}}}' >> "$path"
  else
    printf '%s\n' '{"type":"system","subtype":"init"}' >> "$path"
  fi
  [ "$3" = "result" ] && printf '%s\n' '{"type":"result","total_cost_usd":1.5,"duration_ms":60000}' >> "$path"
  echo "$path"
}

echo "== report_fire_usage =="

# 1. A measured fire reports its four token sides, SUMMED across every response.
log1="$(write_fire 'fire.20260814-102019.log' measured result)"
capture_reset; report_fire_usage "$log1"
check "sums input tokens across responses" "$(jsonf inputTokens)" "5"
check "sums output tokens" "$(jsonf outputTokens)" "12"
check "sums cache reads (the loop's dominant cost)" "$(jsonf cacheReadTokens)" "1500"
check "sums cache creation" "$(jsonf cacheCreationTokens)" "50"
check "reports the model it ran on" "$(jsonf model)" "claude-opus-5"

# 2. The fire's own timestamp is the idempotency handle, so a re-report of the
#    same fire updates one row instead of counting the fire twice.
check "externalId is the fire's stamp" "$(jsonf externalId)" "20260814-102019"
check "source names the reporter" "$(jsonf source)" "studio-build-loop"

# 3. A terminal result record means the child exited ON ITS OWN -- the schema's
#    meaning of `completed`, which is NOT "succeeded".
check "a terminated turn is completed" "$(jsonf outcome)" "completed"

log2="$(write_fire 'fire.20260814-110000.log' measured noresult)"
capture_reset; report_fire_usage "$log2"
check "a fire killed mid-turn did not complete" "$(jsonf outcome)" "notCompleted"

# 4. THE honesty case. A fire that produced no usage at all must report NULL, not
#    zeros -- studio keeps "nobody counted" distinct from "the count was zero",
#    and zeros here would render as a confident measurement of real work.
log3="$(write_fire 'fire.20260814-120000.log' empty result)"
capture_reset; report_fire_usage "$log3"
check "an unmeasured fire reports null input" "$(jsonf inputTokens)" "None"
check "an unmeasured fire reports null cache reads" "$(jsonf cacheReadTokens)" "None"

# 5. The endpoint is DERIVED from the quota URL, so the two cannot point at
#    different servers.
contains "posts to the external-activity endpoint" "$(url)" "/api/monitor/external-activity"

# 6. BEST-EFFORT: every failure path returns 0. A monitoring nicety must never be
#    able to stop the loop from engineering.
CURL_RC=7
report_fire_usage "$log1"; check "a failing POST still returns 0" "$?" "0"
CURL_RC=0
report_fire_usage "$TMP/logs/does-not-exist.log"; check "a missing log still returns 0" "$?" "0"

# 7. A file that is not a fire log has no start instant, and a GUESSED one would
#    put the invocation in the wrong window. Refuse rather than invent.
printf '%s\n' '{"type":"result"}' > "$TMP/logs/notafire.log"
capture_reset
report_fire_usage "$TMP/logs/notafire.log" 2>/dev/null
check "a non-fire filename is refused, not guessed" "$?" "0"
check "and nothing is posted for it" "$(body)" ""

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; fi
exit "$fails"
