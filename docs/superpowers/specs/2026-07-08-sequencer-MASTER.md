# MASTER — the agentic pipeline sequencer (ingest this first)

One-day design arc, operator-driven, 2026-07-08. This is the entry point
for any session picking the work up: read this, then the referenced specs
in order. The operator's one-line product:

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
5. **Mockup**: `docs/superpowers/mockups/2026-07-08-loop-canvas-mockup.html`
   (v4 — the reference pipeline, clickable) · artifact
   https://claude.ai/code/artifact/70d11a3c-ec6c-4bc8-b596-bd303066ca17 ·
   v5's DAG-canvas mockup is SPEC'D (v5 §7) but not yet built — it is
   build-phase P3's blueprint, worth mocking before P3 starts.

## What is ALREADY BUILT AND MERGED (today's shipped substrate)

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

P1 pipeline document+compiler+sequential runner (legacy roles auto-wrap) →
P2 dependency edges + failure paths + bounded parallel dispatch →
P3 the DAG canvas editor (+ its mockup first) →
P4 gallery/assignment/versioning + run windows →
P5 for-each + wait/watch enforcement + catalog long tail.

Engine invariants unchanged throughout: bash 3.2 floor · stdlib only ·
fail-safe never fail-open · merge only via safe_merge · loop barred from
guardrail files · honesty NOTEs for any knob validated-but-unconsumed.

## Open questions for the operator at P1 kickoff

- Confirm the v5 asset/versioning semantics read right (template pin +
  divergence badge, no silent fleet updates).
- Pipeline document format: JSON chosen (stdlib, no comments) — briefs live
  as sibling .md files; OK?
- First shipped starter pipelines: ticket-to-merge (the reference),
  board-groom, pr-qa-sweep, research-digest — right four?
- The v5 DAG-canvas mockup should be reviewed BEFORE P3 (same artifact
  URL will be reused).
