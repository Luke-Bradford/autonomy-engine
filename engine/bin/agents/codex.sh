#!/usr/bin/env bash
# bin/agents/codex.sh -- the Codex CLI agent adapter (issue #2). Implements
# the same two-function contract as bin/agents/claude.sh; supervisor.sh
# dispatches here via `source bin/agents/${agent.type}.sh`.
#
# Structural differences from the claude adapter (verified against
# codex-cli 0.136.0 `codex exec --help` + binary introspection):
#   - No --append-system-prompt: the safety text is PREPENDED to the prompt.
#   - No native fallback-model flag: THIS adapter retries once with the
#     fallback model on a non-limit failure. A usage-limit failure never
#     burns the fallback (the limit is account-global, a second model
#     hits the same wall).
#   - `--json` JSONL event schema of its own: error envelopes
#     (`error` / `turn.failed`, with code/message) and `rate_limits`
#     snapshots ({used_percent, window_minutes, resets_at}).
#
# VALIDATION STATUS: the flag surface and field names above are verified
# against the installed CLI; the exact rate-limit event as emitted by a real
# 429 is NOT yet validated against real Codex usage (operator-gated spend --
# protocol on issue #2). Classification is deliberately conservative: a
# missed limit degrades to the supervisor's exponential backoff, never to a
# wrong merge or a fail-open.

