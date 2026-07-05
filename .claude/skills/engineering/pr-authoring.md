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
- **Multi-slice PRs: never write a negated close phrase.** safe_merge's
  done-everywhere pass extracts close-refs with a keyword+`#N` regex that is
  blind to negation — the sentence "does NOT close #90" auto-closed #90 on
  merge (2026-07-05 incident, bug #301). Until #301 lands, say "#N stays
  open — <what remains>" and never place `close/closes/fix/fixes/resolve/
  resolves` directly before an issue ref you do NOT want closed.
  **Quoted text counts too**: PR #303 — the doc PR for #301 — *quoted* the
  offending sentence in its body and closed the same issue a second time.
  The scan is on the PR body verbatim (grep, no negation/quote awareness),
  so when describing such an incident, break the token pair (e.g. "the
  'does NOT close' phrasing against #90"), or reference the issue only in
  a GH comment — comments are not scanned.
- End the body with the Claude Code attribution line (repo convention).
- Doc-only PRs skip the review bot but still get CI — say "doc-only" in the
  description so the missing review isn't chased.

## Pre-submit check

Would the reviewer know: the intended invariants? why this shape? what can
fail? what was deferred? what the tests prove? If any answer is no, fix the
description before pushing.
