# Lanes and the board contract — design spec

> Status: **operator-approved** (2026-07-03, interactive session — decisions D1–D6 all approved).
> Reframes #147 (was `instances: N`) and settles the work-routing contract that the W5 PM rail
> (#89), onboarding (#90), and the workflow page (#87) build on. Companion to
> `2026-07-03-configurable-workflows-design.md`; brainstorm record on #147 and #83.

## Operator requirements (verbatim intent, synthesised)

- A repo's worktrees should be first-class: parallel under one repo, renameable, and each may run
  *different* roles/behaviours ("a frontend lane runs a coder scoped to frontend labels; the main
  lane runs the full org").
- Work distribution must be clear: which agent looks for which label or priority on the board; how
  a PM works a project board. Assigning work "to a worktree" is not a GitHub concept and must not
  be invented.
- GitHub is the only supported board; setup must stay simple ("simple config that can hook into
  these boards", "thinking of a simple user setup").

## Settled decisions

| # | Decision | Consequence |
| --- | --- | --- |
| D1 | **Named lanes replace `instances: N`.** | `instances:` retired from the schema (supersedes settled-decision 17). |
| D2 | **Labels are the routing contract; Projects v2 is display-only.** | Issues + labels + milestone = source of truth; board.sh stays best-effort view sync. |
| D3 | **Priority = `p1`/`p2`/`p3` labels**, not Projects fields. | Rails order work "p1 > p2 > p3 > unlabelled, oldest first". No GraphQL field coupling. |
| D4 | **Onboard auto-creates routing labels** idempotently. | A scope subscribing to a missing label is no longer a silent empty board. |
| D5 | **GitHub-only; no board abstraction layer.** | Seam stays honest (board access concentrated in board.sh + few gh calls) for a future adapter; nothing speculative built. |
| D6 | **Cron/event roles fire in the default lane only, unless explicitly pinned.** | Two lanes never both wake QA on the same `pr.opened`. |

## The lane model

A **lane** is a named pairing of a worktree and a role subset. Every worktree of a repo checks out
the same committed `.autonomy/config.yaml`, so all lane config is keyed in that one file — the
single-source-of-truth rule holds with zero new files.

```yaml
lanes:                 # OPTIONAL; omitted = single implicit lane = today's behaviour (zero migration)
  main:     { worktree: "../.{repo-slug}-autonomy" }
  frontend: { worktree: "../.{repo-slug}-frontend" }

roles:
  coder:    { lane: main,     scope: { labels: [ready] } }
  coder-fe: { lane: frontend, scope: { labels: [ready, area:frontend] } }
  qa:       { trigger: { type: event, on: [pr.opened] } }   # lane-less → default lane only (D6)
```

### Semantics

- **Default lane.** With no `lanes:` block, the repo has one implicit lane (name `main`) whose
  worktree is `worktree.default_path` — byte-identical to today's behaviour. A role with no
  `lane:` field belongs to the default lane. The first declared lane is the default when a
  `lanes:` block exists; `doctor.sh` reports which lane is the default. A role whose `lane:`
  names an undeclared lane fails `validate_roles` (fail-safe: refuse at doctor/dispatch, never
  silently run it in the default lane).
- **Execution.** One supervisor per lane: `supervisor.sh --repo <lane-worktree> --lane <name>`.
  Dispatch enumeration (`roles.py dispatch`) filters to roles whose `lane` matches (lane-less
  roles match only the default lane). The existing launchd label scheme extends:
  `com.autonomy.<slug>.<lane>.supervisor`, with the default lane keeping today's
  `com.autonomy.<slug>.supervisor` label for compatibility (no reinstall on upgrade).
- **Parallelism without claiming.** Lanes with **disjoint label scopes never contend** for a
  ticket — the label partition is the claim. Overlapping loop-role scopes across lanes produce a
  `doctor.sh` WARNING ("lanes X and Y have overlapping label scopes — may double-work"), never a
  runtime lease mechanism. Operators who want N identical coders create N lanes and must state the
  partition (or accept the warned overlap).
- **Rename.** The lane name is the stable key. Renaming = editing the key (config page or YAML) +
  service reinstall (the launchd label derives from it). The worktree path is a property and may
  stay or move independently.
- **Rate limits.** Unchanged: all lanes share the repo's `engine.account_key` reset marker, so one
  lane hitting a usage wall backs every lane off together (supervisor.sh:174-224 untouched).
- **Cron/event (D6).** Trigger evaluation for cron and event roles runs only in the default lane's
  supervisor unless the role is explicitly pinned to a lane. This keeps exactly-one-firing without
  any cross-lane coordination.
- **Dashboard.** The repo card groups its lanes; each lane renders its own live-session /
  activity row (composes with #148 role attribution). Lifecycle controls become per-lane
  (start/stop/pause a lane), with a repo-level "all lanes" convenience.
- **`instances:` retirement (D1).** Removed from the schema in the same increment that lands
  lanes; until then the existing NOTE-log stub stands. Follows #149's wire-or-drop honesty rule.

## The board contract

**Issues + labels (+ milestone) are the source of truth. Projects v2 is an optional view.**

- **Routing.** Every role subscribes to work via `scope.labels` (already rendered into the session
  prompt). Distributing work = applying labels. Nothing else exists.
- **Priority (D3).** `p1`/`p2`/`p3` labels. Role rails carry one ordering instruction: pick the
  highest-priority in-scope item first (p1 > p2 > p3 > unlabelled), oldest first within a tier.
- **The PM never knows lanes exist.** PM duties (#89: groom / prioritise / unblock / spec-check)
  are pure GitHub operations — normalize labels, set priorities, mark `ready`, flag
  `needs-design`. Because lane scopes ARE label subscriptions, a PM applying `area:frontend` has
  routed the ticket to the frontend lane without any worktree concept. "Assign to a worktree" is
  impossible on GitHub and stays impossible here: **label application is assignment.**
- **Projects v2 (D2).** board.sh keeps its existing role: best-effort Status-column sync, warn +
  exit 0 on every failure (settled-decision 6). The engine never *reads* routing from board
  fields.
- **Label vocabulary.** The engine's standard set: `ready`, `p1` `p2` `p3`, `needs-design`
  (+ whatever `area:*`/custom labels the operator's scopes reference). Onboard creates the
  standard set idempotently via `gh label create` (D4) and, when scaffolding a workflow whose
  scopes reference custom labels, creates those too. Existing labels are never modified.

## Setup story (the simplicity bar)

Three prerequisites, everything else automated:

1. `gh auth login` (once per machine)
2. `claude` CLI logged in — codex/local-LLM optional (accounts registry)
3. A repo (local path; #90 adds link-from-GitHub)

Onboard then handles: pack scaffold, default workflow (#89 W5d), starter CLAUDE.md if missing
(#152 — shipped), routing labels (D4), worktree + launchd service, doctor validation. A Projects
board is never auto-created.

## Increment mapping

- **#147** — lanes execution (schema `lanes:` + role `lane:` + dispatch filter + per-lane
  supervisor/plist + doctor overlap warning + dashboard lane rows + `instances:` removal).
  Unblocked by this spec; plan per the repo working order (Codex checkpoint 1 on the plan).
- **#89 (W5c/W5d)** — PM rail implements the board contract verbatim (label vocabulary, priority
  ordering, never lane-aware); default workflow template references the standard labels.
- **#90** — onboarding UI runs the setup story; D4 label creation lands with onboard whether or
  not the UI exists yet.
- **#87** — workflow page renders lanes as first-class rows and the merge-path picture.
- **#149** — the unwired-knob warning list shrinks as this lands; `instances:` leaves the schema.

## Non-goals

- Runtime ticket claiming/leases (the label partition is the mechanism; overlap = warned).
- Board abstraction beyond GitHub (D5), or reading routing from Projects v2 fields.
- Role-turn weighting between loop roles (round-robin + scope stands until a real starvation case
  appears — flagged in the #83 synthesis, deliberately not built).
- Auto-creating Projects boards.

## Testing notes (for the implementation plans)

- roles.py: lane field validation (charset like role names), dispatch filtering (lane-less →
  default lane only), overlap detection pure-function with injected config.
- supervisor: `--lane` plumb-through, default-lane label compatibility (existing plist keeps
  working), D6 gating of cron/event evaluation to the default lane.
- onboard: idempotent label creation (second run = no-op; existing label untouched) — mock `gh`
  as a shell function per the established seam.
- doctor: overlap WARNING is diagnostic-only (exit 0), default-lane report line.
