# Task 11 Report: `onboard.sh` + autonomy-pack templates

## Summary
Task 11 complete. Implemented TDD: test written and verified RED, then implementation and templates written, test verified GREEN, shellcheck clean, all files committed and pushed.

## TDD Workflow

### RED (Test Fails)
Test `tests/test_onboard.sh` written and run before implementation:
```
FAIL - config.yaml scaffolded (expected '0', got '1')
FAIL - loop_prompt.md scaffolded (expected '0', got '1')
FAIL - hard_rules.md scaffolded (expected '0', got '1')
FAIL - idempotent -- does not clobber an existing file (expected 'MY CUSTOM EDIT', got '')
---
4 CHECK(S) FAILED
```

Root cause: `bin/onboard.sh` did not exist yet; template files not created.

### Implementation

1. **bin/onboard.sh** (899 bytes, +x)
   - Scaffolds `.autonomy/` idempotently from `templates/autonomy-pack/`
   - Never overwrites existing files (checks `-f $dest` before copying)
   - Reports copy count and skip count
   - macOS /bin/bash 3.2.57 compatible (no mapfile, globstar, or `**`)

2. **templates/autonomy-pack/config.yaml** (1,022 bytes)
   - YAML per-repo policy template for autonomy engine
   - Includes board config (owner, project_title), engine config (label, requires_claude_md), agent config (type, models), merge_gate strategy, worktree default_path
   - All values match brief exactly

3. **templates/autonomy-pack/hard_rules.md** (460 bytes)
   - Markdown safety rules template
   - Three core rules: no `--no-verify`, merge only via `safe_merge.sh`, follow CLAUDE.md and loop_prompt.md
   - Includes comment block for repo-specific customization

4. **templates/autonomy-pack/loop_prompt.md** (1,160 bytes)
   - Markdown standing task for unattended board drainage
   - Four-step iteration: triage, execute workflow, update board, next ticket
   - Includes comment block for repo-specific triage and QA rules

### GREEN (Test Passes)
After implementation:
```
ok   - config.yaml scaffolded
ok   - loop_prompt.md scaffolded
ok   - hard_rules.md scaffolded
ok   - idempotent -- does not clobber an existing file
---
ALL PASS
```

All four checks pass, including the idempotency check (custom edit survives re-run).

### Shellcheck
```bash
shellcheck -S warning bin/onboard.sh
```
Output: (empty — clean, no warnings)

## Files Changed

- Created: `/Users/lukebradford/Dev/autonomy-engine/bin/onboard.sh` (899 B, executable)
- Created: `/Users/lukebradford/Dev/autonomy-engine/templates/autonomy-pack/config.yaml` (1,022 B)
- Created: `/Users/lukebradford/Dev/autonomy-engine/templates/autonomy-pack/hard_rules.md` (460 B)
- Created: `/Users/lukebradford/Dev/autonomy-engine/templates/autonomy-pack/loop_prompt.md` (1,160 B)
- Created: `/Users/lukebradford/Dev/autonomy-engine/tests/test_onboard.sh` (1,050 B, executable)

## Commit

```
5704323 feat: add onboard.sh + autonomy-pack templates
```

Changes committed to autonomy-engine main branch and pushed to remote.

## Self-Review Checklist

- [x] Test written and run to RED before implementation
- [x] Test now passes (4/4 checks: 3 file-presence, 1 idempotency)
- [x] All three templates created with exact brief content
- [x] bin/onboard.sh matches brief code exactly (no additions)
- [x] bin/onboard.sh executable, macOS /bin/bash 3.2.57 compatible
- [x] Idempotency verified: custom config.yaml not clobbered on re-run
- [x] shellcheck -S warning passes (clean output)
- [x] TDD discipline followed: RED → GREEN → clean
- [x] All files committed and pushed

## Concerns

None. Implementation complete, tests pass, code clean, idempotency verified.
