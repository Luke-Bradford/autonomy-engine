#!/usr/bin/env bash
# tests/test_role_credential.sh -- a role's assigned API key is injected into
# its session ENV only for that session (#51-C). No key assigned -> nothing
# exported, subscription auth unchanged (the default path). The key must never
# leak into the supervisor's own environment.
# shellcheck disable=SC2034  # ROLE is set here, consumed inside the sourced supervisor.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_HOME="$(cd "$HERE/.." && pwd)"

# shellcheck source=/dev/null
source "$ENGINE_HOME/bin/supervisor.sh"
# shellcheck disable=SC2034  # consumed by log() in the sourced supervisor.sh
SUPLOG=/dev/null
log() { :; }

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Stub the credentials binary: prints a fake secret for role 'coder', nothing
# (exit 1) for anything else -- exactly the resolve-role contract.
cat > "$tmp/creds-stub" <<'SH'
#!/bin/sh
# args: resolve-role <role>
if [ "$1" = "resolve-role" ] && [ "$2" = "coder" ]; then
  printf 'sk-ROLEKEY-42'
  exit 0
fi
exit 1
SH
chmod +x "$tmp/creds-stub"
export AUTONOMY_CREDENTIALS_BIN="$tmp/creds-stub"

# --- resolve_role_credential ------------------------------------------------
check "resolve returns the assigned key" "sk-ROLEKEY-42" "$(resolve_role_credential coder)"
check "resolve returns empty for an unassigned role" "" "$(resolve_role_credential researcher)"

# --- invoke_scoped_key + resolve_role_credential: the run_session path ------
# stub agent_invoke to record what ANTHROPIC_API_KEY it sees
envfile="$tmp/seen_key"
agent_invoke() { echo "${ANTHROPIC_API_KEY:-NONE}" > "$envfile"; return 0; }

# ensure the supervisor env starts clean
unset ANTHROPIC_API_KEY

ROLE=coder
invoke_scoped_key "$(resolve_role_credential "${ROLE:-coder}")" a b c d e
check "assigned role: key exported to the session" "sk-ROLEKEY-42" "$(cat "$envfile")"
check "assigned role: key does NOT leak into supervisor env" "" "${ANTHROPIC_API_KEY:-}"

ROLE=researcher
invoke_scoped_key "$(resolve_role_credential "${ROLE:-coder}")" a b c d e
check "unassigned role: no key exported (subscription)" "NONE" "$(cat "$envfile")"
check "unassigned role: supervisor env still clean" "" "${ANTHROPIC_API_KEY:-}"

# --- a pre-existing ambient key is preserved when no role key is assigned ----
export ANTHROPIC_API_KEY="ambient-sub-key"
ROLE=researcher
invoke_scoped_key "$(resolve_role_credential "${ROLE:-coder}")" a b c d e
check "no role key: ambient env key passes through" "ambient-sub-key" "$(cat "$envfile")"
check "no role key: ambient key unchanged after" "ambient-sub-key" "${ANTHROPIC_API_KEY:-}"

# assigned role overrides the ambient key, but only for the session
ROLE=coder
invoke_scoped_key "$(resolve_role_credential "${ROLE:-coder}")" a b c d e
check "assigned role overrides ambient for the session" "sk-ROLEKEY-42" "$(cat "$envfile")"
check "ambient key restored after the session" "ambient-sub-key" "${ANTHROPIC_API_KEY:-}"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
