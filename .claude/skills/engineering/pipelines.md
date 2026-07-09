# pipelines — the sequencer subsystem map

## When to use

Touching `lib/pipeline.py`, `.autonomy/pipelines/`, the supervisor's
dispatch path, the `/pipeline` canvas page, or anything the run journal /
trust ledger feeds. **Functional spec (production, no process jargon):
`docs/pipelines.md`** — read that first if the system is new to you.
Engineering entry point: `docs/superpowers/specs/2026-07-08-sequencer-MASTER.md`
(shipped table + decisions) → v5 design doc → the P1/P2a/P2b/P3a plan docs
in `docs/superpowers/plans/`.

**Vocabulary decoder** (used across this repo's docs): `P1…P5` = the
sequencer's build phases, defined in the MASTER spec's shipped table ·
`SD-N` = numbered entry in `docs/settled-decisions.md` ·
`prevention-log #N` = numbered entry in `docs/review-prevention-log.md` ·
`CP1/CP2/CP3` = the three Codex checkpoints (`codex-checkpoints.md`).
References like "(SD-36)" are provenance — the sentence should stand
without them; look one up only when you need the full ruling.

## The document (one per pipeline, JSON, stdlib-parsed)

`.autonomy/pipelines/<name>/pipeline.json` + sibling brief `.md` files:
`{name, version, trigger_default?, caps{max_sessions_per_run, max_parallel?},
nodes[{id, type, brief_ref|legacy_prompt, runs_as?, context?, join?}],
edges[{from, to, on, back?, max_bounces?}], containers[{id, kind: loop|stage,
children, exit_when?, max_rounds?, runs_as?, join?}]}`.
Binding: `roles.<r>.pipeline: <name>`; unbound roles auto-wrap
(`wrap_role`) into a one-node doc — ONE dispatch path for everything.

- `validate_doc` returns a LIST of error strings (`[]` = valid) and REFUSES
  unknown keys / deferred machinery (honesty invariant; prevention-log #3).
- **`SPEC_SHEETS` is the activity-catalog SSOT** — `NODE_TYPES` and
  `DEFERRED_NODE_TYPES` are DERIVED from it. `DEFERRED_NODE_TYPES` is a
  `dict[type -> refusal reason]` (the validator indexes it for messages) —
  do not "simplify" it to a set.
- `valid_pipeline_name` is the ONE binding charset gate — dispatch
  (`resolve_pipeline`, raises) and the dashboard viewer (degrades) share it.
- `effective_edges(doc)` = declared edges or the synthesized implicit
  success-chain; `start_run` and the canvas both consume it — never
  re-derive the chain elsewhere.

## The walk (fmt-2 state machine)

CLI: `validate · wrap · start · next · ready · record · ledger`. The
supervisor drives `start` → `ready` (returns the batch of dispatchable
nodes; a sequential pipeline is a batch of 1) → `record` per completed
session. `next` is the older single-step form the batch protocol
superseded — still in the CLI for tests, not called by the supervisor.
One DISPATCH per supervisor iteration; a dispatch may fan out to
`caps.max_parallel` concurrent node-sessions, each in its own ephemeral
worktree because two sessions sharing a checkout collide on the git index
(SD-36).
State: `var/autonomy-logs/.pipeline-run-<role>[--<lane>].json` — unit
statuses `pending|dispatched|success|failure|skipped` (never "running"),
`fmt: 2` enforced (fmt-less in-flight state REFUSES). Semantics: typed
edges success/failure/completion; `join: all|any`; skip propagation;
verdict file `{"exit": bool}` (loop exit) and/or `{"outcome":
"success"|"failure"}` (branch channel); back-edges are traversal-only with
enforced `max_bounces`, target must be an ancestor loop/stage; container
outcomes fire container edges; unhandled failure fails the run; caps land
`capped`. Full rules: the P2a plan's "semantic decisions" section.

## Journal + ledger

`var/autonomy-logs/journal.jsonl`, one line per RUN (never per bounce);
node entries carry `id/type/outcome/unit/via/session_log` + optional
`bounce/round/verdict_*`. `ledger(journal, role, name)` projects
`{runs, passes, tier}` per ASSIGNMENT — total reader, junk lines reduce
evidence toward `watch` (the safe side).

## Two failure disciplines (the P3a lesson)

- **Dispatch raises**: `resolve_pipeline`/`load_doc` raise `PipelineError`
  — a broken doc must never run (fail-safe).
- **Display degrades**: `dashboard_state.build_pipeline_view` is the
  route's TOTALITY boundary — every call it makes is guarded, errors become
  payload fields, invalid docs render their errors with the doc visible
  (never a healthy fallback). Same data, two consumers, two disciplines —
  keep both; see prevention-log #21 before "fixing" one guard.

## Viewer + editor (`/pipeline`)

`GET /api/pipeline?repo=<managed-abs-path>&role=<role>` (ws-prompt identity
contract) returns the view dict + `spec: SPEC_SHEETS` + a `briefs` map (bounded
brief texts, so the editor pane seeds a true edit). The page treats node ids as
UNTRUSTED (invalid docs render): delegated `data-*` listeners, full-coverage
`esc()`. Fixture: `tests/fixtures/repo-alpha` binds `coder → fixture-flow` and
ships a walker-shaped `journal.jsonl`; tests needing an unbound role take tmp
copies. **Editing (P3b, #365, SD-37)**: a BOUND pipeline is editable and
`Save`s the whole doc to the var-shadow via `POST /api/control` action
`pipeline_save` (token-gated, oversize-body-allowed like `ws_prompt_set`); a
wrapped role stays read-only. `WORKING` is a dirty working copy the canvas/pane
render from (`curDoc`/`curEdges`); a live tick never clobbers unsaved edits (the
#202 bar). `effective_pipeline_dir(repo, name)` (the SD-34 shadow resolver) is
consulted by BOTH `resolve_pipeline` and `build_pipeline_view`. The writer
`dashboard_control.pipeline_save` re-uses `structural_write`'s discipline for a
DIRECTORY asset: gitignore guard, name==folder + charset gates, seed-from-valid-
shadow-else-committed (no laundering), staging from the doc's own brief_refs,
re-validate + deep-compare, reader-safe install (pipeline.json last), snapshot
rollback. Present-but-invalid shadow refuses, never falls back.

## Still deferred (validator refuses, honestly)

`wait_watch/ask_human/handoff/run_command` types, `branch`/`for_each`
containers, intra-container edges, `context: own`. Canvas EDITING SHIPPED (P3b,
#365, SD-37 — var-shadow write path); still deferred there: minimap + search
(P3c), full brief round-trip / reset-shadow-to-committed / provenance diff, and
binding-a-new-pipeline from the canvas (P4 gallery).
