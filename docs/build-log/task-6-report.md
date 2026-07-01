# Task 6 Report: `safe_merge.sh` — generic merge gate (4 strategies)

## What was implemented

`bin/safe_merge.sh` in `~/Dev/autonomy-engine` — the sole sanctioned merge path for the
autonomy loop. Implements:

- `is_doc_only(files, extensions_csv)` — pure string predicate, parameterized by a
  comma-separated extension list.
- `ci_check(pr, strategy)` — CI-state gate with an explicit fail-safe: a `gh` API call
  failure returns 1 (refuse), never silently treated as green. Zero configured checks
  refuse only for `ci_only`; not fatal for `bot_comment`/`gh_review` (approval is the
  real gate there).
- `merge_gate_bot_comment` — eBull's real mechanism: doc-only fast path (every changed
  file matches `doc_only_extensions`, CI green, no blocking bot comment) OR latest bot
  review comment postdates head commit and contains an APPROVE, not a REQUEST
  CHANGES/`[BLOCKING]`/"must fix before merge".
- `merge_gate_gh_review` — latest GitHub review from a configured `reviewer_login`,
  postdating head commit, with state `APPROVED`.
- CLI body: reads `merge_gate.strategy` from `.autonomy/config.yaml` via
  `lib/config_parser.py`; `manual` strategy never auto-merges (exits 0, PR left open);
  unknown strategy refuses (no silent fallback to a stronger auto-merge strategy); on
  success calls `gh pr merge --squash --delete-branch` then
  `bin/unblock_dependents.sh "$PR"` (Task 7 forward dependency — not created, per
  instructions).
- Executable body guarded by `[ "${BASH_SOURCE[0]}" = "${0}" ] || return 0` so sourcing
  (for tests) only defines functions.

Code is verbatim from the task brief (Step 3) — no deviations.

## TDD Evidence

### RED (both tests, before `bin/safe_merge.sh` existed)

```
$ bash tests/test_safe_merge_doc_only.sh
tests/test_safe_merge_doc_only.sh: line 6: .../bin/safe_merge.sh: No such file or directory
tests/test_safe_merge_doc_only.sh: line 11: is_doc_only: command not found
FAIL - single .md (expected 'doc', got 'strict')
... (4 FAILED total: single .md, multiple .md, nested .md paths, .rst IS in configured list)
---
4 FAILED
exit=1

$ bash tests/test_merge_gate_strategies.sh
tests/test_merge_gate_strategies.sh: line 7: .../bin/safe_merge.sh: No such file or directory
FAIL - all green -> ci_check passes (expected '0', got '127')
FAIL - a failing check -> refuse (expected '1', got '127')
FAIL - a pending check -> refuse (expected '1', got '127')
FAIL - zero checks, ci_only -> refuse (expected '1', got '127')
FAIL - zero checks, bot_comment -> pass (approval is the real gate) (expected '0', got '127')
FAIL - gh call itself fails -> refuse, not silently green (expected '1', got '127')
---
6 FAILED
exit=1
```

Confirms failure mode is exactly "missing `bin/safe_merge.sh`" (127 = command not
found / sourced file absent), not a pre-existing bug.

### GREEN (after implementing `bin/safe_merge.sh`)

```
$ bash tests/test_safe_merge_doc_only.sh
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
exit=0

$ bash tests/test_merge_gate_strategies.sh
ok   - all green -> ci_check passes
ok   - a failing check -> refuse
ok   - a pending check -> refuse
ok   - zero checks, ci_only -> refuse
ok   - zero checks, bot_comment -> pass (approval is the real gate)
ok   - gh call itself fails -> refuse, not silently green
---
ALL PASS
exit=0
```

11/11 and 6/6 checks pass.

## shellcheck

```
$ shellcheck -S warning bin/safe_merge.sh
(no output)
$ echo $?
0
```

Clean. Also ran shellcheck on both test files (not required by brief, extra
diligence) — clean, no output.

## Files changed

- Created `bin/safe_merge.sh` (executable, 159 lines)
- Created `tests/test_safe_merge_doc_only.sh` (executable, 29 lines)
- Created `tests/test_merge_gate_strategies.sh` (executable, 42 lines)

Committed directly to `main` in `~/Dev/autonomy-engine` at `f11187e`, consistent with
the repo's existing per-task commit pattern (each prior task — `board.sh`, `doctor.sh`,
`config_parser.py`, claude agent adapter — landed as a single commit on `main`; no
branch/PR workflow is in play for this scaffolding repo). Pushed to
`origin/main` (`ae8ce76..f11187e`).

## Self-review findings

- Both test files match the brief's Step 1 code verbatim (11 + 6 checks, including the
  parameterized `.rst` extension-list case).
- `bin/safe_merge.sh` matches the brief's Step 3 code verbatim, including the
  `unblock_dependents.sh` call at the very end (left in, not stubbed, not removed).
- TDD was followed in order: wrote tests first, ran and observed RED (missing-file
  127 errors), then implemented, then observed GREEN.
- **CI fail-safe read:** `ci_check` calls `gh pr checks "$pr" --json name,state
  2>/dev/null` inside `if ! checks_json="$(...)"; then ... return 1; fi`. A `gh`
  invocation failure (non-zero exit — auth error, network error, rate limit) trips the
  `if !` branch and returns 1 immediately, *before* any string-matching against
  `$checks_json` happens. It is structurally impossible for a `gh` call failure to fall
  through to the "no fail/pending patterns matched, return 0" path, because
  `checks_json` is never populated with a value that could match "all green" in that
  branch — the function exits via `return 1` first. The `__FAIL__` mock test in
  `test_merge_gate_strategies.sh` exercises exactly this path and passes.
- `manual` strategy: confirmed the CLI body checks `if [ "$STRATEGY" = "manual" ]` and
  `exit 0` immediately, before `ci_check` or any merge-gate function runs — never
  auto-merges.
- Unknown/misconfigured strategy falls into the `case` statement's `*)` branch, which
  echoes a REFUSE message and `exit 1` — no fallback to a stronger strategy.
- `is_doc_only` requires `[ -n "$files" ]` (empty diff refuses/returns strict per the
  test), builds an alternation regex anchored with `\$` per extension (so `.md` won't
  match `.mdx`, and a path segment `readme.md/thing.py` fails because the file's actual
  suffix is `.py`), and uses `grep -qvE` inverted with `!` — "no line fails to match the
  pattern" — which is the correct doc-only semantics.

## Concerns

None beyond the expected forward dependency. `bin/unblock_dependents.sh` does not exist
yet (Task 7, landing immediately after this task) — the CLI body's final line calls it
unconditionally on a successful merge, exactly as the brief specifies. This is expected
and explicitly out of scope for the current tests (`is_doc_only` and `ci_check` are the
only functions exercised; the merge body itself, including that call, is never reached
by either test).
