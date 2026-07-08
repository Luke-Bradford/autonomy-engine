# The pipeline model — entities, a step library, and the loop as an ADF-style pipeline

Operator sessions 2026-07-08 (late). Supersedes the loop-canvas spec's
station model; keeps its honesty split and compiler principle. The operator
confirmed the entity model ("that looks about right") and directed the
extension: more step types, custom steps in a library, before/cycle/after
placement, per-step failure handling, and a visual design a user can
actually tinker with — "think of this like an ADF pipeline, but it's a
loop."

## Entities (confirmed)

1. **Repo** — project facts: board connection, merge policy, accounts.
2. **Workspace** — a working copy hung under a repo (multiples; = lane).
   Config is territory: label partition + worktree. Empty desk until roles
   attach.
3. **Role definition** — a stencil in the role library: a named pipeline of
   steps + defaults. Ships with editable starters (Coder/QA/PM/Researcher).
4. **Role instance** — a definition attached to a workspace, copied then
   tinkered. Reset-to-default / save-as-default are explicit actions.
5. **Step definition** — NEW, the ADF-activity analogue: steps are ALSO a
   library. A role definition's pipeline is a list of step references +
   per-use overrides; instances override further.
6. **Account** — auth identity (exists).

## Loop anatomy (the ADF correction: a pipeline with a cycle in it)

```text
TRIGGER (continuous · schedule · event · manual)
  │
  ▼
BEFORE — once per run, outside the cycle        (setup: gather context,
  │                                              sync the board, plan the day)
  ▼
┌─ CYCLE ──────────────────────────────────────┐
│  step → step → step → …                      │  repeats while the
│  cycle-done check: "is this item finished?"  │  repeat rule holds
└──────────────────────────────⟲ repeat rule ──┘  (e.g. "next ticket while
  │                                               queue has items & under cap")
  ▼
AFTER — once per run, outside the cycle         (teardown: summarize, notify,
  │                                              journal, housekeeping)
  ▼
STOP RULES — the loop's frame
  done when · caps (sessions/day, budget) · on a problem
```

Placement is a property of a step USE: `before` / `cycle` / `after`. The
palette marks which placements a step type allows (most allow all three).

## Step-type catalog (expanded — agentic work is not just coding)

Grouped as the palette groups them. Every type: enforced or instructed tag,
param form, and a default on-fail.

**Getting work**
- **pick** — source a work item: board query (labels · order · milestone),
  a PR set, git history, a file list. Cycle-only; usually the cycle's head.
- **wait / watch** — pause for external state: CI finished, PR approved,
  a time window, a file to appear. (ADF's wait activity; enforced where the
  engine can poll, instructed otherwise.)

**Thinking**
- **plan** — produce a plan (brain-selectable). Removable — a coder working
  from ticket-written plans deletes it.
- **gather** — research/collect context: read docs, web search, scan the
  codebase, read prior tickets.
- **decide** — a judgment call with named criteria ("is this a duplicate?",
  "p1 or p3?"); output steers the run (v1: feeds the brief; full branching
  deferred — see Simplifications).

**Doing**
- **act** — the work verb: write code · label & comment · merge · write
  docs · edit files. Brain-selectable.
- **transform** — mechanical bulk change: codemod, rename sweep, docs
  regeneration (instructed act specialised for repetitive shape).
- **triage** — classify/label/order a set (the PM's core; params can point
  at sibling instances: "maintain the ordered list for coder, coder-bugs").

**Checking**
- **check** — verify: run the test suite · subagent code review · security
  pass · browser-verify · plan-check · lint. The gates row (review bot ·
  CI · merge gate) is always-on and locked where merge paths exist.
- **ask** — consult: the thinking brain · a human (needs-you queue, with
  the SD-32 escalation schema) · another role instance.

**Communicating**
- **summarize** — produce a digest: release notes, changelog entry, status
  report, PR description.
- **notify** — deliver: comment on the issue/PR, raise a ticket, post to
  the needs-you queue. (Channel adapters later; GitHub surfaces v1.)
- **handoff** — pass the item to a named sibling instance (coder → qa).

