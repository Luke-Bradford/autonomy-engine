### Task 4: `doctor.sh` — fast preflight check + full readiness report

**Files:**
- Create: `bin/doctor.sh`
- Test: `tests/test_doctor.sh`

**Interfaces:**
- Consumes: `python3 lib/config_parser.py` (Task 2); `board_resolve_project` from `bin/board.sh`
  (Task 5) — **this creates a forward dependency**: `doctor_full_report` sources `bin/board.sh`, so
  Task 4's full-report code path isn't exercised until Task 5 exists. `doctor_preflight_check` (used
  by Task 8's `supervisor.sh` and tested here) has no such dependency and is fully testable now.
- Produces: `doctor_preflight_check(target_repo) -> exit 0/1` (fast, local-only: `.autonomy/`
  present + parses, `.claude/CLAUDE.md` present if `engine.requires_claude_md: true`).
  `doctor_full_report(target_repo) -> exit 0/1`, prints a human-readable checklist (adds the
  network-calling checks — implemented fully once Task 5 lands `board_resolve_project`, but the
  function skeleton with its non-board checks is written now).

- [ ] **Step 1: Write the failing test (for `doctor_preflight_check` only — the fast, dependency-free half)**

```bash
# tests/test_doctor.sh
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

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
```

- [ ] **Step 2: Run to verify it fails**

```bash
chmod +x tests/test_doctor.sh
bash tests/test_doctor.sh
```
Expected: fails (`bin/doctor.sh` doesn't exist yet).

- [ ] **Step 3: Implement `bin/doctor.sh`**

```bash
#!/usr/bin/env bash
# bin/doctor.sh -- diagnostic readiness check for a target repo. Two entry
# points:
#   doctor_preflight_check <target-repo>  -- fast, local-only, called by
#     supervisor.sh on every loop iteration. Hard-fails only on what would
#     actually break the loop.
#   doctor_full_report <target-repo>      -- the full report (adds network
#     calls: gh auth scopes, review-bot workflow, GH Projects v2 board,
#     branch protection). Diagnostic/read-only -- never provisions anything.
#
# Run standalone:  bin/doctor.sh <target-repo>
set -uo pipefail
DOCTOR_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

doctor_preflight_check() {
  local repo="$1"
  if [ ! -f "$repo/.autonomy/config.yaml" ]; then
    echo "doctor: FAIL -- $repo/.autonomy/config.yaml not found" >&2
    return 1
  fi
  if ! python3 "$DOCTOR_HOME/lib/config_parser.py" "$repo/.autonomy/config.yaml" __validate__ >/dev/null 2>&1; then
    echo "doctor: FAIL -- $repo/.autonomy/config.yaml does not parse" >&2
    return 1
  fi
  local requires_md
  requires_md="$(python3 "$DOCTOR_HOME/lib/config_parser.py" "$repo/.autonomy/config.yaml" engine.requires_claude_md 2>/dev/null || echo false)"
  if [ "$requires_md" = "true" ] && [ ! -f "$repo/.claude/CLAUDE.md" ]; then
    echo "doctor: FAIL -- engine.requires_claude_md is true but $repo/.claude/CLAUDE.md is missing" >&2
    return 1
  fi
  return 0
}

doctor_full_report() {
  local repo="$1" hard_fail=0
  echo "== doctor.sh report: $repo =="

  if doctor_preflight_check "$repo" 2>/tmp/doctor_preflight_err.$$; then
    echo "OK   .autonomy/ present, config.yaml valid"
  else
    cat /tmp/doctor_preflight_err.$$
    hard_fail=1
  fi
  rm -f /tmp/doctor_preflight_err.$$

  if [ -f "$repo/.claude/CLAUDE.md" ]; then
    echo "OK   .claude/CLAUDE.md present"
  else
    local requires_md
    requires_md="$(python3 "$DOCTOR_HOME/lib/config_parser.py" "$repo/.autonomy/config.yaml" engine.requires_claude_md 2>/dev/null || echo false)"
    if [ "$requires_md" != "true" ]; then
      echo "WARN .claude/CLAUDE.md not found -- run /init in Claude Code, or use the claude-md-management:claude-md-improver skill"
    fi
  fi

  local strategy
  strategy="$(python3 "$DOCTOR_HOME/lib/config_parser.py" "$repo/.autonomy/config.yaml" merge_gate.strategy 2>/dev/null || echo manual)"
  strategy="${strategy:-manual}"
  if [ "$strategy" = "bot_comment" ]; then
    if [ -d "$repo/.github/workflows" ] && grep -rlE 'anthropic\.com/v1/messages|ANTHROPIC_API_KEY' "$repo/.github/workflows" >/dev/null 2>&1; then
      echo "OK   review-bot workflow found under .github/workflows (merge_gate.strategy=bot_comment)"
    else
      echo "WARN no review-bot workflow found under .github/workflows -- merge_gate.strategy=bot_comment will never see an APPROVE and every PR will stall. Add a workflow, or switch to manual/ci_only."
    fi
  fi

  if (cd "$repo" && gh auth status >/dev/null 2>&1); then
    echo "OK   gh auth status ok"
  else
    echo "WARN gh auth status failed -- run 'gh auth login' (need repo + project scopes)"
  fi

  local owner project_title
  owner="$(python3 "$DOCTOR_HOME/lib/config_parser.py" "$repo/.autonomy/config.yaml" board.owner 2>/dev/null || echo)"
  project_title="$(python3 "$DOCTOR_HOME/lib/config_parser.py" "$repo/.autonomy/config.yaml" board.project_title 2>/dev/null || echo)"
  if [ -n "$owner" ] && [ -n "$project_title" ]; then
    # shellcheck source=/dev/null
    source "$DOCTOR_HOME/bin/board.sh"
    ids="$(board_resolve_project "$owner" "$project_title")"
    read -r pid _ _ <<<"$ids"
    if [ -n "$pid" ]; then
      echo "OK   board '$project_title' found under '$owner'"
    else
      echo "WARN GitHub Projects v2 board '$project_title' not found under '$owner' -- board.sh will silently skip status updates"
    fi
  else
    echo "WARN board.owner/board.project_title not set in config.yaml -- board status updates will be skipped"
  fi

  if (cd "$repo" && gh api "repos/{owner}/{repo}/branches/main/protection" >/dev/null 2>&1); then
    echo "OK   branch protection configured on main"
  else
    echo "WARN no branch protection detected on main -- safe_merge.sh is the *local* gate only; consider adding required status checks"
  fi

  return "$hard_fail"
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  TARGET="${1:?usage: doctor.sh <target-repo>}"
  doctor_full_report "$(cd "$TARGET" && pwd)"
  exit $?
fi
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bash tests/test_doctor.sh
```
Expected: `ALL PASS`.

- [ ] **Step 5: shellcheck**

```bash
shellcheck -S warning bin/doctor.sh
```
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add bin/doctor.sh tests/test_doctor.sh
git commit -m "feat: add doctor.sh fast preflight check + full report skeleton"
git push
```

**Note for Task 5:** `doctor_full_report`'s board check (`source bin/board.sh`) will fail with "No
such file" until Task 5 lands. This is fine — Task 4's test only exercises `doctor_preflight_check`,
which has no such dependency. Task 5 makes `doctor_full_report` fully runnable.

---

