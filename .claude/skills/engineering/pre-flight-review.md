# pre-flight-review

Mandatory self-review before every push. Catch the review bot's objections
before opening another round.

## Process

```bash
git diff origin/main...HEAD
```

Read it top to bottom with reviewer posture. Do not push until every item
below is satisfied, fixed, or explicitly deferred with a tech-debt issue.

## Checklist by bug class

### A. Fail-safe, never fail-open

For every new failure path, ask: does failure REFUSE (clear log + error rc) or
silently continue on a guess? The wrong direction is any of: running on broken
auth, treating a `gh` failure as CI-green, silently widening an agent's remit
(dropped scope), auto-upgrading a merge-gate strategy on misconfig. If a
fallback exists, it must fall back to the SAFER thing (coder-only, manual gate,
subscription auth) and log that it did.

### B. Bash pitfalls

- `local x=$(cmd)` masking rc; `VAR=value` parsing without an `=` guard;
  unquoted expansions without a charset guarantee + `SC2086` comment.
- Secrets: never in argv, never in a log line, exported only inside a subshell.
- bash-3.2 floor (see `bash-hygiene.md` table).
- Config-sourced values re-validated before argv (`valid_model_id` parity).

### C. Invariants (CI bot enforces; check them yourself first)

- Reset-epoch split: adapters only EXTRACT the reset epoch; `supervisor.sh` is
  the sole writer of `.last_usage_reset`.
- Best-effort scripts (`board.sh`, `unblock_dependents.sh`) still `exit 0` on
  every failure path.
- Repo-agnostic `bin/`/`lib/` — grep your diff for GitHub owners, board
  titles, issue numbers.
- `merge_gate.strategy: manual` stays the default; misconfig hard-refuses.
- Source-guards intact on any script you touched.

### D. Empty / first-run correctness

What happens with no `roles:` block, an empty accounts registry, a missing
state file, an empty board, a fresh machine? The default path IS the product
for `quickstart.sh`/`onboard.sh` users — trace it, don't assume it.

### E. Test quality

Every changed behaviour has: happy path, empty/first-run case, garbage-shape
case, failure-path-refuses case, and (for layered values) precedence tests —
per `test-quality.md`. Stubs only at the established seams.

### F. Concurrency / idempotency

Two supervisors on one repo (the lock), two loops sharing one account (shared
reset marker), a re-run of onboarding (idempotent scaffold), a torn read of a
state file (validate per-read, `read_valid_reset` pattern). Writes that others
read concurrently are atomic (`tmp` + `mv`/`os.replace`).

### G. Scope discipline

Solve the issue without sneaking in redesign. Half-fixed problems and
undocumented tech debt are review findings — open the issue yourself first.

### G2. Simplicity, duplication, and known logic (operator standard 2026-07-09)

- **No guessed behaviour in the diff.** Every runtime claim the code rests
  on (a git flag, an API shape, a framework quirk) was CHECKED — run
  empirically, read in official docs, or read in source — before being
  coded against. "I believe it works like…" in your own reasoning is the
  tell: stop and verify.
- **Duplication sweep, post-plan.** Before adding a helper or a parsing
  block, grep `lib/` and the script you are in for an existing one; a
  near-duplicate gets unified into one owner, or the duplication is
  justified in the PR (the review bot finds the rest — see #354's
  default_branch ×3 finding, tech-debt #356).
- **Lowest workable complexity.** Prefer the boring shape; cleverness must
  carry a comment stating the CONSTRAINT that forces it, or it gets
  simplified in review.
- **Brief commentary, known logic.** Comments state constraints/invariants
  the code cannot show — never narration of the next line. Anything
  genuinely complex (an algorithm, a protocol, a multi-file contract)
  gets its logic written up in the relevant doc or skill and the code
  points there by name — complexity must be KNOWN logic someone can look
  up, never head-knowledge that left with the session.

### H. Settled decisions

Read `docs/settled-decisions.md`. State which decisions apply and how the diff
preserves them; if none apply, say so. If the implementation wants to change
one, STOP and surface it before coding on.

### I. Prevention log

Read `docs/review-prevention-log.md`. State which entries are relevant and how
the diff avoids repeating them; if none, say so explicitly.

### J. Dashboard branch

If the diff touches `bin/dashboard.py`, `lib/dashboard_*`, or `lib/*.html`,
read `.claude/skills/dashboard/SKILL.md` and run its browser verify loop
before claiming done.

## Required same-class scan

After finding ONE instance of a hazard in a file, grep the whole file (and the
sibling scripts) for the same shape and account for every occurrence. One
fixed `local x=$(…)` with five unfixed siblings is a partial fix — the bot
will find the rest.

**This applies to REVIEW FIXES too** (prevention-log #21, PR #358): when a
review finding names an instance of a CLASS (missing guard, masked rc,
unvalidated input), the follow-up commit fixes every occurrence in the
touched scope and the reply says so ("scanned siblings: X also widened, Y
already guarded because …"). A one-site fix to a class finding costs the
next full review round.

## Pre-push statement

Before pushing, be able to state honestly: fail-safe paths checked; invariants
preserved; empty/first-run traced; tests added at the right seams; same-class
scan done; settled decisions + prevention log consulted; dashboard verify loop
run if applicable. If you can't, don't push yet.
