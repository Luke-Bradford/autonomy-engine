#!/bin/bash
# report_fire_usage.sh -- tell studio what a fire actually spent (#988).
#
# WHY THIS EXISTS. `/monitor/ai` can only ever describe AI use studio itself
# dispatched: every figure on it is derived from `run_events` INNER JOINed to
# `runs`. The build loop's fires are `claude -p` subprocesses launched from
# `drive.sh`, outside studio entirely, so the operator opened the one monitoring
# page they have and read `0 runs, 0 tokens, no activity` while this loop was
# burning their weekly window. The zeros were honest and the scope was never
# stated.
#
# The fix is INGEST, not scraping: studio never reaches out to inspect processes
# it did not launch (it ships to other people, and a product that enumerates the
# machine's processes is a different product). So the loop -- which knows exactly
# what it ran -- reports in.
#
# ZERO TOKENS: this only parses a log the fire already wrote, like fire_stats.sh
# beside it. That file stays a human-facing table (cost, tool calls, browser
# calls); this one produces the WIRE shape and needs fields it does not carry
# (input tokens, cache creation, start/end instants, model). Neither is a subset
# of the other, so they read the same lines separately rather than one pretending
# to be a library for the other.
#
#   ./report_fire_usage.sh                       # newest fire log
#   ./report_fire_usage.sh logs/fire.NNN.log     # a specific one
#
# BEST-EFFORT, ALWAYS. Every failure path warns to stderr and exits 0. This runs
# on the fire path, and a monitoring nicety must never be able to stop the loop
# from engineering -- the same rule `board.sh` and `unblock_dependents.sh` hold.
set -uo pipefail

# DERIVED from the quota URL rather than written out again (#832): that port
# already has exactly one other copy, guarded by a test, and a third spelling is
# how a stale pin survives its own reason. Both URLs point at the SAME server by
# construction, which is the property this depends on.
STUDIO_QUOTA_URL="${STUDIO_QUOTA_URL:-http://127.0.0.1:8788/api/quota}"
STUDIO_ACTIVITY_URL="${STUDIO_ACTIVITY_URL:-${STUDIO_QUOTA_URL%/}}"
STUDIO_ACTIVITY_URL="${STUDIO_ACTIVITY_URL%/api/quota}/api/monitor/external-activity"

# The reporter's identity on the panel. Fixed rather than derived from the host
# or the checkout: it is the GROUPING key operators read, and one loop reporting
# under two names would split its own row.
REPORT_SOURCE="${REPORT_SOURCE:-studio-build-loop}"

# Seconds. Short on purpose -- studio is a local process, and a monitoring POST
# that hangs would hold the fire path open for as long as it took.
REPORT_TIMEOUT="${REPORT_TIMEOUT:-5}"

# Builds the report body for one fire log, on stdout. Empty output (and a
# non-zero return) means the log could not be read as a fire.
#
# `outcome` is the schema's own vocabulary: `completed` means the child exited ON
# ITS OWN, with ANY exit code -- so it is keyed on the presence of the terminal
# `"type":"result"` record, NOT on the wrapper's exit status. A fire that ran to
# a usage limit and reported it DID complete; one killed mid-turn did not. That
# distinction is the whole point of the field, and reading it off `$?` would
# quietly replace it with "did the wrapper succeed".
fire_usage_payload() {
  FIRE_LOG="$1" REPORT_SOURCE="$REPORT_SOURCE" python3 - <<'PY'
import json, os, re, sys
from datetime import datetime

path = os.environ["FIRE_LOG"]
tin = tout = cread = ccreate = 0
measured = False
completed = False
model = None
try:
    with open(path, errors="ignore") as fh:
        for line in fh:
            if '"usage"' in line and '"type":"assistant"' in line:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                msg = d.get("message", {}) or {}
                u = msg.get("usage", {}) or {}
                if u:
                    measured = True
                tin += u.get("input_tokens", 0) or 0
                tout += u.get("output_tokens", 0) or 0
                cread += u.get("cache_read_input_tokens", 0) or 0
                ccreate += u.get("cache_creation_input_tokens", 0) or 0
                model = msg.get("model") or model
            elif '"type":"result"' in line:
                completed = True
except OSError as err:
    print(f"report_fire_usage: cannot read {path}: {err}", file=sys.stderr)
    raise SystemExit(1)

# The fire's START is in its own filename (`fire.YYYYmmdd-HHMMSS.log`), which is
# stamped when the fire begins -- the only record of it that survives into a
# post-fire hook. A name that does not parse is not a fire log, and reporting a
# guessed start would put the invocation in the wrong window.
stem = re.match(r"fire\.(\d{8}-\d{6})\.log$", os.path.basename(path))
if stem is None:
    print(f"report_fire_usage: {path} is not a fire log filename", file=sys.stderr)
    raise SystemExit(1)
started = datetime.strptime(stem.group(1), "%Y%m%d-%H%M%S")

# Tokens are reported as NULL when the log carried no `usage` at all, never as a
# measured zero: studio keeps "nobody counted" distinct from "the count was 0",
# and a fire that died before its first response genuinely measured nothing.
tokens = (
    {
        "inputTokens": tin,
        "outputTokens": tout,
        "cacheReadTokens": cread,
        "cacheCreationTokens": ccreate,
    }
    if measured
    else {
        "inputTokens": None,
        "outputTokens": None,
        "cacheReadTokens": None,
        "cacheCreationTokens": None,
    }
)

print(
    json.dumps(
        {
            "source": os.environ["REPORT_SOURCE"],
            # The fire's own stamp is the id BOTH sides can agree on without
            # studio issuing one first, so a re-report updates rather than
            # doubles.
            "externalId": stem.group(1),
            "agent": "claude",
            "model": model,
            "startedAt": int(started.timestamp() * 1000),
            "endedAt": int(datetime.now().timestamp() * 1000),
            "outcome": "completed" if completed else "notCompleted",
            **tokens,
        }
    )
)
PY
}

# Report one fire log to studio. Never fails the caller.
report_fire_usage() {
  log_path="${1:-}"
  if [ -z "$log_path" ]; then
    # shellcheck disable=SC2012  # ls -t is the intent (newest first); names are fixed-format
    log_path="$(ls -t "${INFRA:-.}"/logs/fire.*.log 2>/dev/null | head -1)"
  fi
  if [ -z "$log_path" ] || [ ! -f "$log_path" ]; then
    echo "report_fire_usage: no fire log to report" >&2
    return 0
  fi

  payload="$(fire_usage_payload "$log_path")" || return 0
  [ -n "$payload" ] || return 0

  if ! printf '%s' "$payload" | curl -fsS --max-time "$REPORT_TIMEOUT" \
    -X POST -H 'Content-Type: application/json' --data-binary @- \
    "$STUDIO_ACTIVITY_URL" >/dev/null 2>&1; then
    # A studio that is down, mid-restart or simply not installed is the NORMAL
    # case for a loop that must keep engineering regardless. One line, no retry:
    # the next fire reports itself, and a missed row is a gap in a display, not
    # in anything that decides.
    echo "report_fire_usage: studio did not accept the report (is it running?)" >&2
    return 0
  fi
  return 0
}

# --- executable body (repo convention: sourcing this file must only define,
# never run) ------------------------------------------------------------
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  INFRA="${INFRA:-$(cd "$(dirname "$0")" && pwd)}"
  report_fire_usage "${1:-}"
  exit 0
fi
