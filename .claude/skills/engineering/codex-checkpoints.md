# codex-checkpoints

Codex second-opinion runs at exactly three points in the workflow
(operator decision 2026-07-02, ported from eBull). Non-negotiable.

Invocation: `codex exec "<prompt>" </dev/null` — always the non-interactive
`exec` subcommand, never bare `codex` (needs a terminal), and ALWAYS with
stdin closed.

**Why `</dev/null` is mandatory (root cause, diagnosed 2026-07-04):**
`codex exec` reads stdin until EOF ("Reading additional input from stdin...")
before doing anything. In a foreground shell stdin closes and all is well; in
a BACKGROUNDED harness task stdin is a pipe that never closes, so codex sits
silently forever — zero output, no error. That was the "two hangs in one
evening" (40 min + 8 min): codex itself was healthy the whole time, proven by
a three-way experiment (foreground OK · backgrounded no-redirect HANGS ·
backgrounded `</dev/null` OK). Diagnose-before-declaring-dead: the first
version of this section said "second hang = codex is down for the night" —
that was a guess from two data points, and it was wrong.

**Hang watchdog (operator feedback 2026-07-04 — keep regardless):** even with
the stdin fix, never wait open-ended on a spawned checkpoint:

- Prefer FOREGROUND with a hard timeout (~4 min covers a diff review). If the
  call gets backgrounded, poll its output file on a bounded timer; ~4 min of
  an empty file = investigate (check for the stdin symptom first).
- On a genuine hang: kill the whole chain (`zsh → node codex → codex`
  binary), retry once WITH `</dev/null` confirmed. If it still hangs, run the
  minimal probe (`codex exec "Reply with exactly: OK" </dev/null`) to separate
  tool-broken from invocation-broken before concluding anything.
- Only a failing PROBE justifies the deviation path: proceed with the push,
  document the deviation in the PR (attempt timestamps + "post-hoc CP2 when
  codex recovers"), then actually run it retroactively. A broken tool must
  not become an indefinite gate-block — but the deviation is recorded, never
  silent, and "broken" is a diagnosis, not a vibe.

## Checkpoint 1 — before writing code (two passes)

- **After the spec/plan is written, before execution starts:**

  ```bash
  codex exec "Review this implementation plan. Path: docs/superpowers/plans/<date>-<topic>.md. Focus: correctness gaps, invariant violations (fail-safe never fail-open, reset-epoch split, bash 3.2 floor, stdlib-only, repo-agnostic bin//lib/), missing edge cases, bad task decomposition, wrong interface contracts between tasks, duplication of existing helpers in lib//bin/ the plan should reuse instead, unnecessary complexity a simpler shape covers. Reply terse, findings only."
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
