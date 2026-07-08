# The agentic loop sequencer — ADF for Claude pipelines (v5, the think-big spec)

Operator session 2026-07-08 (final). Consolidates and supersedes the
pipeline-model spec's orchestration sections; entities, step library,
honesty split and compilation carry forward. Direction:

> "Think big on an ADF integration of Claude's abilities to orchestrate a
> working pipeline of actions against a repo, a set of files, whatever an
> agentic agent can do automatically."

## 1. The asset model — pipelines are things you own, not settings

- **Pipeline (template)** — a standalone asset in the library
  (`~/.config/autonomy/library/pipelines/<name>/pipeline.json` + per-node
  briefs). It runs NOTHING by itself. A gallery lists them: starters we
  ship (ticket-to-merge, board-groom, research-digest, pr-qa-sweep), the
  user's own, and dust-collectors — all equal citizens.
- **Assignment** — attaching a pipeline to a **workflow slot on a repo's
  workspace** creates an **independent clone** with provenance
  (`from: ticket-to-merge@v3`). Template edits never mutate clones; clone
  edits never touch the template. Explicit actions: *reset to template* ·
  *save back as template* · *save as NEW template (rename)* — the operator's
  exact versioning ask.
- **Workflow slot config** (per assignment, not in the pipeline): enabled /
  disabled · trigger override · **run window** ("only 22:00–06:00
  weekdays") with end-of-window behaviour: **graceful** (finish the current
  activity, stop) or **hard** (interrupt now) — mirrors our existing
  pause/stop semantics · concurrency slot (which lane/worktree).
- Nothing runs unless: repo active + workspace exists + assignment enabled
  + trigger fires + inside the window. Four independent switches, all
  visible.

## 2. The dependency model — a real DAG (the ETL correction)

Activities connect with **typed dependency edges**, ADF's precedence
constraints verbatim:

- **on success** (green) — run when the upstream activity succeeded
- **on failure** (red) — run when it failed (the error path IS part of the
  graph: notify → park → end)
- **on completion** (grey) — run either way
- (skipped propagates: an activity whose dependencies never fire is
  skipped, and downstream on-success edges skip too)

