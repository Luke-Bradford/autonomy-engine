# codex-checkpoints

Codex second-opinion runs at exactly three points in the workflow
(operator decision 2026-07-02, ported from eBull). Non-negotiable.

Invocation: `codex exec "<prompt>"` — always the non-interactive `exec`
subcommand, never bare `codex` (needs a terminal).

**Hang watchdog (operator feedback 2026-07-04 — recurring):** `codex exec` can
hang indefinitely producing ZERO output (two hangs in one evening: 40 min and
8 min, empty output both times). Never wait open-ended:

- Run it FOREGROUND with a hard timeout (~4 min covers a diff review). If the
  call gets backgrounded, its timeout no longer applies — poll the output
  file on a bounded timer instead of blocking until notified; ~4 min of an
  empty file = hung.
- On a hang: kill the whole chain (`zsh → node codex → codex` binary), retry
  ONCE with a shorter prompt. A second hang = codex is down for the night.
- Two hangs at checkpoint 2: PROCEED with the push and document the deviation
  in the PR (attempt timestamps + "post-hoc CP2 when codex recovers"), then
  actually run it retroactively. A broken tool must not become an indefinite
  gate-block — but the deviation is recorded, never silent.

## Checkpoint 1 — before writing code (two passes)

- **After the spec/plan is written, before execution starts:**

  ```bash
  codex exec "Review this implementation plan. Path: docs/superpowers/plans/<date>-<topic>.md. Focus: correctness gaps, invariant violations (fail-safe never fail-open, reset-epoch split, bash 3.2 floor, stdlib-only, repo-agnostic bin//lib/), missing edge cases, bad task decomposition, wrong interface contracts between tasks. Reply terse, findings only."
  ```

  Run once against the spec (when one is being written) and once against the
  plan before the first task dispatch. Fix real findings before executing.

## Checkpoint 2 — before first push

After self-review (`pre-flight-review.md`) + local gates pass:

```bash
codex exec "Review the diff on this branch against main for bugs and invariant violations. Run: git diff main...HEAD. Invariants: fail-safe never fail-open; supervisor is sole writer of .last_usage_reset; best-effort scripts exit 0 on failure; bash 3.2.57 only (no mapfile/globstar/declare -A); python stdlib only; no target-repo-specific values in bin/ or lib/; secrets never in argv or logs. Reply terse, findings only."
```

Fix anything real before pushing. Follow-up pushes that address review
comments do NOT need a fresh Codex pass — the review bot re-checks.

## Checkpoint 3 — before merging on a rebuttal-only round

If the latest review round's findings are ALL rebuttals (no code changes
pending), Codex must independently agree before merge:

```bash
codex exec "Adjudicate: review bot found <finding>. Author rebuts: <rebuttal>. Code: <file:lines>. Is the rebuttal sound? Reply verdict + one-line reason."
```

- Codex + author agree the rebuttals are sound → merge (no operator
  rubber-stamp needed).
- Codex finds new issues or sides with the bot → fix, re-push, restart the
  review loop.

Never merge on rebuttals with only the author's word — "the bot is wrong" is
not self-certifying.

## When Codex is NOT required

- Follow-up pushes fixing review comments.
- Doc-only diffs (no executable change) — checkpoint 2 optional.
- Routine edits after Codex already reviewed the plan + first diff, with no
  rebuttal-only round pending.

## Escalate to the operator only for

Genuine judgment calls Codex cannot resolve: architecture trade-offs, scope
decisions, settled-decision changes, irreversible actions.
