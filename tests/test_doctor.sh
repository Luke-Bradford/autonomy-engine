#!/usr/bin/env bash
# Unit test for doctor.sh's fast, local-only preflight check.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
source "$HERE/../bin/doctor.sh"

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

check "missing .autonomy/ -> hard fail" "1" "$(doctor_preflight_check "$tmp" >/dev/null 2>&1; echo $?)"

mkdir -p "$tmp/.autonomy"
cat > "$tmp/.autonomy/config.yaml" <<'YAML'
engine:
  requires_claude_md: false
YAML
check "valid config, requires_claude_md false -> pass" "0" "$(doctor_preflight_check "$tmp" >/dev/null 2>&1; echo $?)"

cat > "$tmp/.autonomy/config.yaml" <<'YAML'
engine:
  requires_claude_md: true
YAML
check "requires_claude_md true, no CLAUDE.md -> hard fail" "1" "$(doctor_preflight_check "$tmp" >/dev/null 2>&1; echo $?)"
# The FAIL message must point at the scaffold, not dead-end (#152). Capture the
# message first (the function returns 1, which pipefail would otherwise let
# poison a `... | grep` pipeline), then grep the captured text.
claude_fail_msg="$(doctor_preflight_check "$tmp" 2>&1 >/dev/null || true)"
check "requires_claude_md FAIL points at the --claude-md scaffold" "0" \
  "$(printf '%s' "$claude_fail_msg" | grep -q -- '--claude-md' && echo 0 || echo 1)"

mkdir -p "$tmp/.claude"
touch "$tmp/.claude/CLAUDE.md"
check "requires_claude_md true, CLAUDE.md present -> pass" "0" "$(doctor_preflight_check "$tmp" >/dev/null 2>&1; echo $?)"

# Claude Code loads CLAUDE.md from the repo ROOT as well as .claude/ -- doctor
# must accept either location, else a root-CLAUDE.md repo (like autonomy-engine
# itself) fails readiness despite the file being loaded at runtime.
rm -f "$tmp/.claude/CLAUDE.md"
check "requires_claude_md true, neither location -> hard fail" "1" "$(doctor_preflight_check "$tmp" >/dev/null 2>&1; echo $?)"
touch "$tmp/CLAUDE.md"
check "requires_claude_md true, root CLAUDE.md present -> pass" "0" "$(doctor_preflight_check "$tmp" >/dev/null 2>&1; echo $?)"
rm -f "$tmp/CLAUDE.md"
touch "$tmp/.claude/CLAUDE.md"  # restore for subsequent checks

echo "this line has no colon whatsoever" > "$tmp/.autonomy/config.yaml"
check "malformed config.yaml -> hard fail" "1" "$(doctor_preflight_check "$tmp" >/dev/null 2>&1; echo $?)"

# --- roles: block validation via lib/roles.py (#12) ---
cat > "$tmp/.autonomy/config.yaml" <<'YAML'
engine:
  requires_claude_md: false
roles:
  coder:
    enabled: true
    substrate: engine
    trigger: { type: loop }
YAML
check "valid roles block -> roles.py passes" "0" "$(python3 "$HERE/../lib/roles.py" "$tmp" >/dev/null 2>&1; echo $?)"

cat > "$tmp/.autonomy/config.yaml" <<'YAML'
engine:
  requires_claude_md: false
roles:
  qa:
    substrate: kubernetes
    trigger: { type: webhook }
YAML
check "invalid roles block -> roles.py fails" "1" "$(python3 "$HERE/../lib/roles.py" "$tmp" >/dev/null 2>&1; echo $?)"

cat > "$tmp/.autonomy/config.yaml" <<'YAML'
engine:
  requires_claude_md: false
YAML
check "no roles block -> rc 3 (valid, defaults apply)" "3" "$(python3 "$HERE/../lib/roles.py" "$tmp" >/dev/null 2>&1; echo $?)"

