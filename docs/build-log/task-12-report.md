# Task 12 report: README + full test-suite run + final lint pass

## Summary

- Wrote `tests/run_all.sh` (repo: `~/Dev/autonomy-engine`), transcribed from brief Step 1,
  with one deviation: `cd "$HERE/.."` → `cd "$HERE/.." || exit 1` to satisfy shellcheck
  SC2164 under `-S warning` (this file is Task 12's own deliverable, not another task's
  committed code, so fixing it is in-scope — see "Deviations" below).
- Wrote the full `README.md`, transcribed verbatim from brief Step 3 (pack contract, config
  schema, merge-gate strategy table, `bin/` reference, agent-adapter section, testing section).
- Ran `bash tests/run_all.sh` twice (before and after writing the README) — both runs: all
  9 bash test suites + the python `test_config_parser` unittest pass, final line
  `ALL SUITES PASS`.
- Ran `shellcheck -S warning bin/*.sh bin/agents/*.sh tests/*.sh` — `bin/*.sh`,
  `bin/agents/*.sh`, and the new `tests/run_all.sh` are all clean. Five pre-existing warnings
  remain in three OTHER tasks' already-committed test files (see "Concerns" below) — not
  touched, per instructions not to silently rewrite another task's committed code.
- Committed `README.md` + `tests/run_all.sh` only, pushed to `origin/main`.

## Step 2 output: `bash tests/run_all.sh` (first run, before README)

```
=== tests/test_agent_dispatch.sh ===
ok   - CLI override wins over config
ok   - config wins over hardcoded default
ok   - hardcoded default wins when key absent
ok   - claude adapter file exists
---
ALL PASS
=== tests/test_board_resolve.sh ===
ok   - user-owned project found directly
ok   - falls back to organization when user has no match
ok   - neither user nor org match -> empty
---
ALL PASS
=== tests/test_doctor.sh ===
ok   - missing .autonomy/ -> hard fail
ok   - valid config, requires_claude_md false -> pass
ok   - requires_claude_md true, no CLAUDE.md -> hard fail
ok   - requires_claude_md true, CLAUDE.md present -> pass
ok   - malformed config.yaml -> hard fail
---
ALL PASS
=== tests/test_merge_gate_strategies.sh ===
ok   - all green -> ci_check passes
ok   - a failing check -> refuse
ok   - a pending check -> refuse
ok   - zero checks, ci_only -> refuse
ok   - zero checks, bot_comment -> pass (approval is the real gate)
ok   - gh call itself fails -> refuse, not silently green
---
ALL PASS
=== tests/test_onboard.sh ===
ok   - config.yaml scaffolded
ok   - loop_prompt.md scaffolded
ok   - hard_rules.md scaffolded
ok   - idempotent -- does not clobber an existing file
---
ALL PASS
=== tests/test_preflight_recovery.sh ===
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
=== tests/test_safe_merge_doc_only.sh ===
ok   - single .md
ok   - multiple .md
ok   - nested .md paths
ok   - one code file among md disqualifies
ok   - code file alone
ok   - favicon PR (svg + html)
ok   - empty diff
ok   - .md as a directory, not extension
ok   - non-md extension that contains md
ok   - .rst not in configured list
ok   - .rst IS in configured list
---
ALL PASS
=== tests/test_setup_worktree_slug.sh ===
ok   - basename-derived slug, mixed case collapsed
ok   - non-alphanumeric collapsed to single dashes
ok   - engine.label overrides basename
---
ALL PASS
=== tests/test_unblock_dependents.sh ===
ok   - plain blocked by
... (23 sub-checks, all ok)
ALL PASS
=== tests/test_usage_limit_reset.sh ===
ok   - ISO-8601 'resetsAt' -> epoch
... (12 sub-checks, all ok)
ALL PASS
=== python: test_config_parser ===
Ran 9 tests in 0.104s
OK
ALL SUITES PASS
```

9 bash test files (`test_*.sh`) + 1 python unittest module = **10 suites, all green**.

## Step 4 output: `bash tests/run_all.sh` (second run, after README written)

Tail of output (identical result, confirms README change did not regress anything):

