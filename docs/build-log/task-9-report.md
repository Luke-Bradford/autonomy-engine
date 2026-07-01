# Task 9 report: setup_worktree.sh + launchd plist template

## Status: DONE

## Files changed (in ~/Dev/autonomy-engine)
- `bin/setup_worktree.sh` (new, executable) — transcribed verbatim from brief Step 3.
- `templates/supervisor.plist.tmpl` (new) — transcribed verbatim from brief Step 4.
- `tests/test_setup_worktree_slug.sh` (new, executable) — transcribed verbatim from brief Step 1.

## TDD evidence

### RED (before bin/setup_worktree.sh existed)
```
tests/test_setup_worktree_slug.sh: line 9: /Users/lukebradford/Dev/autonomy-engine/tests/../bin/setup_worktree.sh: No such file or directory
tests/test_setup_worktree_slug.sh: line 25: derive_slug: command not found
FAIL - basename-derived slug, mixed case collapsed (expected 'ebull', got '')
tests/test_setup_worktree_slug.sh: line 33: derive_slug: command not found
FAIL - non-alphanumeric collapsed to single dashes (expected 'my-weird-repo', got '')
tests/test_setup_worktree_slug.sh: line 41: derive_slug: command not found
FAIL - engine.label overrides basename (expected 'custom-label', got '')
---
3 CHECK(S) FAILED
EXIT: 1
```

### GREEN (after implementation)
```
ok   - basename-derived slug, mixed case collapsed
ok   - non-alphanumeric collapsed to single dashes
ok   - engine.label overrides basename
---
ALL PASS
EXIT: 0
```

## shellcheck
```
shellcheck -S warning bin/setup_worktree.sh
```
Exit 0, no output. Clean.

## Commit
- `f08b125` — "feat: add generic setup_worktree.sh (label override + collision guard) and plist template"
- Pushed to `origin/main` (`e101b60..f08b125`).

## Self-review
- Test passes 3/3, pristine `ALL PASS` output. Confirmed.
- shellcheck `-S warning` clean (exit 0, no output). Confirmed.
- TDD followed: test written and run FIRST, failed for the expected reason (missing script /
  undefined function), captured as RED evidence above; implementation written second; test re-run,
  GREEN evidence above.
- Code is an exact transcription of the brief's Step 1/3/4 blocks (no rewrites, no "improvements").
- `derive_slug()` is defined unconditionally at the top of `bin/setup_worktree.sh`, ABOVE the
  `[ "${BASH_SOURCE[0]}" = "${0}" ] || return 0` guard — confirmed empirically: the test sources the
  file and calls `derive_slug` successfully without triggering any of the guarded executable body
  (no worktree/git operations ran during the test).
- Bash 3.2.57 compatible: verified local `/bin/bash --version` is exactly 3.2.57(1)-release; script
  uses no mapfile, no globstar, no `**`; only POSIX/bash-3-safe constructs (`local`, `printf '%s'`,
  parameter expansion, `case`, `[ ]` tests, command substitution).
- Did not touch `~/Dev/eBull` at any point.

## Concerns
None. Brief's code worked as specified; no rewrites needed.
