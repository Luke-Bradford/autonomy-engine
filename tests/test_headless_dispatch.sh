#!/usr/bin/env bash
# tests/test_headless_dispatch.sh -- headless multi-agent dispatch (agent-org
# increment 3). The supervisor runs ANY enabled loop role: enumeration via
# roles.py dispatch (real python, real parser), account env resolved via the
# AUTONOMY_ACCOUNTS_BIN seam and exported session-scoped only, fail-safe
# refusal on broken auth, scope composed into the session rules file.
# shellcheck disable=SC2034  # vars consumed inside the sourced supervisor.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_HOME="$(cd "$HERE/.." && pwd)"

# shellcheck source=/dev/null
source "$ENGINE_HOME/bin/supervisor.sh"
SUPLOG=/dev/null
log() { :; }

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# A minimal target repo: pack files + a roles: block with two loop roles.
AUTONOMY_TARGET_REPO="$tmp/repo"
mkdir -p "$AUTONOMY_TARGET_REPO/.autonomy/roles"
printf 'do the work\n' > "$AUTONOMY_TARGET_REPO/.autonomy/loop_prompt.md"
printf 'hard rules\n' > "$AUTONOMY_TARGET_REPO/.autonomy/hard_rules.md"
printf 'qa prompt\n' > "$AUTONOMY_TARGET_REPO/.autonomy/roles/qa.md"
cat > "$AUTONOMY_TARGET_REPO/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
    account: acct-good
  qa:
    enabled: true
    trigger: { type: loop }
    account: acct-broken
    model: claude-opus-4-8
    effort: high
    scope: { labels: [ready] }
    prompt: .autonomy/roles/qa.md
YAML

# --- select_role -------------------------------------------------------------
check "select_role picks index 0" "coder" "$(select_role 0 coder qa)"
check "select_role picks index 1" "qa" "$(select_role 1 coder qa)"
check "select_role wraps around" "coder" "$(select_role 2 coder qa)"
check "select_role single role always" "coder" "$(select_role 7 coder)"
select_role 0 >/dev/null 2>&1
check "select_role with no roles fails" "1" "$?"

# --- resolve_dispatch_roles (real roles.py against the real config) ----------
check "enumerates enabled loop roles" "coder qa" "$(resolve_dispatch_roles | tr '\n' ' ' | sed 's/ $//')"

# --- resolve_role_dispatch ---------------------------------------------------
resolve_role_dispatch qa
check "role account parsed" "acct-broken" "$ROLE_ACCOUNT"
check "role model parsed" "claude-opus-4-8" "$ROLE_MODEL"
check "role effort parsed" "high" "$ROLE_EFFORT"
check "role prompt parsed" ".autonomy/roles/qa.md" "$ROLE_PROMPT"
check "role scope parsed" "Scope: work ONLY within this scope: labels: ready." "$ROLE_SCOPE"
check "role instances default" "1" "$ROLE_INSTANCES"

resolve_role_dispatch coder
check "unset role fields come back empty" "" "$ROLE_MODEL"

resolve_role_dispatch researcher >/dev/null 2>&1
check "undispatchable role refuses" "1" "$?"

# an invalid model id from the config is blanked, never passed to argv
cat > "$AUTONOMY_TARGET_REPO/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
    model: "bad;model"
    effort: bogus
YAML
resolve_role_dispatch coder
check "invalid role model blanked" "" "$ROLE_MODEL"
check "invalid role effort blanked" "" "$ROLE_EFFORT"

# --- per-role agent type (#78) -----------------------------------------------
cat > "$AUTONOMY_TARGET_REPO/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
    agent: codex
YAML
resolve_role_dispatch coder
check "role agent parsed" "codex" "$ROLE_AGENT"

cat > "$AUTONOMY_TARGET_REPO/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
YAML
resolve_role_dispatch coder
check "role agent empty when unset" "" "$ROLE_AGENT"

# a bogus agent value crosses into a `source .../${ROLE_AGENT}.sh` path -- it
# must be charset-gated at the point of use and blanked (prevention-log #6)
cat > "$AUTONOMY_TARGET_REPO/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
    agent: "../evil"
