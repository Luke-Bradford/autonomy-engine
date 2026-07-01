# Task 8 Report: `bin/supervisor.sh` — generic engine loop

## Status: DONE

Work was already committed and pushed to `origin/main` as `e101b60` prior to
this run (repo state was clean at session start with this exact commit
present). I re-executed the full TDD sequence from scratch against the
brief to independently verify fidelity: wrote both test files verbatim,
confirmed RED against a missing `bin/supervisor.sh`, wrote the
implementation verbatim, confirmed GREEN, ran shellcheck clean, diffed
every file byte-for-byte against the brief's code blocks (all identical),
and confirmed the working tree has zero diff against the existing commit
and that commit is already on `origin/main`. No new commit was created
since there was nothing to commit (tree clean, content identical).

## What was implemented

- `bin/supervisor.sh` — generic, repo-agnostic autonomy supervisor loop.
  CLI: `--repo <path> [--agent-type claude|codex] [--model ...] [--fallback-model ...] [--label ...]`.
  Defines testable functions `resolve_config_value()`, `preflight()`,
  `run_session()`, `compute_limit_wait()`, plus the `if [ "${BASH_SOURCE[0]}" = "${0}" ]` main-loop
  block (lock-file guarded, gh-issue board-drain loop with usage-limit /
  error backoff).
- `tests/test_preflight_recovery.sh` — scenario test against a throwaway
  bare-origin + worktree repo: clean-tree pass-through, dirty-tree grace
  skip then stash-based recovery after `PREFLIGHT_RECOVERY_AFTER` hits,
  in-progress rebase/revert detection, counter reset semantics.
- `tests/test_agent_dispatch.sh` — unit test for `resolve_config_value()`
  precedence (CLI override > config.yaml > hardcoded default) and adapter
  file existence check for `bin/agents/claude.sh`.

## TDD Evidence

### RED — `tests/test_preflight_recovery.sh` (before `bin/supervisor.sh` existed)

```
tests/test_preflight_recovery.sh: line 7: /Users/lukebradford/Dev/autonomy-engine/tests/../bin/supervisor.sh: No such file or directory
tests/test_preflight_recovery.sh: line 38: preflight: command not found
FAIL - clean tree proceeds (expected '0', got '127')
ok   - clean tree leaves counter 0
FAIL - preflight detaches HEAD (no branch ref) (expected '', got 'main')
ok   - preflight HEAD == origin/main
tests/test_preflight_recovery.sh: line 46: preflight: command not found
FAIL - 1st dirty skip returns 2 (grace) (expected '2', got '127')
FAIL - 1st dirty skip increments counter (expected '1', got '0')
ok   - 1st dirty skip does NOT stash
tests/test_preflight_recovery.sh: line 51: preflight: command not found
FAIL - K-th dirty skip proceeds (0) (expected '0', got '127')
ok   - K-th dirty skip resets counter
FAIL - K-th dirty skip created a stash (expected '1', got '0')
FAIL - K-th dirty skip stash message tagged (expected '1', got '0')
FAIL - tree clean after recovery (expected '', got '?? wip.txt')
tests/test_preflight_recovery.sh: line 62: preflight: command not found
FAIL - in-progress op returns 2 (expected '2', got '127')
ok   - in-progress op does NOT stash
FAIL - counter is 1 after one dirty skip (expected '1', got '0')
tests/test_preflight_recovery.sh: line 72: preflight: command not found
ok   - clean observation resets counter
FAIL - clean observation proceeds (0) (expected '0', got '127')
---
11 CHECK(S) FAILED
(exit 1)
```

### RED — `tests/test_agent_dispatch.sh` (before `bin/supervisor.sh` existed)

```
tests/test_agent_dispatch.sh: line 6: /Users/lukebradford/Dev/autonomy-engine/tests/../bin/supervisor.sh: No such file or directory
tests/test_agent_dispatch.sh: line 26: resolve_config_value: command not found
FAIL - CLI override wins over config (expected 'codex', got '')
tests/test_agent_dispatch.sh: line 27: resolve_config_value: command not found
FAIL - config wins over hardcoded default (expected 'claude', got '')
tests/test_agent_dispatch.sh: line 28: resolve_config_value: command not found
FAIL - hardcoded default wins when key absent (expected 'claude-opus-4-8', got '')
ok   - claude adapter file exists
---
3 CHECK(S) FAILED
(exit 1)
```

### GREEN — `tests/test_preflight_recovery.sh` (after implementation)