cat > "$tmp/.autonomy/config.yaml" <<'YAML'
roles:
  pm:
    prompt: .autonomy/roles/pm.md
YAML
check "missing prompt file -> roles.py fails" "1" "$(python3 "$HERE/../lib/roles.py" "$tmp" >/dev/null 2>&1; echo $?)"
mkdir -p "$tmp/.autonomy/roles"; touch "$tmp/.autonomy/roles/pm.md"
check "prompt file present -> roles.py passes" "0" "$(python3 "$HERE/../lib/roles.py" "$tmp" >/dev/null 2>&1; echo $?)"

# --- roles.account -> accounts registry (agent-org increment 2) ---
fake_home="$tmp/fakehome"
mkdir -p "$fake_home/.config/autonomy"
printf '{"accounts": {"claude-sub": {"kind": "claude_subscription"}}}\n' \
  > "$fake_home/.config/autonomy/accounts"
cat > "$tmp/.autonomy/config.yaml" <<'YAML'
engine:
  requires_claude_md: false
roles:
  coder:
    account: claude-sub
    trigger: { type: loop }
YAML
check "role account present in registry -> roles.py passes" "0" \
  "$(HOME="$fake_home" python3 "$HERE/../lib/roles.py" "$tmp" >/dev/null 2>&1; echo $?)"

cat > "$tmp/.autonomy/config.yaml" <<'YAML'
engine:
  requires_claude_md: false
roles:
  coder:
    account: no-such-account
    trigger: { type: loop }
YAML
check "role account missing from registry -> roles.py fails" "1" \
  "$(HOME="$fake_home" python3 "$HERE/../lib/roles.py" "$tmp" >/dev/null 2>&1; echo $?)"

# --- QA role readiness check (#13) ---
cat > "$tmp/.autonomy/config.yaml" <<'YAML'
roles:
  qa:
    enabled: true
    substrate: actions
    trigger:
      type: event
      on: [pr.opened]
YAML
case "$(doctor_qa_role_check "$tmp")" in
  WARN*qa-gate*) r=warn ;;
  *) r=other ;;
esac
check "qa enabled (actions), no workflow -> WARN" warn "$r"

mkdir -p "$tmp/.github/workflows"
printf 'name: QA merge gate\n# context: qa-gate\n' > "$tmp/.github/workflows/qa-merge-gate.yml"
case "$(doctor_qa_role_check "$tmp")" in
  OK*) r=ok ;;
  *) r=other ;;
esac
check "qa enabled (actions), workflow present -> OK" ok "$r"

cat > "$tmp/.autonomy/config.yaml" <<'YAML'
roles:
  qa:
    enabled: false
YAML
check "qa disabled -> no line" "" "$(doctor_qa_role_check "$tmp")"

cat > "$tmp/.autonomy/config.yaml" <<'YAML'
roles:
  qa:
    enabled: true
    substrate: routine
YAML
case "$(doctor_qa_role_check "$tmp")" in
  WARN*routine*) r=warn ;;
  *) r=other ;;
esac
check "qa on routine substrate -> WARN (unverifiable locally)" warn "$r"

# --- fail-safe honesty: doctor surfaces set-but-unwired role knobs (#149) ------
cat > "$tmp/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
    self_test: true
YAML
knob_out="$(doctor_knob_notes "$tmp" 2>&1)"
check "doctor surfaces a set-but-unwired knob (#149)" "0" \
  "$(printf '%s' "$knob_out" | grep -q 'roles.coder.self_test is set but' && echo 0 || echo 1)"
cat > "$tmp/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
YAML
check "doctor knob-notes stays silent when nothing to say" "" "$(doctor_knob_notes "$tmp" 2>&1)"

# --- lanes: doctor reports declared lanes + non-executable-yet warning (#147) --
cat > "$tmp/.autonomy/config.yaml" <<'YAML'
lanes:
  main: {}
  frontend: {}