```
----------------------------------------------------------------------
Ran 9 tests in 0.104s

OK
ALL SUITES PASS
```

Re-ran a third time after the `tests/run_all.sh` shellcheck fix (`cd ... || exit 1`) — same
result, `ALL SUITES PASS`.

## Step 5 output: final shellcheck pass

Command: `shellcheck -S warning bin/*.sh bin/agents/*.sh tests/*.sh`

`bin/*.sh`, `bin/agents/*.sh`, and `tests/run_all.sh` (this task's new file): **clean, no
output.**

Pre-existing warnings found in three files from EARLIER tasks (Task 10/11 commits
`f08b125`, `e101b60` — before this task started), left untouched:

```
In tests/test_agent_dispatch.sh line 7:
SUPLOG=/dev/null
^----^ SC2034 (warning): SUPLOG appears unused. Verify use (or export if used externally).

In tests/test_preflight_recovery.sh line 8:
SUPLOG=/dev/null
^----^ SC2034 (warning): SUPLOG appears unused. Verify use (or export if used externally).

In tests/test_preflight_recovery.sh line 34:
AUTONOMY_TARGET_REPO="$work"
^------------------^ SC2034 (warning): AUTONOMY_TARGET_REPO appears unused. Verify use (or export if used externally).

In tests/test_preflight_recovery.sh line 35:
RESET_STATE="$tmp/.last_usage_reset"
^---------^ SC2034 (warning): RESET_STATE appears unused. Verify use (or export if used externally).

In tests/test_setup_worktree_slug.sh line 2:
#!/usr/bin/env bash
^-- SC1128 (error): The shebang must be on the first line. Delete blanks and move comments.
```

These are all in test fixture files that intentionally set env vars consumed by a
sourced/exec'd script under test (SC2034 false-positive shape) and one file where the
shebang is line 2 (a `# tests/...` path comment sits on line 1) — a genuine pre-existing
lint gap in a Task 10/11 file. Not touched: not my file, not introduced by this task, and
the instructions explicitly say to report rather than silently rewrite another task's
committed code.

## Deviations from brief's literal text

- `tests/run_all.sh`: `cd "$HERE/.."` → `cd "$HERE/.." || exit 1`. The brief's literal
  Step-1 text fails `shellcheck -S warning` (SC2164) on its own new file, which conflicts
  with this task's own "shellcheck -S warning clean across ALL scripts" constraint for the
  file it is authoring. Fixed in the one file that is this task's own deliverable; no other
  file touched.

## Files changed / committed

- `README.md` (overwrote Task 1's stub, full pack-contract doc)
- `tests/run_all.sh` (new, executable)

Commit: `1d14f4c` — "docs: full README (pack contract, config schema, merge-gate + bin
reference)"
Pushed: `origin/main` `5704323..1d14f4c`

## Self-review

- run_all.sh passes ALL suites: yes — 10/10 (9 bash `test_*.sh` files + 1 python unittest
  module with 9 individual test methods), confirmed on 3 separate runs.
- Final shellcheck across all `bin/` + `bin/agents/` + `tests/` scripts: clean for every
  file this task touches or owns (`bin/*.sh`, `bin/agents/*.sh`, `tests/run_all.sh`). 5
  warnings remain in 3 pre-existing test files from Tasks 10/11 — reported, not fixed.
- README complete and matches brief: pack contract, config schema (board/engine/agent/
  merge_gate/worktree), merge-gate strategy table (manual/ci_only/bot_comment/gh_review),
  `bin/` reference table (9 scripts), agent-adapter section (2-function contract, only
  claude.sh implemented), testing section — all present, transcribed verbatim from the
  brief.
- Commit scope: only `README.md` + `tests/run_all.sh` staged and committed (confirmed via
  `git status --short` before and after `git add`); no other task's files touched.

## Concerns

- 5 pre-existing shellcheck warnings (SC2034 x4, SC1128 x1) in `tests/test_agent_dispatch.sh`,
  `tests/test_preflight_recovery.sh`, and `tests/test_setup_worktree_slug.sh` — all from
  Task 10/11 commits, predate this task. Reporting as DONE_WITH_CONCERNS per the brief's
  own guidance rather than silently rewriting another task's committed code. These do not
  block the "ALL SUITES PASS" outcome (tests themselves still pass); they are lint-only.
- Git commit used the machine's fallback identity
  (`lukebradford@Lukes-Mac-mini.lan`) because no repo/global git user.name/email is
  configured for this clone. Did not modify git config (global constraint: never touch
  git config). Flagging for operator awareness only — does not affect commit correctness.

---

# TASK COMPLETION ADDENDUM: Shellcheck fixes (SC1128 + SC2034 false positives)

## Summary

Fixed the 5 pre-existing shellcheck warnings identified at end of Task 12 that had been left
untouched because they lived in earlier tasks' files. This follow-up task specifically
addresses those lingering findings.

## Changes made

### Fix 1: `tests/test_setup_worktree_slug.sh` — SC1128 (shebang on line 1)
- **Problem:** Line 1 was `# tests/test_setup_worktree_slug.sh` (comment), line 2 was `#!/usr/bin/env bash` (shebang). Shebang must be line 1.
- **Fix:** Swapped lines 1 and 2. Shebang is now line 1, path comment is line 2.
- **Code changed:** 2 lines (lines 1–2).

### Fix 2: `tests/test_agent_dispatch.sh` — SC2034 (SUPLOG false positive)
- **Problem:** SUPLOG is assigned but appears unused to shellcheck. Actually consumed by `log()` function inside sourced `bin/supervisor.sh` (cross-file visibility).
- **Fix:** Added shellcheck disable directive on line immediately above SUPLOG assignment:
  ```bash
  # shellcheck disable=SC2034  # consumed by log() in the sourced supervisor.sh
  ```
- **Code changed:** 1 line added (line 7).

### Fix 3: `tests/test_preflight_recovery.sh` — SC2034 (three false positives)
- **Problem:** Three variables (SUPLOG, AUTONOMY_TARGET_REPO, RESET_STATE) appear unused but are actually consumed by functions inside sourced `bin/supervisor.sh`.
- **Fix:** Added shellcheck disable directive above EACH of the three assignments:
  - Above `SUPLOG=/dev/null`: `# shellcheck disable=SC2034  # consumed by log() in the sourced supervisor.sh`
  - Above `AUTONOMY_TARGET_REPO="$work"`: `# shellcheck disable=SC2034  # consumed by preflight() in the sourced supervisor.sh`
  - Above `RESET_STATE="$tmp/.last_usage_reset"`: `# shellcheck disable=SC2034  # consumed by compute_limit_wait() in the sourced supervisor.sh`
- **Code changed:** 3 lines added.

## Verification

### Shellcheck pass (all clean)
```
cd ~/Dev/autonomy-engine && shellcheck -S warning tests/*.sh bin/*.sh bin/agents/*.sh
```
**Result:** No output (all clean).

### Test suite pass
```
bash tests/run_all.sh
```
**Result:**
```
=== tests/test_agent_dispatch.sh ===
ok   - CLI override wins over config
ok   - config wins over hardcoded default
ok   - hardcoded default wins when key absent
ok   - claude adapter file exists
---
ALL PASS
=== tests/test_board_resolve.sh ===
ok   - user-owned project found directly
ok   - falls back to organization when user has no match
ok   - neither user nor org match -> empty
---
ALL PASS
=== tests/test_doctor.sh ===
ok   - missing .autonomy/ -> hard fail
ok   - valid config, requires_claude_md false -> pass
ok   - requires_claude_md true, no CLAUDE.md -> hard fail
ok   - requires_claude_md true, CLAUDE.md present -> pass
ok   - malformed config.yaml -> hard fail
---
ALL PASS
=== tests/test_merge_gate_strategies.sh ===
ok   - all green -> ci_check passes
ok   - a failing check -> refuse
ok   - a pending check -> refuse
ok   - zero checks, ci_only -> refuse
ok   - zero checks, bot_comment -> pass (approval is the real gate)
ok   - zero checks, ci_only -> refuse
ok   - gh call itself fails -> refuse, not silently green
---
ALL PASS
=== tests/test_onboard.sh ===
ok   - config.yaml scaffolded
ok   - loop_prompt.md scaffolded
ok   - hard_rules.md scaffolded
ok   - idempotent -- does not clobber an existing file
---
ALL PASS
=== tests/test_preflight_recovery.sh ===
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
=== tests/test_safe_merge_doc_only.sh ===
ok   - single .md
ok   - multiple .md
ok   - nested .md paths
ok   - one code file among md disqualifies
ok   - code file alone
ok   - favicon PR (svg + html)
ok   - empty diff
ok   - .md as a directory, not extension
ok   - non-md extension that contains md
ok   - .rst not in configured list
ok   - .rst IS in configured list
---
ALL PASS
=== tests/test_setup_worktree_slug.sh ===
ok   - basename-derived slug, mixed case collapsed
ok   - non-alphanumeric collapsed to single dashes
ok   - engine.label overrides basename
---
ALL PASS
=== tests/test_unblock_dependents.sh ===
ok   - plain blocked by
ok   - markdown-bold blocked by
ok   - hyphenated blocked-by
ok   - trailing punctuation
ok   - one of several blockers
ok   - prefix-digit must not match
ok   - suffix-digit must not match
ok   - mention outside blocked line
ok   - no blocked-by line at all
ok   - parent (Part of #X) not a block
ok   - real blocker after the phrase
ok   - UPPERCASE: parent not a block
ok   - UPPERCASE: real blocker
ok   - table row-subject (only) not a block
ok   - #1815: #1823 is a real P5a blocker
ok   - #1815 table: #1820 blocks every row
ok   - single blocker
ok   - two blockers, sorted
ok   - ignores non-blocked refs
ok   - no blocked-by line
ok   - #1822: parent #1815 excluded
ok   - #1815 P5a: subject excluded
ok   - UPPERCASE: parent excluded
ALL PASS
=== tests/test_usage_limit_reset.sh ===
ok   - ISO-8601 'resetsAt' -> epoch
ok   - epoch-seconds 'reset'
ok   - epoch-millis 'resetAt' -> seconds
ok   - relative 'retryAfter' -> now+secs
ok   - non-finite retryAfter -> no reset (no crash)
ok   - overage-covered rejection yields no reset
ok   - content text is never parsed
ok   - rejected + no terminal result = blocked
ok   - rejected BUT session succeeded = not blocked
ok   - agent_classify_outcome reports usage_limit + epoch
ok   - agent_classify_outcome reports success
ok   - agent_classify_outcome reports error
---
ALL PASS
=== python: test_config_parser ===
test_comment_stripped (tests.test_config_parser.TestConfigParser.test_comment_stripped) ... ok
test_empty_map_present_exits_zero_no_output (tests.test_config_parser.TestConfigParser.test_empty_map_present_exits_zero_no_output) ... ok
test_list_value (tests.test_config_parser.TestConfigParser.test_list_value) ... ok
test_missing_key_exits_one (tests.test_config_parser.TestConfigParser.test_missing_key_exits_one) ... ok
test_quoted_string_with_spaces (tests.test_config_parser.TestConfigParser.test_quoted_string_with_spaces) ... ok
test_top_level_string (tests.test_config_parser.TestConfigParser.test_top_level_string) ... ok
test_two_levels_of_nesting (tests.test_config_parser.TestConfigParser.test_two_levels_of_nesting) ... ok
test_validate_mode_on_bad_file (tests.test_config_parser.TestConfigParser.test_validate_mode_on_bad_file) ... ok
test_validate_mode_on_good_file (tests.test_config_parser.TestConfigParser.test_validate_mode_on_good_file) ... ok

----------------------------------------------------------------------
Ran 9 tests in 0.103s

OK
ALL SUITES PASS
```

**10 test suites** (9 bash + 1 python), **all passing**.

## Commit

```
23cbe36 fix: shellcheck-clean the 3 test files missed in per-task lint (SC1128 shebang, SC2034 sourced-var false positives)
```

Pushed to `origin/main`.
