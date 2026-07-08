# pr-authoring

## Goal

A reviewer with zero codebase context understands the change, its security
model, and its tradeoffs from the description alone. Weak descriptions cost
review rounds.

## Required sections

Every PR description carries these headings (see PR #62 for a model):

### What changed
Concrete changes, main files/modules named, behavioural summary — not a
restatement of the issue title.

### Why
The problem, and why this shape. Link the spec/plan doc when one exists
(`docs/superpowers/specs/…`, `docs/superpowers/plans/…`).

### Security model
Mandatory, including files OUTSIDE the diff that the security argument rests
on. Cover as applicable: where secrets live and every path they cross (argv?
env? logs?); fail-safe vs best-effort classification of each new failure path;
which authorities are untouched (merge gate, reset-epoch writer, branch
protection); boundary validation (dashboard control channel, config-sourced
argv). If genuinely none, say "None — no auth/merge/secret surface touched."

### Invariants checked
The engine invariants this change brushed against and how each is preserved
(reset-epoch split, best-effort exit-0, repo-agnostic, bash 3.2, safe merge
default).

### Failure paths considered
The cases you handled: empty/first-run, garbage config shape, unresolvable
account, torn state file, `gh` down, etc.

### Testing
What the tests PROVE (behaviours, not file names), which pre-existing suites
gate the no-regression claim, and the verification commands run
(`run_all.sh`, shellcheck, template validation, dashboard verify loop).

### Conscious tradeoffs
What you deliberately did NOT do, so the reviewer doesn't discover it as a
gap. Accepted-risk items (e.g. shared usage-limit marker vs per-role accounts)
belong here with their tracking issue.

### Tech debt opened
Issue numbers, or "None".

## Conventions

- Title: `feat:`/`fix:`/`docs:` prefix + `(#<issue>)`; body carries
  `Closes #<issue>` so the merge closes it.
- **NEVER write closing-keyword+`#N` for an issue that must stay open — in
  ANY form, anywhere in a PR body.** This rule is about GITHUB, not our
  tooling: GitHub's own server-side closing grammar
  (`closingIssuesReferences`) is negation-blind AND quote-blind —
  empirically proven three times: PR #299 ("does NOT close #90"), PR #303
  (quoting that sentence), and PR #324 (the #301 FIX itself, whose body
  quoted the phrase while documenting it — GitHub linked [90,286,301] and
  closed #90 a third time). Since 2026-07-08 done-everywhere reads
  `closingIssuesReferences` (#301/#324), so the engine merely VERIFIES what
  GitHub will close — but GitHub closes negated/quoted refs natively at
  merge, with or without the engine. When you must reference such an issue:
  say "#N stays open — <what remains>", break the token pair when quoting an
  incident ("the 'does NOT close' phrasing against #N"), or put it in an
  issue comment — comments are never scanned by anyone. Real `Closes #N` in
  keyword position remains the one way a merge closes an issue; "Part of
  #N" / `(#N)` in the title remain the work-claim (Ready-reset) signals.
- End the body with the Claude Code attribution line (repo convention).
- Doc-only PRs skip the review bot but still get CI — say "doc-only" in the
  description so the missing review isn't chased.

## Pre-submit check

Would the reviewer know: the intended invariants? why this shape? what can
fail? what was deferred? what the tests prove? If any answer is no, fix the
description before pushing.