**Parallelism**: activities with no dependency between them run in
parallel — mechanically, parallel Claude sessions bounded by an enforced
`max_parallel` on the pipeline (engine-owned; each parallel branch gets an
isolated context, per the multi-agent docs' thread model). Each parallel
activity keeps its own full config.

**Containers** stay from v4, now as DAG nodes:
- **loop-until** — inner sub-graph + exit-when (instructed) + max-rounds
  (ENFORCED).
- **for-each** — NEW (ADF's ForEach): map the inner sub-graph over a set
  ("for each file in src/legacy/", "for each open PR labelled
  needs-docs") with `max_parallel` per batch. This is the fan-out that
  makes migrations/sweeps first-class.
- **stage** — default agent/context for children.
- **branch** — labeled verdict paths; back-edges to container heads with
  enforced bounce caps (v4, unchanged).

## 3. Prior art survey (what we borrow, deliberately)

| Product | What we take | What we skip |
| --- | --- | --- |
| **ADF** | precedence constraints (success/failure/completion), ForEach/Until containers, the property pane per activity, trigger windows, linked-service analogy (model/agent = the "connection") | JSON-first authoring; heavyweight IR |
| **n8n / Node-RED** | approachable node canvas, click-node → config pane, test-run a single node | free-form 2D spaghetti — we keep left-to-right rank layout |
| **GitHub Actions** | `needs:` readability, per-job `if:`, matrix (≈ for-each), reusable workflows (≈ templates) | YAML as the primary UI |
| **Airflow** | sensors (≈ wait/watch), retries + SLAs per task, backfill discipline | scheduler-first mental model; code-authored DAGs |
| **Zapier/Make** | zero-config defaults per step; plain-language step names | linear-only flows |

Rule distilled from all five: **canvas for shape, pane for detail** — the
graph shows WHO runs WHEN on WHAT dependency; every other field lives in
one right-hand property pane per selected node.

## 4. The activity catalog — mapped from Claude's actual abilities

Every activity declares a **spec sheet**: required fields, optional
fields, context inheritance, model policy, and which dependency outputs it
emits. Grounded in the platform docs (agent loop, subagents, permissions,
MCP, managed-agents, hooks):

| Activity | Required | Optional | Notes |
| --- | --- | --- | --- |
| **pick** | source (board query / PR set / file glob / git range) | order, limit, plan-source | emits the item downstream activities reference |
| **agent task** (the general act) | brief (prompt) OR library step ref; runs-as (agent+model) | effort, allowed tools, max turns, budget USD, permission mode | the workhorse; all SDK levers surfaced |
| **plan** | runs-as | plan template, vagueness rules | emits verdict viable/too-vague |
| **gather / research** | what to collect | web search on/off, sources | maps to WebSearch/WebFetch/Read tools |
| **check** | what to verify (suite / review lens / browser / custom) | pass criteria | emits success/failure — the natural branch source |
| **subagent review** | lens (code/security/UX) | model override | Claude Code Agent-tool dispatch |
| **wait / watch** | condition (CI state / PR state / file / duration) | timeout | ENFORCED (engine polls gh/fs); timeout → failure edge |
| **ask human** | the question (SD-32 schema) | answer chips, default-if-ignored | parks; resume on answer = an event |
| **handoff** | target assignment/stage | payload note | enforced wiring |
| **summarize / notify** | destination (issue/PR comment, new ticket, needs-you) | template | GitHub surfaces v1 |
| **transform** | file set + instruction | per-file vs whole-set | pairs with for-each |
| **triage** | the set + the vocabulary (labels) | sibling references | |
| **journal / housekeep** | what to record / what to clean | — | |
| **git ops** | op (branch/commit/push/PR/merge-via-gate) | — | merge ALWAYS via safe_merge — not configurable off |
| **run command** | the command | cwd, timeout | allowlist-gated; the escape hatch |

**Context inheritance per activity** (his CLAUDE.md/skills question):
- `context: project` (default) — the session runs in the repo: CLAUDE.md,
  `.claude/skills`, `.claude/agents` load. Right for anything touching the
  code.
- `context: own` — bare session + only the activity's brief (plus explicit
  skill picks later). Right for summarizers/notifiers that must not absorb
  project bias or token cost.
- Toggle is per-activity, visible on the node ("inherits project brain"
  chip).

**Safe-to-toggle vs guarded** (his safety question):
- Free: model, effort, brief, order, context, notify targets, schedules.
- Guarded (visible, not removable): merge goes through safe_merge; caps on
  loops/for-each/bounces; the repo merge-gate chain; budget ceilings.
- Dangerous-but-allowed with friction: permission mode beyond acceptEdits,
  run-command allowlist edits — both behind an explicit "I understand"
  confirm and logged.

## 5. Persistence & versioning

Pipeline document (JSON, stdlib-parsed, index-file conventions):
`{name, version, nodes:[{id, type, config, brief_ref}], edges:[{from, to,
on}], containers, trigger_default, caps}`. Briefs as sibling files.
Clones carry `{from, from_version, diverged: bool}`; the gallery badges
divergence. Save-back bumps the template version; existing clones keep
their pin (no silent fleet-wide behaviour change — same reasoning as the
managed-agents roster pinning).

## 6. Execution semantics (delta over v4)

- The engine walks the DAG per trigger fire: ready set = nodes whose
  dependency conditions are met; dispatch up to `max_parallel` sessions;
  activity outcome (success/failure + structured verdict) recorded to the
  run journal that the observed lighting renders.
- An activity's on-failure edge REPLACES on-fail=stop when present (the
  graph is the error handler); absent any failure edge, the pipeline stop
  rules apply.
- Run window enforcement wraps the whole walk (graceful = no new
  dispatches, finish in-flight; hard = interrupt).
- Everything still compiles per-session briefs; the honesty tags survive on
  the canvas (enforced vs instructed borders as before).

## 7. Visual design v5 (the ADF look, committed)

- **Left**: activity palette (catalog groups + structure nodes + custom).
- **Center**: the DAG canvas — left-to-right ranked layout (auto-layout,
  not free-form): nodes as cards, dependency edges drawn with the ADF
  colour code (green success / red failure / grey completion), containers
  as boxes enclosing their sub-graphs, parallel activities stacked in the
  same rank. Drag from palette to a rank; drag an edge handle between
  nodes; click an edge to cycle its type.
- **Right**: the property pane for the selected node — spec-sheet driven:
  required fields first (marked), optionals collapsed, context toggle,
  runs-as, budget, on-fail default. One pane, every detail.
- **Top**: the gallery/assignment bar — template vs clone badge +
  version/provenance, enabled switch, trigger, run window, Start/Stop.
- Observed lighting stays: last run's path + per-node outcome glyphs on
  the same canvas.

## 8. Stories added (S31+)

| # | Story | Oracle |
| --- | --- | --- |
| S31 | Assign the ticket-to-merge TEMPLATE to repo B; edit the clone's QA stage; template unchanged; repo A's clone unchanged. | provenance + divergence badge; three artifacts differ correctly |
| S32 | Save a tuned clone back as a NEW template ("ticket-to-merge-strict"). | gallery gains it; original template untouched |
| S33 | Parallel docs+tests: after the coding loop, "update docs" and "extend tests" run in parallel, both must succeed before the PR node. | two sessions overlap (structurally proven); PR waits on both success edges |
| S34 | Failure edge: any QA check fails → notify + park path runs; success path skipped. | red edge traversal in the run journal |
| S35 | For-each over `src/legacy/*.js`: transform each, max_parallel 3, then one summarize. | N child runs, bounded 3; single digest after |
| S36 | Run window 22:00–06:00 graceful: a run straddling 06:00 finishes its activity then stops. | no new dispatch after 06:00; clean stop logged |
| S37 | Toggle an activity to `context: own`; its session shows no CLAUDE.md load. | session log lacks project context; token drop |

## 9. Build phases (re-baselined)

1. **P1 — pipeline document + compiler + runner (linear + containers)**:
   schema, per-node briefs, sequential DAG walk (no parallelism yet),
   caps enforced. Legacy roles auto-wrap.
2. **P2 — dependencies + failure edges + parallel dispatch** (bounded).
3. **P3 — the canvas editor** (auto-ranked DAG + property pane + palette).
4. **P4 — gallery/assignment + versioning + run windows.**
5. **P5 — for-each + wait/watch enforcement + the long-tail catalog.**

Mockup v5 (`mockups/2026-07-08-loop-canvas-mockup.html`): the DAG canvas
with typed edges, a parallel rank, containers, the property pane and the
gallery bar — the review artifact for this spec.

## 10. Adopted from the field (Av1dlive "Agentic OS" guide, 2026-07-08)

External design reviewed at operator request. Two concepts we lacked,
adopted; four expressible as starter-pipeline patterns, catalogued.

### Trust ledger — graduated autonomy, earned per pipeline (ADOPT)

Autonomy is measurable, not configured: each ASSIGNMENT carries a trust
tier computed from its run journal —
- **watch** (default): outcomes queue for review; nothing ships unattended
  (merge-affecting terminal activities park instead of executing).
- **auto**: earned at ≥20 runs with ≥95% pass; ships unattended.
- **Demotion is automatic** on pass-rate decay, with an alert — never a
  silent tier change.
The run journal (P1) already records per-run outcomes; the ledger is a
projection over it. UI: the tier as a chip on the assignment bar with its
run/pass counts — trust is visible, not vibes. Supervision LEVELS wrap the
fleet (the guide's 30-day arc, generalised): L1 manual runs · L2 triggers
on but terminal activities queue · L3 one assignment auto · L4 proposals
allowed. Levels are an OPERATOR dial, tiers are EARNED per assignment.

### Standing goals — done work becomes invariants (ADOPT)

Completed work graduates into perpetual verification: a new activity type
**invariant** — a DETERMINISTIC predicate (shell command; exit 0 holds,
exit 1 violated; enforced, no model in the loop) — plus a shipped starter
pipeline `standing-goals` (cron: run every registered invariant → on
failure edge: notify + open a regression ticket). Pipelines can end with
a "register invariant" activity so a finished goal deposits its own guard.

### Expressible patterns (no new machinery — starter pipelines)

- **Quorum**: N parallel cheap `decide` activities → branch on 2-of-N
  agreement → only then wake the expensive brain. (parallel + branch.)
- **Ratchet**: invariant with a stored baseline — metric must be ≥ last
  recorded value; updates baseline on success. (invariant + journal.)
- **Sparring**: scheduled builder-vs-breaker pair — one agent builds a
  claim, an opposing agent attacks it; disagreement → ask-human. (two
  stages + branch.)
- **Compost**: weekly retro — gather the run journal's failures →
  summarize ≤3 proposed system improvements → ask-human signature. (our
  prevention-log habit, automated as a pipeline.)

Already covered elsewhere, validated by the guide: cheap-triage →
expensive-decide → cheap-workers → fresh-verifier (the reference pipeline
+ fingerprint gate + pair economics); "a bash script holds final
authority" (= safe_merge + the enforced/instructed split).
