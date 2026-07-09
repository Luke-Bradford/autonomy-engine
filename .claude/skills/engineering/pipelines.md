# pipelines — the sequencer subsystem map

## When to use

Touching `lib/pipeline.py`, `.autonomy/pipelines/`, the supervisor's
dispatch path, the `/pipeline` canvas page, or anything the run journal /
trust ledger feeds. Spec: `docs/superpowers/specs/2026-07-08-sequencer-MASTER.md`
(entry point) → v5 design doc. Build history: the P1/P2a/P2b/P3a plan docs
in `docs/superpowers/plans/`.

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
supervisor drives `start` → `ready` (the batch protocol; a sequential
pipeline is a batch of 1 — `next` is the P1-era single-step form, kept for
tests) → `record` per completed session. One DISPATCH per iteration; a
dispatch may fan out to `caps.max_parallel` concurrent node-sessions in
ephemeral worktrees (SD-36; SD-12 amended).
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

## Viewer (`/pipeline`, read-only until P3b)

`GET /api/pipeline?repo=<managed-abs-path>&role=<role>` (ws-prompt identity
contract) returns the view dict + `spec: SPEC_SHEETS`. The page holds no
control token, POSTs nothing, and treats node ids as UNTRUSTED (invalid
docs render): delegated `data-*` listeners, full-coverage `esc()`. Fixture:
`tests/fixtures/repo-alpha` binds `coder → fixture-flow` and ships a
walker-shaped `journal.jsonl`; tests needing an unbound role take tmp
copies.

## Still deferred (validator refuses, honestly)

`wait_watch/ask_human/handoff/run_command` types, `branch`/`for_each`
containers, intra-container edges, `context: own`, canvas EDITING (P3b:
var-shadow `var/autonomy/pipelines/` per SD-34, `pipeline_save` via
`/api/control` — decisions locked in the P3a plan doc, pt 8).