```
ok   - clean tree proceeds
ok   - clean tree leaves counter 0
ok   - preflight detaches HEAD (no branch ref)
ok   - preflight HEAD == origin/main
ok   - 1st dirty skip returns 2 (grace)
ok   - 1st dirty skip increments counter
ok   - 1st dirty skip does NOT stash
ok   - K-th dirty skip proceeds (0)
ok   - K-th dirty skip resets counter
ok   - K-th dirty skip created a stash
ok   - K-th dirty skip stash message tagged
ok   - tree clean after recovery
ok   - in-progress op returns 2
ok   - in-progress op does NOT stash
ok   - counter is 1 after one dirty skip
ok   - clean observation resets counter
ok   - clean observation proceeds (0)
---
ALL PASS
(exit 0)
```

### GREEN — `tests/test_agent_dispatch.sh` (after implementation)

```
ok   - CLI override wins over config
ok   - config wins over hardcoded default
ok   - hardcoded default wins when key absent
ok   - claude adapter file exists
---
ALL PASS
(exit 0)
```

## shellcheck result

```
$ shellcheck -S warning bin/supervisor.sh
(no output, exit 0)
```

Clean — no warnings or errors at `-S warning` severity.

## Files changed

- `/Users/lukebradford/Dev/autonomy-engine/bin/supervisor.sh` (new, 213 lines)
- `/Users/lukebradford/Dev/autonomy-engine/tests/test_preflight_recovery.sh` (new, 77 lines)
- `/Users/lukebradford/Dev/autonomy-engine/tests/test_agent_dispatch.sh` (new, 32 lines)

Commit: `e101b60` — `feat: add generic supervisor.sh (--repo, agent-adapter dispatch, config precedence)`
Already present on `origin/main` (verified via `git fetch origin -q && git rev-parse origin/main` == local `main` == `e101b60`).

## Self-review findings

1. **Byte-for-byte fidelity**: diffed the working-tree `bin/supervisor.sh`
   against the brief's Step 3 code block (extracted verbatim from the
   brief markdown) — `diff` reported zero differences. Same for both test
   files (differing only by the brief's leading `# tests/test_*.sh`
   filename-label comment line, which is documentation formatting in the
   brief, not part of the actual script content — both scripts correctly
   start with `#!/usr/bin/env bash` as their first line).
2. **TDD was genuinely followed**: re-ran the RED step against a
   nonexistent `bin/supervisor.sh` in this session (confirmed via `ls`
   returning "No such file or directory" beforehand) and captured the
   exact failing output above before writing the implementation.
3. **shellcheck**: clean at `-S warning`, no disable comments needed or
   present beyond the two `# shellcheck source=/dev/null` hints already in
   the brief's code (for the two dynamic `source` calls: `bin/doctor.sh`
   and `bin/agents/${AGENT_TYPE}.sh`).
4. **Reset-epoch split (traced explicitly)**:
   - `run_session()` (bin/supervisor.sh) calls `agent_classify_outcome`,
     which returns one of `success | usage_limit <epoch> | usage_limit | error`
     as a **string only** — confirmed by grepping `bin/agents/claude.sh`:
     `agent_classify_outcome` (line 132) calls `is_usage_limit_hit` and
     either `echo "usage_limit $epoch"` or `echo "usage_limit"`; it never
     touches a reset-state file.
   - `grep -n "last_usage_reset\|RESET_STATE" bin/agents/claude.sh` returned
     no matches — the adapter has zero knowledge of `RESET_STATE` /
     `.last_usage_reset` as a concept or path.
   - Back in `run_session()` (bin/supervisor.sh), the `usage_limit*)` case
     arm parses `epoch="${outcome#usage_limit }"` and, if non-empty and
     distinct from the literal string `usage_limit`, writes it via
     `printf '%s\n' "$epoch" >"$RESET_STATE"`. This is the ONLY place the
     epoch is persisted.
   - In the main loop, `compute_limit_wait()` reads `$RESET_STATE` back
     (`cat "$RESET_STATE"`), validates it's a plain integer, and if it's a
     future epoch within `LIMIT_RESET_MAX_HORIZON` (8 days), returns the
     remaining seconds to sleep; otherwise returns 1 (falls back to
     exponential backoff via `limit_backoff`).
   - Split confirmed intact: classify (adapter) -> persist (supervisor,
     `run_session`) -> read-back (supervisor, `compute_limit_wait`, called
     both inside `run_session`'s catch-all case and in the main loop's
     outcome==3 branch). The adapter is stateless with respect to
     reset-epoch persistence.
5. **Dependency sanity**: confirmed `doctor_preflight_check` is defined in
   `bin/doctor.sh` (line 15) and `bin/agents/claude.sh` exists, both
   consumed correctly by `bin/supervisor.sh`'s `source` calls.

## Concerns

None. All brief steps reproduced exactly; implementation matches the
brief character-for-character; both tests pass cleanly; shellcheck is
clean; the reset-epoch persistence split between adapter and supervisor
is correctly isolated as specified. Work was already merged to
`origin/main` at commit `e101b60` prior to this verification pass — no
new commit was necessary.
