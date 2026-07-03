# Plan — #123 W5a: QA role rails + verdict→gate wiring

First loop-buildable slice of #89 (W5 role rails). The QA-on-actions scaffolding
already exists (`templates/autonomy-pack/qa/decide.sh`, `templates/qa-merge-gate.yml`,
`templates/autonomy-pack/roles/qa.md`, the `gate`/`scope.target`/`tools` schema in
`lib/roles.py`). This slice makes the QA role review like a human and wires the
role's `gate` knob into the merge decision — fail-safe, non-breaking, TDD.

## In scope

### Task 1 — QA rails (`templates/autonomy-pack/roles/qa.md`)
Extend the review dimensions to match the ticket's "think like a human, not a
linter": keep correctness / test-honesty / regressions / safety; ADD **UX**
(operator-surface usability/clarity), **docs** (documented where it should be?),
**"do the numbers add up"** (query/metric figures right?). Add a **findings
protocol**: raise each distinct finding as a verified GitHub issue, one per
problem, linked to the PR and the source ticket, labelled `bug`/`regression`/`ux`.
Keep the `QA-VERDICT: pass|fail` contract unchanged.

### Task 2 — gate-knob wiring (`templates/autonomy-pack/qa/decide.sh`)
New `qa_gate_allows_merge <gate> <strategy> <completes_merge>` — a WHITELIST,
fail-safe (resolves Codex CP1 finding 1: a config mis-scrape must not fail-open):
- `auto-merge-on-pass`  → defer to `qa_should_merge <strategy> <completes>`
                          (still gated on `completes_merge:true` + a
                          merge-permitting strategy — never bypasses merge
                          authority, roles.py:133 intent).
- ANYTHING ELSE (`wait-for-human`, absent `""`, unknown, mis-scrape) → refuse.
`auto-merge-on-pass` is the ONLY value that permits an auto-merge; every other
state (including a garbled/empty scrape) is treated as `wait-for-human` — the
safe default. Migration for a target that previously relied on
`completes_merge:true` without a gate knob is a one-line `gate: auto-merge-on-pass`
add, surfaced in the "not merging" log line (prevention-log #3 fail-open, #6
config-string re-validation at point of use).

### Task 3 — workflow wiring (`templates/qa-merge-gate.yml`)
Scrape the role's `gate` knob (awk, mirroring the existing `completes` scrape,
scoped to the `qa:` block by resetting on the next `^  [a-z_]+:` key; guard the
substitution with `|| true` so a missing/unreadable config yields `""` → refuse
rather than aborting the job under `set -euo pipefail` — Codex CP1 finding 3).
At the merge step, replace `qa_should_merge "$strategy" "$completes"` with
`qa_gate_allows_merge "$gate" "$strategy" "$completes"`; log the gate value +
the `gate: auto-merge-on-pass` migration hint in the "not completing" branch.
Update the workflow's top-of-file behaviour comment: merge completion now ALSO
requires `roles.qa.gate: auto-merge-on-pass` (Codex CP1 finding 5).

### Task 4 — tests (`tests/test_qa_gate.sh`, TDD)
- `wait-for-human` never merges, even with `ci_only` + `completes=true`.
- `auto-merge-on-pass` + `ci_only` + `true` → allow.
- `auto-merge-on-pass` + `manual` → refuse (routes through strategy).
- absent gate + `ci_only` + `true` → allow (back-compat preserved).
- unknown/garbled gate → refuse (fail-safe).
- `wait-for-human` + `manual` → refuse (belt and braces).
`qa_gate_allows_merge` never sees verdict state (Codex CP1 finding 6 — verdict
fail is handled BEFORE the merge decision in the yml). Verdict extraction stays
covered by the existing `qa_extract_verdict` tests.

## Deferred (file recommendation on #123, do NOT guess unattended)
- `scope.target: affected|full-regression` EXECUTION semantics in the Actions
  runner (how "affected" is computed; running a regression suite from a
  read-only review agent) — a genuine execution-design fork.
- `tools: [read,mcp]` — WHICH mcp tools the QA agent gets in the runner — needs
  an operator call on the allowlist.
- Literal "shell out to engine `safe_merge.sh` inside the target's Actions
  runner": the engine bin is not present there; the layered decide.sh gate
  (`qa_join_ready` + `qa_gate_allows_merge` + `qa_should_merge`) IS the
  sanctioned no-bypass merge path for the Actions substrate.

## Invariants respected
Fail-safe never fail-open (unknown gate refuses); bash 3.2 (no bash-4isms in
decide.sh/yml); repo-agnostic (all values from the target's config.yaml); genuine
tests (source the real decide.sh, mock only `gh`). No guardrail files touched
(`.autonomy/**`, `bin/safe_merge.sh`, engine `.github/workflows/**` all untouched;
`templates/` are scaffolds).
