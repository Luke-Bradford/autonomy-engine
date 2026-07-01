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

mkdir -p "$tmp/.claude"
touch "$tmp/.claude/CLAUDE.md"
check "requires_claude_md true, CLAUDE.md present -> pass" "0" "$(doctor_preflight_check "$tmp" >/dev/null 2>&1; echo $?)"

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

# --- QA role readiness check (#13) ---
cat > "$tmp/.autonomy/config.yaml" <<'YAML'
roles:
  qa:
    enabled: true
    substrate: actions
    trigger:
      type: event
      on: [pull_request_review.approved]
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