YAML
resolve_role_dispatch coder
check "invalid role agent blanked (never a source path)" "" "$ROLE_AGENT"

# --- resolve_account_env (seam) ----------------------------------------------
cat > "$tmp/accounts-stub" <<'SH'
#!/bin/sh
# args: resolve <name>
if [ "$1" = "resolve" ] && [ "$2" = "acct-good" ]; then
  printf 'ANTHROPIC_API_KEY=sk-acct-77\n'
  exit 0
fi
if [ "$1" = "resolve" ] && [ "$2" = "acct-sub" ]; then
  exit 0
fi
echo "accounts.py: no secret" >&2
exit 1
SH
chmod +x "$tmp/accounts-stub"
export AUTONOMY_ACCOUNTS_BIN="$tmp/accounts-stub"

check "api account resolves env lines" "ANTHROPIC_API_KEY=sk-acct-77" "$(resolve_account_env acct-good)"
check "subscription account resolves empty" "" "$(resolve_account_env acct-sub)"
resolve_account_env acct-broken >/dev/null 2>&1
check "broken account refuses (rc 1)" "1" "$?"

# --- invoke_scoped_env --------------------------------------------------------
envfile="$tmp/seen_env"
agent_invoke() { echo "${ANTHROPIC_API_KEY:-NONE}|${OPENAI_API_KEY:-NONE}" > "$envfile"; return 0; }

unset ANTHROPIC_API_KEY OPENAI_API_KEY
invoke_scoped_env 'ANTHROPIC_API_KEY=sk-a
OPENAI_API_KEY=sk-o' a b c d e
check "multi-line env exported to the session" "sk-a|sk-o" "$(cat "$envfile")"
check "env does not leak into the supervisor" "" "${ANTHROPIC_API_KEY:-}${OPENAI_API_KEY:-}"

invoke_scoped_env "" a b c d e
check "empty env = ambient auth untouched" "NONE|NONE" "$(cat "$envfile")"

invoke_scoped_env 'not a var line
ANTHROPIC_API_KEY=sk-b' a b c d e
check "malformed env lines skipped, valid ones kept" "sk-b|NONE" "$(cat "$envfile")"

invoke_scoped_env 'ANTHROPIC_API_KEY
OPENAI_API_KEY=sk-c' a b c d e
check "eq-less line skipped, never exported as VAR=VAR" "NONE|sk-c" "$(cat "$envfile")"

# invoke_scoped_key still works (test_role_credential.sh covers it fully;
# this is the wrap-not-regress smoke check)
invoke_scoped_key "sk-legacy" a b c d e
check "invoke_scoped_key wraps scoped env" "sk-legacy|NONE" "$(cat "$envfile")"

# --- compose_session_rules ----------------------------------------------------
rules="$AUTONOMY_TARGET_REPO/.autonomy/hard_rules.md"
out="$(compose_session_rules "$rules" "" "$tmp/composed")"
check "no scope: original rules path" "$rules" "$out"
check "no scope: nothing composed" "1" "$([ -f "$tmp/composed" ] && echo 0 || echo 1)"

out="$(compose_session_rules "$rules" "Scope: only ready." "$tmp/composed")"
check "scope: composed path returned" "$tmp/composed" "$out"
check "scope: rules kept" "hard rules" "$(head -1 "$tmp/composed")"
check "scope: directive appended" "Scope: only ready." "$(tail -1 "$tmp/composed")"

compose_session_rules "$rules" "Scope: x." "$tmp/no-such-dir/out" >/dev/null 2>&1
check "unwritable compose refuses (rc 1)" "1" "$?"


# --- run_session end-to-end (stub adapter via the AUTONOMY_AGENTS_DIR seam) ---
mkdir -p "$tmp/agents"
cat > "$tmp/agents/stub.sh" <<'SH'
agent_invoke() {
  {
    echo "key=${ANTHROPIC_API_KEY:-NONE}"
    echo "prompt=$1"
    echo "rules=$2"
    echo "model=$3"
    echo "effort=${6:-}"
  } > "${STUB_CAPTURE:?}"
  return 0
}
agent_classify_outcome() { echo "success"; }
SH
export AUTONOMY_AGENTS_DIR="$tmp/agents"
AGENT_TYPE=stub
export STUB_CAPTURE="$tmp/capture"

