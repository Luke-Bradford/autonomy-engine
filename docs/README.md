# autonomy-engine docs — index

Everything about this engine's design, decisions, scope, and build history. This repo is
self-contained: you should not need eBull (the first target repo) to understand or extend the engine.

## Design & decisions

- **[design.md](design.md)** — the engine↔pack seam design spec. What's repo-agnostic (the engine)
  vs. per-project (the `.autonomy/` pack), the config schema, the four merge-gate strategies, the
  agent-adapter boundary, `onboard.sh`/`doctor.sh`. Carries the Codex review findings inline. This
  is the authoritative "what the engine is and why."
- **[implementation-plan.md](implementation-plan.md)** — the 13-task TDD build plan, with the actual
  code for every task. Tasks 1–12 built the engine; Task 13 was the eBull cutover.
- **[managed-agents-comparison.md](managed-agents-comparison.md)** — why the continuous Coder loop
  stays hand-rolled here, while the dashboard (#1876) and multi-role org (#1877) are redirected
  toward Anthropic's Managed Agents rather than hand-built. Read before scoping those.
- **[dashboard-design.md](dashboard-design.md)** — the control-room UI design (from a mockup
  session), with a production-grade build-direction preamble. The spec for the clickable
  control/visibility page. Not built yet — this is the next build phase.

## Build history (audit trail)

- **[build-log/ledger.md](build-log/ledger.md)** — one line per task: commit, review verdict, and
  the material findings (incl. the ones that became backlog issues). The fastest way to see what was
  decided and what's deferred.
- **[build-log/task-N-brief.md](build-log/)** — each task's exact requirements (extracted from the
  plan).
- **[build-log/task-N-report.md](build-log/)** — each task's implementer report (TDD evidence, test
  results, self-review). Review verdicts are summarized in the ledger; the material ones are on the
  issue tracker.

## Scope boundaries (what this engine deliberately does NOT do)

From design.md's Scope section — captured here so they aren't re-litigated:
- **Not** a cross-repo registry yet — the CLI (`supervisor.sh --repo <path>`) is shaped so a registry
  can drive it later, but supervising many repos at once is issue #4.
- **Not** the dashboard/control page — designed (dashboard-design.md), not built.
- **Not** the multi-role org (PM/Coder/QA/Owner) — redirected to Managed Agents.
- **Not** auto-provisioning of a cold repo's GitHub state (review workflow, branch protection,
  board) — `doctor.sh` diagnoses; it never provisions.
- **Not** any agent but Claude yet — the adapter boundary exists; Codex is issue #2.

## Backlog

Open issues are the build queue: **#1** harden safe_merge timestamp compare · **#2** codex agent
adapter · **#3** shared account-level usage-limit state (registry prereq) · **#4** registry /
control-unit · plus the dashboard/control-surface + graceful-stop issues (see the tracker).
