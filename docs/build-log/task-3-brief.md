### Task 3: Claude agent adapter (`bin/agents/claude.sh`)

**Files:**
- Create: `bin/agents/claude.sh`
- Test: `tests/test_usage_limit_reset.sh`

**Interfaces:**
- Consumes: `python3 lib/config_parser.py` is not used here — this file only invokes the `claude`
  CLI and parses its own stream-json log.
- Produces: `agent_invoke(prompt_file, safety_file, model, fallback_model, log_file) -> exit code`
  and `agent_classify_outcome(log_file, exit_code) -> "success" | "usage_limit [epoch]" | "error"`
  (printed to stdout) — these two function names/signatures are what `bin/supervisor.sh` (Task 8)
  dispatches to via `source bin/agents/${AGENT_TYPE}.sh`. Also defines `is_usage_limit_hit` and
  `extract_reset_epoch` as internal helpers (ported verbatim from eBull's current
  `scripts/autonomy/supervisor.sh`).

- [ ] **Step 1: Write the failing test**

```bash
# tests/test_usage_limit_reset.sh
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
```

- [ ] **Step 2: Run to verify it fails**

```bash
chmod +x tests/test_usage_limit_reset.sh
bash tests/test_usage_limit_reset.sh
```
Expected: fails with "No such file or directory" (`bin/agents/claude.sh` doesn't exist yet).

- [ ] **Step 3: Implement `bin/agents/claude.sh`**

```bash
#!/usr/bin/env bash
# bin/agents/claude.sh -- the Claude Code agent adapter. Two functions
# supervisor.sh dispatches to via `source bin/agents/${agent.type}.sh`. Every
# other agent type (e.g. a future bin/agents/codex.sh) implements the same two
# functions with its own invocation/log-format details -- see the pack-seam
# spec's "Agent adapters" section.

# Runs the Claude Code CLI once and writes its stream-json log to $5. This is
# eBull's original supervisor.sh invocation, unchanged, just parameterized.
agent_invoke() {
  local prompt_file="$1" safety_file="$2" model="$3" fallback_model="$4" log_file="$5"
  claude -p "$(cat "$prompt_file")" \
    --dangerously-skip-permissions \
    --model "$model" \
    --fallback-model "$fallback_model" \
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bash tests/test_usage_limit_reset.sh
```
Expected: `ALL PASS`.

- [ ] **Step 5: shellcheck**

```bash
shellcheck -S warning bin/agents/claude.sh
```
Expected: no output (clean).

- [ ] **Step 6: Commit**

```bash
git add bin/agents/claude.sh tests/test_usage_limit_reset.sh
git commit -m "feat: add claude agent adapter (agent_invoke, agent_classify_outcome)"
git push
```

---