# run_session needs: preflight (needs a real git repo -- stub it: dispatch
# behaviour, not git hygiene, is under test here), CFG, LOGDIR, overrides.
preflight() { return 0; }
CFG="$AUTONOMY_TARGET_REPO/.autonomy/config.yaml"
LOGDIR="$tmp/logs"; mkdir -p "$LOGDIR"
MODEL_OVERRIDE=""; FALLBACK_MODEL_OVERRIDE=""; EFFORT_OVERRIDE=""

# credentials stub: a legacy #51-C key exists for coder (accounts must win)
cat > "$tmp/creds-stub" <<'SH'
#!/bin/sh
if [ "$1" = "resolve-role" ] && [ "$2" = "coder" ]; then printf 'sk-legacy'; exit 0; fi
exit 1
SH
chmod +x "$tmp/creds-stub"
export AUTONOMY_CREDENTIALS_BIN="$tmp/creds-stub"

cat > "$AUTONOMY_TARGET_REPO/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
    account: acct-good
  qa:
    enabled: true
    trigger: { type: loop }
    model: claude-opus-4-8
    effort: high
    scope: { labels: [ready] }
    prompt: .autonomy/roles/qa.md
  broken:
    enabled: true
    account: acct-broken
YAML

grab() { grep "^$1=" "$STUB_CAPTURE" | head -1 | cut -d= -f2-; }

# 1) account-backed role: account env wins over the legacy credential
unset ANTHROPIC_API_KEY
run_session coder
check "account role: session rc 0" "0" "$?"
check "account role: account key exported (beats #51-C credential)" "sk-acct-77" "$(grab key)"
check "account role: default loop prompt" "$AUTONOMY_TARGET_REPO/.autonomy/loop_prompt.md" "$(grab prompt)"
check "account role: plain hard_rules (no scope)" "$AUTONOMY_TARGET_REPO/.autonomy/hard_rules.md" "$(grab rules)"
check "account role: key never leaks into supervisor" "" "${ANTHROPIC_API_KEY:-}"

# 2) role without account: legacy credential path (best-effort) still runs
: > "$STUB_CAPTURE"
run_session qa
check "credential-less role: session rc 0" "0" "$?"
check "no account: subscription/none (qa has no credential either)" "NONE" "$(grab key)"
check "role model reaches the adapter" "claude-opus-4-8" "$(grab model)"
check "role effort reaches the adapter" "high" "$(grab effort)"
check "role prompt reaches the adapter" "$AUTONOMY_TARGET_REPO/.autonomy/roles/qa.md" "$(grab prompt)"
rules_path="$(grab rules)"
check "scope: composed rules file used" "0" "$([ "$rules_path" != "$AUTONOMY_TARGET_REPO/.autonomy/hard_rules.md" ] && echo 0 || echo 1)"
check "scope: directive present in composed rules" "Scope: work ONLY within this scope: labels: ready." "$(tail -1 "$rules_path")"
check "scope: hard rules kept in composed file" "hard rules" "$(head -1 "$rules_path")"

# 3) fail-safe: an unresolvable account REFUSES the session, adapter never runs
: > "$STUB_CAPTURE"
run_session broken
check "broken account: session refused rc 2" "2" "$?"
check "broken account: adapter never invoked" "" "$(cat "$STUB_CAPTURE")"

# 4) CLI override still beats the role model
MODEL_OVERRIDE="claude-sonnet-5"
run_session qa
check "CLI --model beats roles.qa.model" "claude-sonnet-5" "$(grab model)"
MODEL_OVERRIDE=""

# 5) one-shot dashboard override beats the role model (applied last)
printf 'model=claude-haiku-4-5\n' > "$LOGDIR/model-override"
run_session qa
check "one-shot override beats roles.qa.model" "claude-haiku-4-5" "$(grab model)"
check "one-shot override consumed" "1" "$([ -f "$LOGDIR/model-override" ] && echo 0 || echo 1)"

