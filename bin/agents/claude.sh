#!/usr/bin/env bash
# bin/agents/claude.sh -- the Claude Code agent adapter. Two functions
# supervisor.sh dispatches to via `source bin/agents/${agent.type}.sh`. Every
# other agent type (e.g. a future bin/agents/codex.sh) implements the same two
# functions with its own invocation/log-format details -- see the pack-seam
# spec's "Agent adapters" section.

# Runs the Claude Code CLI once and writes its stream-json log to $5. This is
# eBull's original supervisor.sh invocation, parameterized. $6 (optional) is
# the effort level (#24) -- --effort is passed only when non-empty, so packs
# that set none keep the CLI's default. The ${arr[@]+...} expansion is the
# bash-3.2 idiom for "empty array under set -u".
agent_invoke() {
  local prompt_file="$1" safety_file="$2" model="$3" fallback_model="$4" log_file="$5" effort="${6:-}"
  local effort_args=()
  [ -n "$effort" ] && effort_args=(--effort "$effort")
  claude -p "$(cat "$prompt_file")" \
    --dangerously-skip-permissions \
    --model "$model" \
    --fallback-model "$fallback_model" \
    ${effort_args[@]+"${effort_args[@]}"} \
    --append-system-prompt "$(cat "$safety_file")" \
    --output-format stream-json --verbose \
    >>"$log_file" 2>&1
  return $?
}

# Classify a usage/rate-limit block from the session's stream-json log. Exit 0
# = blocked (caller maps to the limit backoff), 1 = not blocked. Ported
# verbatim from eBull's supervisor.sh -- parses ONLY structured
# rate_limit_info + the terminal result's is_error, never greps content text.
is_usage_limit_hit() {
  python3 - "$1" <<'PY'
import json, sys

rejected = False
result = None
for line in open(sys.argv[1], errors="replace"):
    if '"type"' not in line:
        continue
    try:
        o = json.loads(line)
    except Exception:
        continue
    t = o.get("type")
    if t == "rate_limit_event":
        rli = o.get("rate_limit_info") or {}
        if rli.get("status") == "rejected" and not rli.get("isUsingOverage"):
            rejected = True
    elif t == "result":
        result = o

succeeded = result is not None and not result.get("is_error")
sys.exit(0 if (rejected and not succeeded) else 1)
PY
}

# Extract the API-reported reset time from the LAST rejected rate_limit_event
# in the session log, as epoch-seconds. Ported verbatim from eBull's
# supervisor.sh.
extract_reset_epoch() {
  python3 - "$1" <<'PY'
import json, math, sys, time
from datetime import datetime, timezone

def to_epoch(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        x = float(v)
        if not math.isfinite(x):
            return None
        if x > 1e12:
            x /= 1000.0
        return int(x) if x > 1e9 else None
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        try:
            x = float(s)
            if math.isfinite(x):
                if x > 1e12:
                    x /= 1000.0
                if x > 1e9:
                    return int(x)
        except ValueError:
            pass
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return int(dt.timestamp())
        except ValueError:
            return None
    return None

reset = None
for line in open(sys.argv[1], errors="replace"):
    if '"type"' not in line:
        continue
    try:
        o = json.loads(line)
    except Exception:
        continue
    if o.get("type") != "rate_limit_event":
        continue
    rli = o.get("rate_limit_info") or {}
    if rli.get("status") != "rejected" or rli.get("isUsingOverage"):
        continue
    for k, val in rli.items():
        kl = k.lower()
        if kl in ("retryafter", "retry_after"):
            secs = None
            if isinstance(val, (int, float)) and not isinstance(val, bool):
                secs = float(val)
            elif isinstance(val, str):
                try:
                    secs = float(val.strip())
                except ValueError:
                    secs = None
            if secs is not None and math.isfinite(secs):
                reset = int(time.time() + secs)
        elif "reset" in kl:
            e = to_epoch(val)
            if e is not None:
                reset = e

if reset is not None:
    print(reset)
PY
}

# Normalize into the supervisor's outcome contract: prints exactly one of
# "success" | "usage_limit <epoch>" | "usage_limit" | "error". Does NOT
# persist the reset epoch -- that is supervisor.sh's job (see the pack-seam
# spec's "Split of responsibility for the reset-epoch invariant" note).
agent_classify_outcome() {
  local log_file="$1" exit_code="$2"
  if is_usage_limit_hit "$log_file"; then
    local epoch; epoch="$(extract_reset_epoch "$log_file")"
    if [ -n "$epoch" ]; then echo "usage_limit $epoch"; else echo "usage_limit"; fi
    return 0
  fi
  if [ "$exit_code" -eq 0 ]; then echo "success"; return 0; fi
  echo "error"
  return 0
}
