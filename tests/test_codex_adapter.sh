#!/usr/bin/env bash
# tests/test_codex_adapter.sh -- Codex agent adapter (issue #2).
# Same two-function contract as bin/agents/claude.sh, with Codex's
# structural differences: no --append-system-prompt (safety text is
# PREPENDED to the prompt), its own `--json` JSONL event schema (error
# envelopes + rate_limits snapshots, field names introspected from
# codex-cli 0.136.0), and no native fallback flag (the ADAPTER retries once
# with the fallback model -- except on a usage limit, which is
# account-global and must not burn a second attempt).
#
# The codex CLI is PATH-shimmed: argv is captured NUL-safely, stdout comes
# from a per-case fixture, exit code from a control file. Classification
# tests run the real parsers over fixture JSONL only -- no network, no
# spend. Real-usage validation of the rate-limit shape is tracked on issue
# #2 (operator-gated).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
source "$HERE/../bin/agents/codex.sh"

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- codex shim: record argv, emit fixture, exit per control file ------------
shim="$tmp/shim"
mkdir -p "$shim"
export CODEX_SHIM_DIR="$tmp/shimstate"
mkdir -p "$CODEX_SHIM_DIR"
cat > "$shim/codex" <<'SH'
#!/bin/bash
n=$(( $(cat "$CODEX_SHIM_DIR/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$CODEX_SHIM_DIR/count"
printf '%s\0' "$@" > "$CODEX_SHIM_DIR/argv.$n"
# Record the OSS endpoint override the adapter passed via the environment
# (codex reads CODEX_OSS_BASE_URL from its env, not argv). Empty = unset.
printf '%s' "${CODEX_OSS_BASE_URL-}" > "$CODEX_SHIM_DIR/ossbase.$n"
fixture="$CODEX_SHIM_DIR/fixture.$n"
[ -f "$fixture" ] || fixture="$CODEX_SHIM_DIR/fixture"
[ -f "$fixture" ] && cat "$fixture"
rc_file="$CODEX_SHIM_DIR/rc.$n"
[ -f "$rc_file" ] || rc_file="$CODEX_SHIM_DIR/rc"
exit "$(cat "$rc_file" 2>/dev/null || echo 0)"
SH
chmod +x "$shim/codex"
export PATH="$shim:$PATH"

reset_shim() { rm -f "$CODEX_SHIM_DIR"/count "$CODEX_SHIM_DIR"/argv.* "$CODEX_SHIM_DIR"/fixture* "$CODEX_SHIM_DIR"/rc* "$CODEX_SHIM_DIR"/ossbase.*; }
shim_calls() { cat "$CODEX_SHIM_DIR/count" 2>/dev/null || echo 0; }
# argv.N as newline-joined for simple grep (args themselves contain newlines,
# so ordering checks go through python)
argv_has() { tr '\0' '\n' < "$CODEX_SHIM_DIR/argv.$1" | grep -qxF -- "$2"; }
# CODEX_OSS_BASE_URL the adapter exported for call N (empty if unset).
oss_base() { cat "$CODEX_SHIM_DIR/ossbase.$1" 2>/dev/null; }

printf 'SAFETYRULES-9000\nnever push to main\n' > "$tmp/hard_rules.md"
printf 'DOTASK-1234\ndrain the board\n' > "$tmp/loop_prompt.md"

# --- agent_invoke: flags, safety-prepended prompt, log capture ----------------
reset_shim
printf '{"type":"turn.completed","usage":{}}\n' > "$CODEX_SHIM_DIR/fixture"
log="$tmp/session1.log"
agent_invoke "$tmp/loop_prompt.md" "$tmp/hard_rules.md" gpt-5.1-codex sonnet-fallback "$log" ""
check "invoke exits 0 on success" "0" "$?"
check "one codex call for a clean run" "1" "$(shim_calls)"
check "subcommand is exec" "0" "$(argv_has 1 exec && echo 0 || echo 1)"
check "--json passed" "0" "$(argv_has 1 --json && echo 0 || echo 1)"
check "model passed via -m" "0" "$(argv_has 1 gpt-5.1-codex && echo 0 || echo 1)"
check "non-interactive full-trust flag passed" "0" "$(argv_has 1 --dangerously-bypass-approvals-and-sandbox && echo 0 || echo 1)"
check "no effort override when effort empty" "1" "$(tr '\0' '\n' < "$CODEX_SHIM_DIR/argv.1" | grep -q 'model_reasoning_effort' && echo 0 || echo 1)"
check "events landed in the log file" "0" "$(grep -q 'turn.completed' "$log" && echo 0 || echo 1)"
check "safety text precedes prompt text in the prompt arg" "yes" "$(python3 - "$CODEX_SHIM_DIR/argv.1" <<'PY'
import sys
args = [a for a in open(sys.argv[1], "rb").read().decode().split("\0") if a]
prompt = args[-1]
s, p = prompt.find("SAFETYRULES-9000"), prompt.find("DOTASK-1234")
print("yes" if 0 <= s < p else "no (s=%d p=%d)" % (s, p))
PY
)"

# --- effort passthrough --------------------------------------------------------
reset_shim
printf '{"type":"turn.completed"}\n' > "$CODEX_SHIM_DIR/fixture"
agent_invoke "$tmp/loop_prompt.md" "$tmp/hard_rules.md" m1 m2 "$tmp/session2.log" high
check "effort maps to -c model_reasoning_effort" "0" "$(argv_has 1 'model_reasoning_effort="high"' && echo 0 || echo 1)"

# --- OPENAI_BASE_URL routing to the local OSS provider (#78) --------------------
# codex-cli 0.136.0 dropped custom-provider `wire_api = "chat"` (demands the
# Responses API, which local servers don't speak), so a local role routes
# through codex's NATIVE --oss local provider. Unset -> byte-for-byte the
# cloud path (no override); set -> --oss + the matching local provider.
reset_shim
printf '{"type":"turn.completed"}\n' > "$CODEX_SHIM_DIR/fixture"
( unset OPENAI_BASE_URL; _codex_run_once "p" "gpt-x" "$tmp/nb.log" "" )
check "no base url: no local-provider override" "yes" \
  "$(tr '\0' '\n' < "$CODEX_SHIM_DIR/argv.1" | grep -qE -- '--oss|--local-provider|model_provider' && echo no || echo yes)"
check "no base url: no CODEX_OSS_BASE_URL override leaked" "" "$(oss_base 1)"

reset_shim
printf '{"type":"turn.completed"}\n' > "$CODEX_SHIM_DIR/fixture"
( export OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_API_KEY=local
  _codex_run_once "p" "qwen3:14b" "$tmp/b.log" "" )
check "base url set: routes via --oss" "0" "$(argv_has 1 --oss && echo 0 || echo 1)"
check "base url set: ollama provider selected" "0" "$(argv_has 1 ollama && echo 0 || echo 1)"
check "base url set: still passes the model" "0" "$(argv_has 1 qwen3:14b && echo 0 || echo 1)"
check "base url set: CODEX_OSS_BASE_URL points codex at the endpoint" \
  "http://localhost:11434/v1" "$(oss_base 1)"

reset_shim
printf '{"type":"turn.completed"}\n' > "$CODEX_SHIM_DIR/fixture"
( export OPENAI_BASE_URL=http://localhost:1234/v1 OPENAI_API_KEY=local
  _codex_run_once "p" "some-model" "$tmp/l.log" "" )
check "lmstudio default port -> lmstudio provider" "0" "$(argv_has 1 lmstudio && echo 0 || echo 1)"

# The core fix (#94): a NON-default-port endpoint stays ollama (heuristic
# defaults there) but must actually REACH that host:port, not codex's
# hardcoded :11434. Before the fix codex silently hit the default port.
reset_shim
printf '{"type":"turn.completed"}\n' > "$CODEX_SHIM_DIR/fixture"
( export OPENAI_BASE_URL=http://localhost:11500/v1 OPENAI_API_KEY=local
  _codex_run_once "p" "qwen3:14b" "$tmp/np.log" "" )
check "non-default port: still ollama provider (default)" "0" "$(argv_has 1 ollama && echo 0 || echo 1)"
check "non-default port: CODEX_OSS_BASE_URL reaches the real endpoint" \
  "http://localhost:11500/v1" "$(oss_base 1)"

# --- engine-level fallback: retry once on a NON-limit failure -------------------
reset_shim
printf '{"type":"error","message":"boom, internal server error"}\n' > "$CODEX_SHIM_DIR/fixture.1"
printf '{"type":"turn.completed"}\n' > "$CODEX_SHIM_DIR/fixture.2"
echo 1 > "$CODEX_SHIM_DIR/rc.1"
echo 0 > "$CODEX_SHIM_DIR/rc.2"
log="$tmp/session3.log"
agent_invoke "$tmp/loop_prompt.md" "$tmp/hard_rules.md" primary-model fallback-model "$log" ""
check "fallback retry returns the second exit code" "0" "$?"
check "two codex calls (primary then fallback)" "2" "$(shim_calls)"
check "second call uses the fallback model" "0" "$(argv_has 2 fallback-model && echo 0 || echo 1)"
check "both attempts' events in one log" "0" "$(grep -q 'internal server error' "$log" && grep -q 'turn.completed' "$log" && echo 0 || echo 1)"

# --- fallback NOT burned on a usage limit (account-global) ----------------------
reset_shim
printf '{"type":"turn.failed","error":{"code":"rate_limit_reached","message":"Rate limit reached for the model"}}\n' > "$CODEX_SHIM_DIR/fixture"
echo 1 > "$CODEX_SHIM_DIR/rc"
agent_invoke "$tmp/loop_prompt.md" "$tmp/hard_rules.md" primary-model fallback-model "$tmp/session4.log" ""
check "usage-limit failure exits non-zero" "1" "$?"
check "usage-limit failure does NOT retry with fallback" "1" "$(shim_calls)"

# --- fallback NOT tried when fallback empty or same as primary -------------------
reset_shim
printf '{"type":"error","message":"boom"}\n' > "$CODEX_SHIM_DIR/fixture"
echo 1 > "$CODEX_SHIM_DIR/rc"
agent_invoke "$tmp/loop_prompt.md" "$tmp/hard_rules.md" m1 "" "$tmp/session5.log" ""
check "no retry when fallback is empty" "1" "$(shim_calls)"
reset_shim
printf '{"type":"error","message":"boom"}\n' > "$CODEX_SHIM_DIR/fixture"
echo 1 > "$CODEX_SHIM_DIR/rc"
agent_invoke "$tmp/loop_prompt.md" "$tmp/hard_rules.md" m1 m1 "$tmp/session6.log" ""
check "no retry when fallback == primary" "1" "$(shim_calls)"

# --- classification: fixture JSONL through the real parsers ---------------------
mklog() { printf '%s\n' "$1" > "$tmp/log.jsonl"; echo "$tmp/log.jsonl"; }

f="$(mklog '{"type":"turn.failed","error":{"code":"rate_limit_reached","message":"Rate limit reached"}}')"
check "turn.failed rate_limit code -> usage_limit (no epoch)" "usage_limit" "$(agent_classify_outcome "$f" 1)"

f="$(mklog '{"type":"error","message":"You have hit your usage limit. Try again later."}')"
check "error-envelope usage-limit message -> usage_limit" "usage_limit" "$(agent_classify_outcome "$f" 1)"

f="$(mklog '{"type":"error","message":"HTTP 429 Too Many Requests"}')"
check "429 error message -> usage_limit" "usage_limit" "$(agent_classify_outcome "$f" 1)"

ISO_EPOCH="$(python3 -c 'from datetime import datetime,timezone;print(int(datetime(2030,6,30,12,0,0,tzinfo=timezone.utc).timestamp()))')"
printf '%s\n%s\n' \
  '{"type":"token_count","rate_limits":{"primary":{"used_percent":100.0,"window_minutes":300,"resets_at":"2030-06-30T12:00:00Z"}}}' \
  '{"type":"turn.failed","error":{"code":"rate_limit_reached","message":"Rate limit reached"}}' > "$tmp/log.jsonl"
check "rate_limits resets_at ISO -> usage_limit + epoch" "usage_limit $ISO_EPOCH" "$(agent_classify_outcome "$tmp/log.jsonl" 1)"

printf '%s\n%s\n' \
  '{"type":"token_count","rate_limits":{"primary":{"resets_at":4102444800000}}}' \
  '{"type":"error","message":"rate limit reached"}' > "$tmp/log.jsonl"
check "resets_at epoch-millis normalized to seconds" "usage_limit 4102444800" "$(agent_classify_outcome "$tmp/log.jsonl" 1)"

now="$(date +%s)"
printf '%s\n%s\n' \
  '{"type":"token_count","rate_limits":{"secondary":{"resets_in_seconds":1800}}}' \
  '{"type":"error","message":"usage limit"}' > "$tmp/log.jsonl"
out="$(agent_classify_outcome "$tmp/log.jsonl" 1)"
epoch="${out#usage_limit }"
if [ "$epoch" != "$out" ] && [ -n "$epoch" ] && [ "$epoch" -ge $((now + 1790)) ] && [ "$epoch" -le $((now + 1815)) ]; then
  echo "ok   - resets_in_seconds -> now+secs epoch"
else
  echo "FAIL - resets_in_seconds -> now+secs epoch (got '$out')"; fails=$((fails + 1))
fi

printf '%s\n%s\n' \
  '{"type":"error","message":"rate limit blip mid-session"}' \
  '{"type":"turn.completed","usage":{"input_tokens":1}}' > "$tmp/log.jsonl"
check "limit-mention BUT completed turn -> success" "success" "$(agent_classify_outcome "$tmp/log.jsonl" 0)"

f="$(mklog '{"type":"item.completed","item":{"type":"agent_message","text":"we should discuss the API rate limit and usage limit handling"}}')"
check "agent CONTENT mentioning limits is never parsed" "error" "$(agent_classify_outcome "$f" 1)"

# --- shapes captured from a REAL codex-cli 0.136.0 run (#42 probes): the
# --- error envelope's message is a STRINGIFIED JSON with status + error.type
f="$(mklog '{"type":"turn.failed","error":{"message":"{\"type\":\"error\",\"status\":429,\"error\":{\"type\":\"rate_limit_error\",\"message\":\"Request too fast\"}}"}}')"
check "real-shape stringified 429 envelope -> usage_limit" "usage_limit" "$(agent_classify_outcome "$f" 1)"

f="$(mklog '{"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"usage_limit_reached\",\"message\":\"You have hit your usage limit\"}}"}')"
check "underscored usage_limit_reached in message -> usage_limit" "usage_limit" "$(agent_classify_outcome "$f" 1)"

