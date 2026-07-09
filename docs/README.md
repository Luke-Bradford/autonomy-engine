# autonomy-engine docs — index

This repo is self-contained: you should not need any target repo to
understand or extend the engine. The docs split into two layers — know
which one you are reading:

- **Product documentation** — what the engine is and how it works today.
  Written for someone with no knowledge of how it was built. Start here.
- **Engineering records** — decision logs, build plans, design-session
  archives, review-lesson logs. These are the working substrate of the
  engineering process (they use internal shorthand and reference build
  phases); read them when contributing changes, not to learn the product.

## Product documentation (start here)

- **[design.md](design.md)** — the engine↔pack seam: what is repo-agnostic
  (the engine) vs. per-project (the `.autonomy/` pack), the config schema,
  the four merge-gate strategies, the agent-adapter boundary,
  onboarding/doctor tooling. The authoritative "what the engine is and
  why."
- **[pipelines.md](pipelines.md)** — the pipeline system: describing
  multi-step agent work as a typed-dependency graph (loops, parallel
  ranks, failure paths, enforced caps), how a run executes, the run
  journal and earned-autonomy trust tiers, and the `/pipeline` dashboard
  canvas.
- **[dashboard-design.md](dashboard-design.md)** — the control-room UI
  design. The dashboard is BUILT and live (`bin/dashboard.py`; pages `/`,
  `/config`, `/pipeline`); this doc is its design rationale.
- **[byo-llm.md](byo-llm.md)** — pointing a role at a local
  OpenAI-compatible endpoint.
- **[managed-agents-comparison.md](managed-agents-comparison.md)** — where
  this engine deliberately overlaps with or defers to hosted agent
  platforms.

## Engineering records (internal shorthand lives here)

- **[settled-decisions.md](settled-decisions.md)** — numbered rulings
  (`SD-N`) that changes must not silently regress. The CI review bot
  enforces these.
- **[review-prevention-log.md](review-prevention-log.md)** — numbered
  recurring-bug-class lessons (`prevention-log #N`) extracted from review
  rounds.
- **[superpowers/specs/](superpowers/specs/)** — design-session archives.
  `2026-07-08-sequencer-MASTER.md` is the pipeline build's internal entry
  point (shipped-state table, phase plan, decision pointers).
- **[superpowers/plans/](superpowers/plans/)** — per-slice implementation
  plans (TDD task breakdowns) as executed.
- **[implementation-plan.md](implementation-plan.md)** +
  **[build-log/](build-log/)** — the original 13-task engine build and its
  audit trail.
- **[control-room-research.md](control-room-research.md)** ·
  **[agent-org-design.md](agent-org-design.md)** — earlier design arcs;
  superseded where they conflict with settled-decisions.md.

## Scope boundaries (deliberate non-goals today)

- Merges happen ONLY through `bin/safe_merge.sh` — no pipeline, agent, or
  dashboard action can bypass the merge gate.
- The engine diagnoses a cold repo's GitHub state (`doctor.sh`) but never
  provisions it.
- Pipeline activities the engine cannot yet enforce (human-in-the-loop
  waits, arbitrary command execution, per-item fan-out) are REFUSED by the
  validator rather than run in a weaker form — see pipelines.md.
- Canvas editing (drag-and-drop pipeline authoring) is not yet available;
  pipelines are edited as JSON + Markdown briefs.

## Current state (high level)

Multi-repo registry + lifecycle control (`bin/control.sh`), Claude + Codex
agent adapters, cron/event/loop/manual triggers, the pipeline sequencer
with bounded parallel dispatch, the live dashboard (fleet rail, config
authoring, pipeline canvas), run journal + trust ledger. The issue tracker
is the authoritative backlog.
