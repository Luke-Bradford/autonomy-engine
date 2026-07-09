# MASTER — the agentic pipeline sequencer (internal build record)

**Audience note: this is an ENGINEERING RECORD** — it organizes the work
by build phases (P1…P5) and decision numbers (SD-N) and assumes the
process context in `docs/README.md`'s "Engineering records" section. To
learn what the pipeline system IS and how it behaves, read
**`docs/pipelines.md`** (the production spec) instead — it needs none of
this vocabulary.

Design arc 2026-07-08; build P1–P3a shipped 2026-07-08/09. Entry point for
any engineering session picking the work up: read the "Shipped" table for
CURRENT state, `.claude/skills/engineering/pipelines.md` for the runtime
map + gotchas, then the referenced specs for the full model. The one-line
product:

> A person running Claude on their own computer points this at a repo,
> builds/assigns pipelines of agentic activities (ADF-style: DAG,
> dependencies, loops, parallel), and lets them run on triggers — watching
> and steering from one page, never touching a config file.

## Read in this order

1. **`2026-07-08-agentic-sequencer-design.md` (v5 — CURRENT)** — the full
   model: pipeline assets + gallery, assignment-clone versioning, typed
   dependency DAG (success/failure/completion), parallel dispatch,
   loop-until + for-each + stage + branch containers, run windows w/
   graceful/hard stop, the activity catalog with per-activity spec sheets
   (required/optional fields, context inheritance, guarded toggles),
   persistence format, execution semantics, prior-art survey, build phases
   P1–P5, stories S31–S37.
2. **`2026-07-08-pipeline-model-design.md` (v3+v4)** — the step/activity
   catalog detail (15 types, 6 groups), before/cycle/after anatomy
   (subsumed by DAG containers but the step semantics stand), custom step
   library, per-step on-fail, the operator's reference ticket-to-merge
   pipeline, stories S21–S30.
3. **`2026-07-08-personalities-and-setup-design.md`** — agents as library
   entities ("personalities"), the 5-minute setup wizard, progressive
   disclosure rule, activity visibility; stories S1–S20. Agents = WHO runs
   an activity (v4 correction).
4. **`2026-07-08-loop-canvas-design.md`** — mostly superseded by v4/v5;
   still authoritative for: the honesty split (enforced / instructed /
   observed), the fallback-per-brain constraint (one --effort per CLI
   session; thinking brain has NO subagent fallback upstream — never fake
   the knob), loop-type presets wording.