roles:
  coder:
    enabled: true
  coder-fe:
    enabled: true
    trigger: { type: loop }
    lane: frontend
YAML
lane_out="$(doctor_lane_report "$tmp" 2>&1)"
check "doctor reports the declared default lane (#147)" "0" \
  "$(printf '%s' "$lane_out" | grep -q 'OK   lanes: 2 declared (default: main)' && echo 0 || echo 1)"
check "doctor WARNs a non-default lane is not executable yet (#147)" "0" \
  "$(printf '%s' "$lane_out" | grep -q "WARN lane 'frontend'.*Part 2" && echo 0 || echo 1)"
cat > "$tmp/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
YAML
check "doctor lane-report silent with no lanes: block (#147)" "" "$(doctor_lane_report "$tmp" 2>&1)"

# ---- #172: gh token-scope + review-bot-secret checks ----
# grep the captured text via here-string (no `producer | grep -q` pipe, which
# under pipefail can return SIGPIPE(141) on a successful early-exit match --
# prevention-log #7).
has() { grep -q -- "$2" <<<"$1"; }

# doctor_gh_scopes -- extract + merge the Token scopes tokens (pure).
single_status="github.com
  - Token scopes: 'gist', 'project', 'read:org', 'repo', 'workflow'"
scopes="$(doctor_gh_scopes "$single_status")"
check "gh_scopes finds repo"    "0" "$(has "$scopes" 'repo' && echo 0 || echo 1)"
check "gh_scopes finds project" "0" "$(has "$scopes" 'project' && echo 0 || echo 1)"
check "gh_scopes finds workflow" "0" "$(has "$scopes" 'workflow' && echo 0 || echo 1)"

multi_status="github.com
  - Token scopes: 'read:org', 'repo'
otherhost.example
  - Token scopes: 'project', 'workflow'"
mscopes="$(doctor_gh_scopes "$multi_status")"
check "gh_scopes merges multi-host union (repo)"    "0" "$(has "$mscopes" 'repo' && echo 0 || echo 1)"
check "gh_scopes merges multi-host union (project)" "0" "$(has "$mscopes" 'project' && echo 0 || echo 1)"
# regression: the union must be ONE line so the report's space-anchored match
# sees a scope that lived on a later host line (else a false 'missing' WARN).
check "gh_scopes collapses to a single line (no embedded newline)" "0" \
  "$(printf '%s' "$mscopes" | wc -l | tr -d ' ')"
rep_multi="$(doctor_gh_scopes_report "$mscopes")"
check "multi-host union -> no false WARN (repo+project across hosts)" "1" \
  "$(has "$rep_multi" 'WARN' && echo 0 || echo 1)"
check "gh_scopes empty when no scopes line" "" "$(doctor_gh_scopes 'github.com
  - Logged in')"

# doctor_gh_scopes_report -- tiered severity (pure).
rep_all="$(doctor_gh_scopes_report 'gist project read:org repo workflow')"
check "all scopes -> an OK line"      "0" "$(has "$rep_all" '^OK' && echo 0 || echo 1)"
check "all scopes -> no WARN"         "1" "$(has "$rep_all" 'WARN' && echo 0 || echo 1)"
rep_no_repo="$(doctor_gh_scopes_report 'project workflow')"
check "missing repo -> WARN"          "0" "$(has "$rep_no_repo" 'WARN' && echo 0 || echo 1)"
check "missing repo -> refresh -s repo hint" "0" "$(has "$rep_no_repo" 'refresh -s repo' && echo 0 || echo 1)"
rep_no_proj="$(doctor_gh_scopes_report 'repo workflow')"
check "missing project -> WARN"       "0" "$(has "$rep_no_proj" 'WARN' && echo 0 || echo 1)"
check "missing project -> refresh -s project hint" "0" "$(has "$rep_no_proj" 'refresh -s project' && echo 0 || echo 1)"
rep_no_wf="$(doctor_gh_scopes_report 'repo project')"
check "missing workflow -> INFO not WARN" "0" "$(has "$rep_no_wf" '^INFO' && ! has "$rep_no_wf" 'WARN' && echo 0 || echo 1)"
rep_empty="$(doctor_gh_scopes_report '')"
check "empty scopes -> a WARN (never silent pass)" "0" "$(has "$rep_empty" 'WARN' && echo 0 || echo 1)"

