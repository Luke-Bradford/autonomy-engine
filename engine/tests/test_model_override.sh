#!/usr/bin/env bash
# Unit test for #24's live model/effort plumbing:
#   - resolve_session_settings: per-SESSION resolution (config edits and the
#     dashboard's 'save default' take effect without a supervisor restart)
#   - consume_model_override: one-shot override file (dashboard 'next session
#     only'), validated then DELETED -- applies to exactly one session
#   - claude adapter: --effort passed only when an effort is set
# Sourcing defines functions only (guarded loop body does not run).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
source "$HERE/../bin/supervisor.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

# minimal environment the functions expect (read inside the sourced
# supervisor functions -- shellcheck can't see that)
# shellcheck disable=SC2034
SUPLOG="$tmp/supervisor.log"
LOGDIR="$tmp/logs"; mkdir -p "$LOGDIR"
CFG="$tmp/config.yaml"
cat >"$CFG" <<'EOF'
agent:
  type: claude
  model:
    primary: claude-sonnet-5
    fallback: claude-sonnet-4-6
EOF
# shellcheck disable=SC2034
MODEL_OVERRIDE=""
# shellcheck disable=SC2034
FALLBACK_MODEL_OVERRIDE=""
# shellcheck disable=SC2034
EFFORT_OVERRIDE=""

# --- per-session resolution from config ---
resolve_session_settings
check "model from config" "claude-sonnet-5" "$MODEL"
check "fallback from config" "claude-sonnet-4-6" "$FALLBACK_MODEL"
check "effort default empty" "" "$EFFORT"

# config edited between sessions -> next resolution sees it (no restart)
printf 'agent:\n  model:\n    primary: claude-opus-4-8\n    fallback: claude-sonnet-4-6\n  effort: high\n' >"$CFG"
resolve_session_settings
check "config edit picked up per-session: model" "claude-opus-4-8" "$MODEL"
check "config edit picked up per-session: effort" "high" "$EFFORT"

# --- one-shot override file ---
printf 'model=claude-sonnet-5\neffort=max\n' >"$LOGDIR/model-override"
resolve_session_settings
check "override wins for this session: model" "claude-sonnet-5" "$MODEL"
check "override wins for this session: effort" "max" "$EFFORT"
if [ -f "$LOGDIR/model-override" ]; then r=present; else r=consumed; fi
check "override file deleted after consume" consumed "$r"

# next session falls back to config again (one-shot)
resolve_session_settings
check "next session back to config default" "claude-opus-4-8" "$MODEL"

# --- validation: junk is ignored, never applied ---
printf 'model=opus; rm -rf /\neffort=turbo\n' >"$LOGDIR/model-override"
resolve_session_settings
check "shell-metachar model rejected" "claude-opus-4-8" "$MODEL"
check "unknown effort rejected" "high" "$EFFORT"
if [ -f "$LOGDIR/model-override" ]; then r=present; else r=consumed; fi
check "invalid override still consumed (no retry loop)" consumed "$r"

# --- persistent overlay (config-overrides) shadows config.yaml (#202) ---
cat >"$CFG" <<'EOF'
agent:
  model:
    primary: claude-sonnet-5
    fallback: claude-sonnet-4-6
EOF
printf 'model=claude-opus-4-8\nfallback=claude-haiku-4-5\neffort=high\n' >"$LOGDIR/config-overrides"
resolve_session_settings
check "overlay shadows config: model" "claude-opus-4-8" "$MODEL"
check "overlay shadows config: fallback" "claude-haiku-4-5" "$FALLBACK_MODEL"
check "overlay shadows config: effort" "high" "$EFFORT"
if [ -f "$LOGDIR/config-overrides" ]; then r=present; else r=gone; fi
check "overlay persists (not consumed)" present "$r"
# settled #13 precedence around the overlay: CLI > role > overlay > config.
# Each override var is set for one resolve then `unset` back to "not passed"
# (read inside the sourced resolve_session_settings via `${VAR:-...}`, so unset
# is safe under `set -u`). The expected value references the var itself, which
# also gives shellcheck a real read (no SC2034 on these set-once locals).
ROLE_MODEL="claude-haiku-4-5"; resolve_session_settings
check "role model beats overlay" "$ROLE_MODEL" "$MODEL"; unset ROLE_MODEL
ROLE_EFFORT="low"; resolve_session_settings
check "role effort beats overlay" "$ROLE_EFFORT" "$EFFORT"; unset ROLE_EFFORT
MODEL_OVERRIDE="claude-sonnet-5"; resolve_session_settings
check "CLI model beats overlay" "$MODEL_OVERRIDE" "$MODEL"; unset MODEL_OVERRIDE
FALLBACK_MODEL_OVERRIDE="claude-sonnet-4-6"; resolve_session_settings
check "CLI fallback beats overlay" "$FALLBACK_MODEL_OVERRIDE" "$FALLBACK_MODEL"; unset FALLBACK_MODEL_OVERRIDE
# one-shot override still wins last, even over the overlay
printf 'model=claude-sonnet-5\n' >"$LOGDIR/model-override"
resolve_session_settings
check "one-shot beats overlay" "claude-sonnet-5" "$MODEL"
if [ -f "$LOGDIR/model-override" ]; then r=present; else r=gone; fi
check "one-shot consumed even with overlay present" gone "$r"
# invalid overlay ignored -> falls back to committed config (fail-safe)
printf 'model=bad;id\neffort=nope\n' >"$LOGDIR/config-overrides"
resolve_session_settings
check "invalid overlay model ignored" "claude-sonnet-5" "$MODEL"
check "invalid overlay effort ignored" "" "$EFFORT"
# stray-space lines are ignored (no line-strip) -- the dashboard reader must
# match this exactly so it never displays a value the supervisor won't use.
printf ' model=claude-opus-4-8\nfallback=claude-haiku-4-5 \n' >"$LOGDIR/config-overrides"
resolve_session_settings
check "leading-space overlay key ignored" "claude-sonnet-5" "$MODEL"
check "trailing-space overlay value ignored" "claude-sonnet-4-6" "$FALLBACK_MODEL"
rm -f "$LOGDIR/config-overrides"
# restore config.yaml to opus for the subsequent one-shot/unit checks
printf 'agent:\n  model:\n    primary: claude-opus-4-8\n    fallback: claude-sonnet-4-6\n  effort: high\n' >"$CFG"