5. **Mockups**: `docs/superpowers/mockups/2026-07-08-loop-canvas-mockup.html`
   (v4 — the reference pipeline, clickable) and
   `docs/superpowers/mockups/2026-07-08-dag-canvas-mockup.html` (v5 §7 —
   the P3 blueprint, operator-reviewed in two depth rounds, #347/#348) ·
   artifact (same URL both rounds)
   <https://claude.ai/code/artifact/70d11a3c-ec6c-4bc8-b596-bd303066ca17>

## SHIPPED — the sequencer itself (state as of 2026-07-09)

| Phase | PR → issue | What runs today | Plan doc (`docs/superpowers/plans/`) |
| --- | --- | --- | --- |
| P1 | #346 → #345 | pipeline document + validator (refuses what it can't honor) + compiler-to-briefs + sequential runner; run journal w/ trust-ledger fields; legacy roles auto-wrap; starter `ticket-to-merge` | `2026-07-08-sequencer-p1-pipeline-runner.md` |
| P2a | #350 → #349 | typed edges success/failure/completion, join all\|any, skip propagation, verdict `{"outcome"}` branch channel, traversal-only back-edges w/ enforced bounce caps, container-level outcomes — ONE walk engine, fmt-2 state (SD-35) | `2026-07-09-sequencer-p2a-typed-edges.md` |
| P2b | #352 → #351 | bounded parallel dispatch: one DISPATCH may fan out to `caps.max_parallel` node-sessions (SD-36), ephemeral worktrees under `var/autonomy-worktrees/`, cron/event multi-node lift, batch `ready` protocol | `2026-07-09-sequencer-p2b-parallel-dispatch.md` |
| — | #354 → #353 | `engine.default_branch` knob at every detach/merge-base site (repo-agnostic default branch) | (small fix, no plan doc) |
| P3a | #358 → #357 | `/pipeline` read-only canvas: `SPEC_SHEETS` catalog SSOT (validator vocab derived), auto-ranked DAG + containers + collapse, schema-driven pane, observed lighting from the journal, total `build_pipeline_view` | `2026-07-09-sequencer-p3a-canvas-viewer.md` |

**NEXT = P3b (canvas editor + save path).** Decisions LOCKED in the P3a
plan doc ("P3 phase decisions" pt 8): var-shadow `var/autonomy/pipelines/`
per the SD-34 model (committed-pack edits are stash-swept by preflight —
a shadow is the only edit home that survives), one
`effective_pipeline_dir` resolver consulted by dispatch AND dashboard,
`pipeline_save` action through `/api/control` with SD-29 writer mechanics
(validate → atomic → re-load-compare, gitignore guard), dirty
working-copy protection (#202 bar), minimap/search. A new
settled-decision entry rides the P3b PR. Kickoff answers on record: #345.

**Still honestly deferred** (validator refuses; palette shows them
disabled): `wait_watch`/`ask_human`/`handoff`/`run_command`,
`branch`/`for_each` containers, intra-container edges, `context: own`,
gallery/assignment/versioning + run windows (P4), for-each + catalog long
tail (P5).

## Pre-sequencer substrate (shipped 2026-07-08, context for the above)

- **Token efficiency**: fingerprint gate + idle backoff (#318/PR #321);
  token-hygiene rails (#319/#322); planner/coder pair default (SD-33,
  #320/#323 + materializer in #333).
- **SD-34 write substrate** (PR #331): var-live config shadow
  (`var/autonomy/config.yaml`), `config_parser.effective_config_path`
  single resolver (every bash+python reader), `structural_write` /
  `live_scalar_write` / `_create_scalar` in dashboard_control, overlay
  retired, fingerprint includes the shadow.
- **Config page**: 3-zone layout (#332); pair configurable end-to-end —
  `agent.planner.model` + supervisor `materialize_planner()` (#333);
  workstream authoring — `ws_add/ws_set/ws_prompt_get/set/repo_init`,
  trigger editor, human cron, `manual` trigger type (#334/#335); two-brain
  card + plain labels (#336); accounts legibility + local-LLM end-to-end +
  per-workstream "runs as" (#337).
- **safe_merge #301 fix** (PR #324) + prevention-log #20 (GitHub's closing
  grammar is negation/quote-blind — probe `closingIssuesReferences`
  pre-merge, never write keyword+#N for open issues).
- Loops are PAUSED fleet-wide by operator directive until this config
  surface is right.

## The build plan (P-phases from v5, each TDD + browser-verified)

P1 ✅ → P2a/P2b ✅ → P3a ✅ (see the Shipped table) →
**P3b canvas EDITING + save path (next)** →
P4 gallery/assignment/versioning + run windows →
P5 for-each + wait/watch enforcement + catalog long tail.

Engine invariants unchanged throughout: bash 3.2 floor · stdlib only ·
fail-safe never fail-open · merge only via safe_merge · loop barred from
guardrail files · honesty NOTEs for any knob validated-but-unconsumed.

## Kickoff questions — ANSWERED on record (#345, 2026-07-08)

Versioning as spec'd (template pin + divergence badge, no silent fleet
updates) · JSON + sibling `.md` briefs · starter four (ticket-to-merge,
board-groom, pr-qa-sweep, research-digest) · one dispatch path via
auto-wrap · trust ledger + standing goals adopted (v5 §10), ledger fields
in the run journal from P1 day one · v5 DAG mockup reviewed pre-P3
(#347/#348 depth rounds). P2 split (SD-35) + SD-12 amendment (SD-36)
decided at P2 kickoff, #349/#351.
