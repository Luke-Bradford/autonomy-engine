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

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
