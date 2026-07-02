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
fixture="$CODEX_SHIM_DIR/fixture.$n"
[ -f "$fixture" ] || fixture="$CODEX_SHIM_DIR/fixture"
[ -f "$fixture" ] && cat "$fixture"
rc_file="$CODEX_SHIM_DIR/rc.$n"
[ -f "$rc_file" ] || rc_file="$CODEX_SHIM_DIR/rc"
exit "$(cat "$rc_file" 2>/dev/null || echo 0)"
SH
chmod +x "$shim/codex"
export PATH="$shim:$PATH"

reset_shim() { rm -f "$CODEX_SHIM_DIR"/count "$CODEX_SHIM_DIR"/argv.* "$CODEX_SHIM_DIR"/fixture* "$CODEX_SHIM_DIR"/rc*; }
shim_calls() { cat "$CODEX_SHIM_DIR/count" 2>/dev/null || echo 0; }
# argv.N as newline-joined for simple grep (args themselves contain newlines,
# so ordering checks go through python)
argv_has() { tr '\0' '\n' < "$CODEX_SHIM_DIR/argv.$1" | grep -qxF -- "$2"; }

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

f="$(mklog '{"type":"turn.completed","usage":{}}')"
check "clean run -> success" "success" "$(agent_classify_outcome "$f" 0)"

f="$(mklog '{"type":"error","message":"some unrelated explosion"}')"
check "plain failure -> error" "error" "$(agent_classify_outcome "$f" 1)"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