f="$(mklog '{"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"model not supported\"}}"}')"
check "real-shape invalid-model envelope -> error, not usage_limit" "error" "$(agent_classify_outcome "$f" 1)"

now="$(date +%s)"
printf '%s\n' '{"type":"turn.failed","error":{"message":"{\"type\":\"error\",\"status\":429,\"error\":{\"type\":\"rate_limit_error\",\"resets_in_seconds\":1800}}"}}' > "$tmp/log.jsonl"
out="$(agent_classify_outcome "$tmp/log.jsonl" 1)"
epoch="${out#usage_limit }"
if [ "$epoch" != "$out" ] && [ -n "$epoch" ] && [ "$epoch" -ge $((now + 1790)) ] && [ "$epoch" -le $((now + 1815)) ]; then
  echo "ok   - resets_in_seconds inside stringified envelope -> epoch"
else
  echo "FAIL - resets_in_seconds inside stringified envelope -> epoch (got '$out')"; fails=$((fails + 1))
fi

f="$(mklog '{"type":"turn.failed","error":{"message":"{\"type\":\"error\",\"status\":429,\"error\":{\"type\":\"rate_limit_error\",\"resets_at\":\"2030-06-30T12:00:00Z\"}}"}}')"
check "resets_at inside stringified envelope -> epoch" "usage_limit $ISO_EPOCH" "$(agent_classify_outcome "$f" 1)"

# PR #44 review (NITPICK): multiple reset-ish keys in one envelope must have
# defined precedence -- the LATEST epoch wins (most conservative), never
# dict-iteration order
f="$(mklog '{"type":"turn.failed","error":{"message":"{\"type\":\"error\",\"status\":429,\"error\":{\"type\":\"rate_limit_error\",\"resets_in_seconds\":60,\"resets_at\":\"2030-06-30T12:00:00Z\"}}"}}')"
check "multiple reset keys -> latest epoch wins" "usage_limit $ISO_EPOCH" "$(agent_classify_outcome "$f" 1)"

f="$(mklog '{"type":"turn.completed","usage":{}}')"
check "clean run -> success" "success" "$(agent_classify_outcome "$f" 0)"

f="$(mklog '{"type":"error","message":"some unrelated explosion"}')"
check "plain failure -> error" "error" "$(agent_classify_outcome "$f" 1)"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