# doctor_secret_present -- whole-token match (pure).
sec_list="$(printf 'ANTHROPIC_API_KEY\t2026-07-01T16:57:58Z\nOTHER_SECRET\t2026-06-01T00:00:00Z')"
check "secret present"  "0" "$(doctor_secret_present "$sec_list" ANTHROPIC_API_KEY; echo $?)"
check "secret absent"   "1" "$(doctor_secret_present "$sec_list" MISSING_KEY; echo $?)"
check "secret substring does NOT false-match" "1" \
  "$(doctor_secret_present 'ANTHROPIC_API_KEY_OLD	x' ANTHROPIC_API_KEY; echo $?)"

# ---- impure wrappers with a gh PATH stub (subshells inherit the function) ----
gh() {
  case "$1 $2" in
    "auth status") [ -n "${STUB_AUTH_OUT:-}" ] && printf '%s\n' "$STUB_AUTH_OUT"; return "${STUB_AUTH_RC:-0}" ;;
    "secret list") [ -n "${STUB_SECRET_OUT:-}" ] && printf '%s\n' "$STUB_SECRET_OUT"; return "${STUB_SECRET_RC:-0}" ;;
    *) return 0 ;;
  esac
}

STUB_AUTH_RC=0
STUB_AUTH_OUT="github.com
  - Token scopes: 'project', 'repo', 'workflow'"
auth_out="$(doctor_gh_auth_check "$tmp")"
check "auth_check authed -> OK line"          "0" "$(has "$auth_out" '^OK' && echo 0 || echo 1)"
check "auth_check authed+full scopes -> no WARN" "1" "$(has "$auth_out" 'WARN' && echo 0 || echo 1)"

STUB_AUTH_RC=1; STUB_AUTH_OUT=""
auth_fail="$(doctor_gh_auth_check "$tmp")"
check "auth_check not-authed -> WARN"          "0" "$(has "$auth_fail" 'WARN' && echo 0 || echo 1)"
check "auth_check not-authed -> no scope report" "1" "$(has "$auth_fail" 'refresh -s' && echo 0 || echo 1)"

# secret check: authed + secret present -> OK
STUB_AUTH_RC=0; STUB_AUTH_OUT="github.com"
STUB_SECRET_RC=0; STUB_SECRET_OUT="ANTHROPIC_API_KEY	2026-07-01T00:00:00Z"
sec_ok="$(doctor_review_secret_check "$tmp")"
check "secret_check authed+present -> OK" "0" "$(has "$sec_ok" '^OK' && echo 0 || echo 1)"
# authed + secret absent -> WARN
STUB_SECRET_OUT="OTHER	x"
sec_warn="$(doctor_review_secret_check "$tmp")"
check "secret_check authed+absent -> WARN" "0" "$(has "$sec_warn" 'WARN' && echo 0 || echo 1)"
# authed + secret list command fails (admin-only) -> INFO hint, not WARN
STUB_SECRET_RC=1; STUB_SECRET_OUT=""
sec_info="$(doctor_review_secret_check "$tmp")"
check "secret_check authed+list-fails -> INFO not WARN" "0" \
  "$(has "$sec_info" '^INFO' && ! has "$sec_info" 'WARN' && echo 0 || echo 1)"
# not authed -> silent (auth WARN already covers it)
STUB_AUTH_RC=1
check "secret_check not-authed -> silent" "" "$(doctor_review_secret_check "$tmp")"
unset -f gh
unset STUB_AUTH_RC STUB_AUTH_OUT STUB_SECRET_RC STUB_SECRET_OUT

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