**Keeping house**
- **journal** — record learnings/memory for the next run (append to the
  role's notes file the brief re-reads).
- **housekeep** — cleanup: prune merged branches, close stale tickets,
  sweep the board, worktree gc.

## Per-step failure paths (the ADF on-fail edge, simplified)

Every step USE carries `on-fail`: **continue** (note it, move on) ·
**retry once** · **ask a human** (needs-you + park the item) · **stop the
run** (end cleanly, flag). The loop-level "on a problem" is the default
inherited by steps that don't set their own. This answers "when should it
end if there's a problem" at both granularities without a DAG.

## The step library (custom steps)

A custom step is a small unit, not a role:

```yaml
name: verify-changelog          # charset-gated
description: check the changelog gained an entry for this change
kind: check                     # palette group + placement rules it inherits
brain: thinking | building | own model   # who executes it
prompt: |                        # the brief fragment (template)
  Verify CHANGELOG.md has an entry describing this change; add one if not.
params: {}                       # optional key: value pairs the prompt interpolates
placements: [cycle, after]       # where it may be dropped
on_fail: continue                # default
```

- Created from the library page OR in-place ("save this step to the
  library" while editing a role). Stored beside role definitions
  (`~/.config/autonomy/library/steps/`), same index-file conventions.
- Starters seed the palette; users duplicate/edit/delete like roles.
- A role pipeline entry = `{step: <library name or inline>, placement,
  overrides {brain, params, prompt-append, on_fail, enabled}}`.

## Compilation (unchanged principle, wider scope)

The pipeline compiles to the instance's brief as ordered, fenced sections
per zone (`<!-- pipeline:before -->` …). Enforced steps (trigger, wait-on-
CI, caps, gates, handoff wiring) execute in the engine; instructed steps
are the generated brief. Every step card wears its tag. The prose textarea
is gone as an input; per-step `prompt` IS the escape hatch, at the right
granularity.

## Visual design (the simplification answer)

NOT a node graph. One **vertical rail**, three zones, reading top to
bottom exactly as the run executes:

- **Header**: trigger pills (continuous · schedule · event · manual + its
  one param inline).
- **BEFORE zone** (flat background) — step cards.
- **CYCLE zone** — visually a loop: bordered box, ⟲ badge, its repeat rule
  as the box's footer ("next ticket while the queue has items").
- **AFTER zone** (flat) — step cards.
- **STOP RULES footer** — done-when · caps · on-a-problem, as three plain
  controls.

Step card = one line: grip · icon · name · one-line summary · tag
(enforced/instructed) · on-fail badge · toggle · ×. Click = param drawer
opens UNDER the card (brain, params, prompt fragment, on-fail, move zone).
**Palette** docked at the side, grouped by the verbs above, drag-or-click
to add; "＋ custom step…" at its foot opens the small form above. Locked
cards (the gates) render solid with no ×.

Simplifications that keep it tinkerable:
- No DAG/branch arrows in v1 — `decide` + per-step on-fail cover the real
  cases; arbitrary branching is deferred until a story demands it.
- Cards show one line until clicked; zero-config adds (every palette step
  works with defaults).
- Drag between zones is the same gesture as reorder; illegal drops bounce
  with the reason ("pick lives in the cycle").
- The observed lighting (what last run did) stays — the same rail doubles
  as the activity view, so config and observation are one surface.

## Walked stories (added to the catalogue)

| # | Story | Oracle |
| --- | --- | --- |
| S21 | Add "summarize → notify" AFTER steps to the coder: post a run digest comment. | brief gains fenced after-zone; comment appears post-run |
| S22 | Create custom step "verify-changelog" (check, cycle), save to library, use in two repos. | library entry; both briefs carry it |
| S23 | PM pipeline: before=sync board · cycle=triage per ticket · after=journal. | three-zone compile; PM run shows all three phases |
| S24 | Coder waits for CI after push before continuing (wait step). | enforced wait where pollable; run pauses on red CI per on-fail |
| S25 | Set a step's on-fail to "ask a human"; simulate failure; needs-you fires, item parked. | escalation comment w/ SD-32 schema |
| S26 | Move "gather context" from cycle to BEFORE (once per run, not per ticket). | brief sections move zones; token cost drops |

## Build implications (delta over what exists)

- Schema: `roles.<n>.pipeline: {before: [], cycle: [], after: [], repeat:,
  stop: {done, caps, on_problem}}` — validated; compiled to the rail;
  legacy `prompt:`-only roles keep working (a pipeline with one opaque act
  step).
- Library: `lib/library.py` grows steps beside roles.
- Engine enforcement lands incrementally: caps → wait-on-CI → the rest
  stay instructed with honest tags (the #157 pattern from birth).
