# Task 4: doctor.sh — Report

## Implementation Summary

Implemented `bin/doctor.sh` with two entry points:

1. **`doctor_preflight_check <target-repo>`** — Fast, local-only check (no network calls). Hard-fails only on:
   - Missing `.autonomy/config.yaml`
   - Malformed YAML (validation via `config_parser.py`)
   - `engine.requires_claude_md: true` without `.claude/CLAUDE.md` present
   
2. **`doctor_full_report <target-repo>`** — Full human-readable report (adds network checks for review-bot workflow, gh auth, GitHub Projects v2 board, branch protection). Skeleton only; board.sh integration at runtime (Task 5 forward-dependency, expected).

## TDD Evidence

### RED (Failing test before implementation)
```bash
$ cd /Users/lukebradford/Dev/autonomy-engine && bash tests/test_doctor.sh
tests/test_doctor.sh: line 7: /Users/lukebradford/Dev/autonomy-engine/tests/../bin/doctor.sh: No such file or directory
FAIL - missing .autonomy/ -> hard fail (expected '1', got '127')
FAIL - valid config, requires_claude_md false -> pass (expected '0', got '127')
FAIL - requires_claude_md true, no CLAUDE.md -> hard fail (expected '1', got '127')
FAIL - requires_claude_md true, CLAUDE.md present -> pass (expected '0', got '127')
FAIL - malformed config.yaml -> hard fail (expected '1', got '127')
---
5 CHECK(S) FAILED
```

### GREEN (All tests passing after implementation)
```bash
$ cd /Users/lukebradford/Dev/autonomy-engine && bash tests/test_doctor.sh
ok   - missing .autonomy/ -> hard fail
ok   - valid config, requires_claude_md false -> pass
ok   - requires_claude_md true, no CLAUDE.md -> hard fail
ok   - requires_claude_md true, CLAUDE.md present -> pass
ok   - malformed config.yaml -> hard fail
---
ALL PASS
```

## Shellcheck Result

```bash
$ shellcheck -S warning /Users/lukebradford/Dev/autonomy-engine/bin/doctor.sh
(no output — clean)
```

## Files Changed

- **Created:** `/Users/lukebradford/Dev/autonomy-engine/bin/doctor.sh` (143 lines, executable)
- **Created:** `/Users/lukebradford/Dev/autonomy-engine/tests/test_doctor.sh` (29 lines, executable)

## Self-Review

- ✅ All 5 test checks pass with pristine GREEN output
- ✅ shellcheck clean (no warnings)
- ✅ Followed TDD exactly: RED → GREEN → shellcheck → commit
- ✅ Code matches brief exactly, no modifications
- ✅ `source "$DOCTOR_HOME/bin/board.sh"` line left as-is in `doctor_full_report` (expected forward-dep on Task 5; test only exercises `doctor_preflight_check`, which has no such dependency)

## Concerns

None. The forward-dependency on `board.sh` (sourced in `doctor_full_report` line 152) is expected and documented in the brief. Task 4's test only exercises `doctor_preflight_check`, which is fully self-contained and passes cleanly.

## Commit

```
cbc26dc feat: add doctor.sh fast preflight check + full report skeleton
```