# Run codex exec once; $1..$6 mirror the claude adapter (prompt_file,
# safety_file, model, fallback_model, log_file, effort). Effort maps to
# codex's model_reasoning_effort config override, passed only when set.
_codex_run_once() {
  local prompt="$1" model="$2" log_file="$3" effort="$4"
  local effort_args=()
  [ -n "$effort" ] && effort_args=(-c "model_reasoning_effort=\"$effort\"")
  # BYO-LLM (#78): a role can resolve to a local OpenAI-compatible endpoint,
  # which reaches here as OPENAI_BASE_URL. codex-cli 0.136.0 dropped
  # custom-provider `wire_api = "chat"` (it now demands the Responses API,
  # which Ollama/LM Studio don't speak), so an arbitrary chat endpoint is NOT
  # routable via a `-c model_providers` override. The supported path is
  # codex's NATIVE local provider: --oss + --local-provider. Pick the provider
  # from the endpoint's default port (Ollama 11434, LM Studio 1234), defaulting
  # to ollama. Unset OPENAI_BASE_URL -> the cloud invocation is unchanged.
  #
  # --local-provider only picks codex's built-in provider DEFAULTS (host :11434
  # / :1234); it does NOT carry the endpoint's host:port. codex reads the actual
  # OSS endpoint from CODEX_OSS_BASE_URL (verified against codex-cli 0.136.0), so
  # without it a non-default-port local endpoint is silently unreachable (codex
  # hits the default port instead). Point codex at the real endpoint (#94), but
  # scope the var to THIS call via `env` -- the supervisor reuses one shell
  # across roles round-robin, so an exported override would leak into a
  # subsequent cloud role's invocation.
  local provider_args=() oss_env=()
  if [ -n "${OPENAI_BASE_URL:-}" ]; then
    local oss_provider=ollama
    case "$OPENAI_BASE_URL" in
      *:1234|*:1234/*) oss_provider=lmstudio ;;
    esac
    provider_args=(--oss --local-provider "$oss_provider")
    oss_env=(env "CODEX_OSS_BASE_URL=$OPENAI_BASE_URL")
  fi
  ${oss_env[@]+"${oss_env[@]}"} codex exec \
    --json \
    -m "$model" \
    --dangerously-bypass-approvals-and-sandbox \
    ${provider_args[@]+"${provider_args[@]}"} \
    ${effort_args[@]+"${effort_args[@]}"} \
    "$prompt" \
    </dev/null >>"$log_file" 2>&1
  # ^ stdin closed: codex APPENDS piped stdin to the prompt (observed on a
  # real run, "Reading additional input from stdin...") -- never let ambient
  # supervisor stdin leak into the session prompt.
}

agent_invoke() {
  local prompt_file="$1" safety_file="$2" model="$3" fallback_model="$4" log_file="$5" effort="${6:-}"
  # Safety rules first, then the standing task -- codex has no separate
  # system-prompt channel, so ordering inside the one prompt is the contract.
  local combined_prompt
  combined_prompt="$(cat "$safety_file")

$(cat "$prompt_file")"

  _codex_run_once "$combined_prompt" "$model" "$log_file" "$effort"
  local rc=$?
  [ "$rc" -eq 0 ] && return 0

  # Engine-level fallback (codex has no --fallback-model). Never on a usage
  # limit; never when there is no distinct fallback to try.
  if [ -z "$fallback_model" ] || [ "$fallback_model" = "$model" ]; then
    return "$rc"
  fi
  if is_usage_limit_hit "$log_file"; then
    return "$rc"
  fi
  # Non-JSON marker line: parsers skip lines without a "type" field.
  printf '[codex adapter] primary model %s failed (rc=%s) -- retrying once with fallback %s\n' \
    "$model" "$rc" "$fallback_model" >>"$log_file"
  _codex_run_once "$combined_prompt" "$fallback_model" "$log_file" "$effort"
}

# Usage/rate-limit block detection over codex's --json JSONL. Exit 0 =
# blocked, 1 = not. Parses ONLY error envelopes (`error`, `turn.failed`,
# `stream_error`) -- their structured code plus, unlike the claude adapter,
# their message field: codex carries the limit signal in the error
# envelope's message, and an error envelope is API/CLI output, never model
# content. Agent CONTENT (item.* events) is never parsed. A completed turn
# (`turn.completed`) after the error means the session recovered -- not
# blocked.
is_usage_limit_hit() {
  python3 - "$1" <<'PY'
import json, re, sys

LIMIT_CODE = re.compile(r"(rate_?limit|usage_?limit|quota)", re.I)
LIMIT_MSG = re.compile(r"(rate limit|usage limit|quota|too many requests|\b429\b)", re.I)

limited = False
completed = False
for line in open(sys.argv[1], errors="replace"):
    if '"type"' not in line:
        continue
    try:
        o = json.loads(line)
    except Exception:
        continue
    t = o.get("type")
    if t == "turn.completed":
        completed = True
    elif t in ("error", "turn.failed", "stream_error"):
        err = o.get("error") if isinstance(o.get("error"), dict) else {}
        code = str(err.get("code") or o.get("code") or "")
        msg = str(err.get("message") or o.get("message") or "")
        if LIMIT_CODE.search(code) or LIMIT_MSG.search(msg):
            limited = True

sys.exit(0 if (limited and not completed) else 1)
PY
}

# Reset-epoch extraction from `rate_limits` snapshots ({primary,secondary}:
# {used_percent, window_minutes, resets_at | resets_in_seconds}); the LAST
# snapshot wins. resets_at tolerates epoch-seconds, epoch-millis, and ISO
# 8601; resets_in_seconds is relative to now. Structured fields only --
# never free text. Prints nothing when no snapshot carries a reset (the
# supervisor then uses exponential backoff). Extraction only: persisting is
# supervisor.sh's job (reset-epoch split invariant).
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
                return None
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

def snapshots(o):
    # rate_limits at the top level or one level down (event wrappers vary)
    if isinstance(o.get("rate_limits"), dict):
        yield o["rate_limits"]
    for v in o.values():
        if isinstance(v, dict) and isinstance(v.get("rate_limits"), dict):
            yield v["rate_limits"]

def relative_secs(v):
    if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(float(v)):
        return float(v)
    return None

def scan_reset_fields(node):
    # Recursive scan of a STRUCTURED dict for reset-ish keys. Empirical (#42
    # probes): a real codex error envelope's `message` is a stringified JSON
    # API error -- reset data, when present, lives inside it as structured
    # fields, not in a rate_limits snapshot (exec --json emits none).
    # Multiple reset-ish keys: the LATEST epoch wins (most conservative --
    # the account is limited until every signal has passed), never dict
    # iteration order (PR #44 review).
    def later(a, b):
        if a is None:
            return b
        if b is None:
            return a
        return max(a, b)
    found = None
    if isinstance(node, dict):
        for k, v in node.items():
            kl = k.lower()
            if kl in ("resets_at", "reset_at", "resetsat"):
                found = later(found, to_epoch(v))
            elif kl in ("resets_in_seconds", "retry_after", "retryafter", "retry_after_seconds"):
                s = relative_secs(v)
                if s is not None:
                    found = later(found, int(time.time() + s))
            else:
                found = later(found, scan_reset_fields(v))
    elif isinstance(node, list):
        for item in node:
            found = later(found, scan_reset_fields(item))
    return found

reset = None
for line in open(sys.argv[1], errors="replace"):
    if '"type"' not in line:
        continue
    try:
        o = json.loads(line)
    except Exception:
        continue
    for rl in snapshots(o):
        for window in rl.values():
            if not isinstance(window, dict):
                continue
            e = to_epoch(window.get("resets_at"))
            if e is not None:
                reset = e
                continue
            secs = relative_secs(window.get("resets_in_seconds"))
            if secs is not None:
                reset = int(time.time() + secs)
    if o.get("type") in ("error", "turn.failed", "stream_error"):
        err = o.get("error") if isinstance(o.get("error"), dict) else {}
        msg = err.get("message") or o.get("message")
        if isinstance(msg, str) and msg.lstrip().startswith("{"):
            try:
                inner = json.loads(msg)
            except Exception:
                inner = None
            if inner is not None:
                e = scan_reset_fields(inner)
                if e is not None:
                    reset = e

if reset is not None:
    print(reset)
PY
}

# Same outcome contract as the claude adapter: exactly one of
# "success" | "usage_limit <epoch>" | "usage_limit" | "error".
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