# 6) missing role prompt file refuses (fail-safe)
rm "$AUTONOMY_TARGET_REPO/.autonomy/roles/qa.md"
run_session qa
check "missing prompt file: session refused rc 2" "2" "$?"
printf 'qa prompt\n' > "$AUTONOMY_TARGET_REPO/.autonomy/roles/qa.md"

# 7) back-compat: no-arg run_session honours the ROLE env contract
: > "$STUB_CAPTURE"
ROLE=qa run_session
check "no-arg run_session uses \$ROLE" "$AUTONOMY_TARGET_REPO/.autonomy/roles/qa.md" "$(grab prompt)"

# 8) per-role agent adapter: run_session sources the ROLE's agent, not the
# global $AGENT_TYPE (a second stub adapter proves the switch) (#78)
cat > "$tmp/agents/codexstub.sh" <<'SH'
agent_invoke() { echo "CODEXSTUB" > "${STUB_CAPTURE:?}"; return 0; }
agent_classify_outcome() { echo "success"; }
SH
cat > "$AUTONOMY_TARGET_REPO/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
    agent: codexstub
YAML
: > "$STUB_CAPTURE"
run_session coder
check "run_session sources the role's agent adapter" "CODEXSTUB" "$(cat "$STUB_CAPTURE")"

# and with no role agent, the global $AGENT_TYPE (stub) still runs
cat > "$AUTONOMY_TARGET_REPO/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
YAML
: > "$STUB_CAPTURE"
run_session coder
check "run_session falls back to \$AGENT_TYPE when role agent unset" "success" \
  "$(grep -q '^key=' "$STUB_CAPTURE" && echo success || echo MISS)"

# 9) fail-safe: a role naming a MISSING adapter refuses (rc 2) and never runs a
# stale round-robin adapter (#98). `agent: ghost` passes roles.py's string check
# and the charset gate, so ROLE_AGENT=ghost and `source .../ghost.sh` would fail
# silently under set -uo pipefail -- leaving section 8's real agent_invoke still
# defined. A non-refusing path would therefore run that stale adapter and write
# the capture; assert the session refuses and the capture stays empty.
cat > "$AUTONOMY_TARGET_REPO/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
    agent: ghost
YAML
: > "$STUB_CAPTURE"
run_session coder
check "missing adapter: session refused rc 2" "2" "$?"
check "missing adapter: no stale adapter ran" "" "$(cat "$STUB_CAPTURE")"

# prime: a valid adapter run so a REAL agent_invoke is defined (the stale
# candidate the guard must clear before loading the next, bad adapter).
prime_stub() {
  cat > "$AUTONOMY_TARGET_REPO/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
YAML
  : > "$STUB_CAPTURE"; run_session coder >/dev/null 2>&1
}

# 9b) fail-safe: an adapter that EXISTS but is incomplete (does not define the
# agent_invoke/agent_classify_outcome contract) must also refuse -- a bare `-f`
# check would pass, `source` an empty file cleanly, then run the PRIOR role's
# stale agent_invoke. The guard clears stale defs first, so this refuses.
printf '# incomplete adapter: defines nothing\n' > "$tmp/agents/incomplete.sh"
prime_stub
cat > "$AUTONOMY_TARGET_REPO/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
    agent: incomplete
YAML
: > "$STUB_CAPTURE"
run_session coder
check "incomplete adapter: session refused rc 2" "2" "$?"
check "incomplete adapter: no stale adapter ran" "" "$(cat "$STUB_CAPTURE")"

# 9c) fail-safe: an adapter that exists but errors while sourcing (syntax error)
# must refuse, not fall through to stale defs.
printf 'agent_invoke() { :; }\nthis is not valid shell (\n' > "$tmp/agents/broken.sh"
prime_stub
cat > "$AUTONOMY_TARGET_REPO/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
    agent: broken
YAML
: > "$STUB_CAPTURE"
run_session coder 2>/dev/null
check "broken adapter: session refused rc 2" "2" "$?"
check "broken adapter: no stale adapter ran" "" "$(cat "$STUB_CAPTURE")"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