# valid ids incl. context-window suffix pass
if valid_model_id "claude-opus-4-8[1m]"; then r=ok; else r=rejected; fi
check "model id with [1m] suffix accepted" ok "$r"
if valid_model_id ""; then r=ok; else r=rejected; fi
check "empty model id rejected" rejected "$r"
# parity with dashboard_control.MODEL_RE (#31): must start alnum, <=64 chars
if valid_model_id ".claude"; then r=ok; else r=rejected; fi
check "model id starting with punctuation rejected" rejected "$r"
if valid_model_id "-claude"; then r=ok; else r=rejected; fi
check "model id starting with dash rejected" rejected "$r"
long="a12345678901234567890123456789012345678901234567890123456789012345"  # 65 chars
if valid_model_id "$long"; then r=ok; else r=rejected; fi
check "model id over 64 chars rejected" rejected "$r"
# local-LLM ids are Ollama-style name:tag (e.g. qwen3:14b) -- the colon must be
# accepted so BYO-LLM roles reach argv with their real model, not the opus
# fallback (#213). Colon is shell-safe in an exec argv token (no shell parse).
if valid_model_id "qwen3:14b"; then r=ok; else r=rejected; fi
check "colon-bearing local model id accepted" ok "$r"
if valid_model_id "bad:model;rm"; then r=ok; else r=rejected; fi
check "colon does not admit shell metacharacters" rejected "$r"

# --- valid_prompt_path: dispatch-time re-validation of a role's prompt (#63) ---
# Parity with valid_model_id -- re-check the config-sourced path before it
# lands in a filename, independent of doctor's preflight check_prompt_files.
if valid_prompt_path ".autonomy/roles/qa.md"; then r=ok; else r=rejected; fi
check "repo-relative pack prompt path accepted" ok "$r"
if valid_prompt_path "..hidden.md"; then r=ok; else r=rejected; fi
check "dotted filename (not a .. segment) accepted" ok "$r"
if valid_prompt_path ""; then r=ok; else r=rejected; fi
check "empty prompt path rejected" rejected "$r"
if valid_prompt_path "/etc/passwd"; then r=ok; else r=rejected; fi
check "absolute prompt path rejected" rejected "$r"
if valid_prompt_path "../../../etc/passwd"; then r=ok; else r=rejected; fi
check "leading ..-escape prompt path rejected" rejected "$r"
if valid_prompt_path ".autonomy/../../secret"; then r=ok; else r=rejected; fi
check "mid-path .. segment rejected" rejected "$r"
if valid_prompt_path "roles/.."; then r=ok; else r=rejected; fi
check "trailing .. segment rejected" rejected "$r"

# --- adapter: --effort only when set ---
# shellcheck source=/dev/null
source "$HERE/../bin/agents/claude.sh"
claude() { printf '%s\n' "$*" >"$tmp/claude-args"; }
prompt="$tmp/p.md"; rules="$tmp/r.md"; echo p >"$prompt"; echo r >"$rules"

agent_invoke "$prompt" "$rules" m1 m2 "$tmp/s1.log" "high"
case "$(cat "$tmp/claude-args")" in *"--effort high"*) r=yes;; *) r=no;; esac
check "adapter passes --effort when set" yes "$r"

agent_invoke "$prompt" "$rules" m1 m2 "$tmp/s2.log" ""
case "$(cat "$tmp/claude-args")" in *"--effort"*) r=yes;; *) r=no;; esac
check "adapter omits --effort when empty" no "$r"

agent_invoke "$prompt" "$rules" m1 m2 "$tmp/s3.log"
case "$(cat "$tmp/claude-args")" in *"--effort"*) r=yes;; *) r=no;; esac
check "adapter tolerates missing 6th arg (old callers)" no "$r"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
