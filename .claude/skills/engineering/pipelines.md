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
- Typed `params`/`outputs` + the `${…}` resolver are LIVE in dispatch
  (Phase B, #374): `check_refs` validates every `${…}` statically inside
  `validate_doc` (declared params only, secret refs refused, node-output
  refs upstream / earlier-sibling / soft-via-`default()` per Phase C,
  closed run fields, static function arity;
  `brief_ref`/`legacy_prompt` stay ref-free — they are paths), and
  `_prepare_step` substitutes node fields + composed brief text at
  prepare time with a POST-substitution concrete re-check that REFUSES
  (never warn-and-drop). Per-node outputs sidecars
  (`.pipeline-run-<x>.<node>.outputs.json`, derived like the verdict
  file) feed `${nodes.<id>.output.*}`; a brief whose node has a
  downstream consumer gains a `pipeline:outputs` footer.

## Triggers (`lib/triggers.py`, Phase B #374 + Phase C #376)

The supervisor enumerates TRIGGERS, not roles: native
`.autonomy/triggers/<name>.json` files (schema in `validate_trigger`;
SD-34 var-shadow via `effective_trigger_path` — file asset, symlinked
shadow ignored, invalid shadow refuses) + `shim_triggers` synthesised
from `roles:` (loop→continuous, cron→schedule, event→event with
`events_csv`, a shim-internal field). A native file supersedes its
same-name shim; a BROKEN native file refuses AND keeps the shim
suppressed (never fall back to role dispatch). CLI:
`dispatch/cron/event/manual/show/validate/trust` (the four
dispatch-facing verbs -- dispatch/cron/event/manual -- filter by
`run_windows`; every verb takes a `--now <epoch>` digits-only test
seam). Firing modes:
continuous/schedule/manual/event — event carries `firing.event` (closed
vocabulary `pr.opened/issue.created/merge.done/pr.synchronize`;
`session.done` is shim-internal) + `firing.map {param: item|sha|event}`
(sha = pr.synchronize only; map∩params refused; secret targets refused
at start). `resolve_trigger_event_wakes` is the ONE event resolver: shim
lane = the legacy `_event_role_wakes` body VERBATIM (same seen files);
native lane = START-ONLY, one run per new token via `pipeline.py start
--kind native --event-field` (never `run_session` — SD-12 exact; seen
advances per STARTED token, prunes to the poll page; at-capacity/failed
starts redeliver).
Supervisor side: dispatch tokens `name[@slot]` (slot 0 = legacy
filename), `inflight_tokens` (strip `@slot` FIRST, then `--lane`;
RESERVED sidecar suffixes `.outputs/.verdict/.outcome` are skipped —
they share the state-file glob — and the mint sites refuse names ending
in them), `run_session <token> <kind>` (`shim` = the role path
byte-identical; `native` = no role settings, runs_as from the doc),
per-trigger markers under `var/trigger-ctl/{fire,queued,stop,backoff}/`,
enumeration failure = idle tick (SD-12's coder fallback RETIRED). State
gains `trigger`/`kind`/`params`/`run`; journal carries `trigger`,
`parent_run` and (Phase E) `kind` -- the ledger was re-keyed on
`trigger` in Phase E (shim trigger name == role name BYTE-EQUAL is what
makes the grandfather clause sound).

## Child runs + secrets (Phase C #376, SD-40)

`call_pipeline` spawns a CHILD run: an ordinary run whose state file
`.pipeline-run-<parent>.c<slot>.<node>[--lane].json` joins
`inflight_tokens`, so the main loop advances it with zero new dispatch
machinery. Parent↔child signalling = ONE sidecar
(`<child-base>.outcome.json` `{run_id, outcome, outputs}`, written in
`_finish` BEFORE the journal); the parent's ready sweep
(`_sweep_call_units`) consumes it, records the call unit through the
same via/back-edge/skip rails, and republishes the outputs as the call
node's OWN outputs sidecar (`${nodes.<call>.output.*}` rides the Phase B
machinery unchanged). The session cap RESERVES a unit at call START
(`_start_call_unit`); child liveness is EARNED
(`status == in_progress`); vanished child = restart, done-marked child
without a sidecar = failure (never an eternal wait). `ready` prints
`WAITING` when only children are outstanding → supervisor `PIPE_WAIT`
paced no-op (not the error arm). `MAX_CALL_DEPTH = 3`; `call_path`
refuses cycles; `_check_call_name_headroom` refuses over-long names at
run start. Findings-return: back-edge-visible outputs are legal ONLY as
`default()`'s first argument (`MissingNodeOutput` is the one tolerated
error class); earlier same-container siblings + upstream-container
children are statically referenceable.
Secrets: a secret param's value is a credential LABEL (SD-8); the ONLY
sink is a node's `secrets: {ENV_VAR: ${params.<name>}}` map (exact-ref
rule, env-var denylist); `_prepare_step` emits `NODE_SECRET=VAR=label`
lines; the supervisor resolves label→value FOREGROUND
(`resolve_node_secret_env`, refuse-on-failure, newline values refused),
exports subshell-scoped, and `redact_session_log` scrubs values (fed via
STDIN) after classify. Secret-typed params are STRIPPED from the
substitution context; `${params.<secret>}` anywhere else refuses.

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
`bounce/round/verdict_*`. `ledger(journal, trigger, pipeline_name=, native=)` projects
`{runs, passes, tier}` per TRIGGER (Phase E, SD-41) — total reader, junk
lines reduce evidence toward `watch` (the safe side). Grandfather
clause: a line with NO `trigger` field (or `""`) counts only for a SHIM
(`native=False`) whose name equals the line's `role`; natives earn from
zero; `parent_run` lines (call_pipeline children) never count; the
additive `kind` field records shim/native provenance per line.
`triggers.trust_rollup(repo, journal)` enumerates with
`dispatchable_only=False` (disabled/off-lane still counted) and floors
each pipeline to `auto` only when ALL its triggers are `auto`; the
`trust` CLI verb prints TRIGGER rows + REFUSED rows (unattributable
refusals surface ON STDOUT) + PIPELINE rollup rows.

## Run windows (Phase E, SD-41)

`run_windows: [{start, end, days?}]` on a native trigger, validated in
`validate_trigger` (HH:MM UTC, wrap past midnight when end <= start,
`days` names the window's START day, <=16 windows, explicit `[]`
refused; `_apply_defaults` synthesises `[]` = always).
`in_run_window(trig, epoch)` is the ONE membership predicate --
fail-CLOSED on any junk shape. The gate lives at the four
dispatch-facing CLI verbs, so NEW starts are blocked while in-flight
tokens keep advancing (they never pass enumeration). `show` prints
`WINDOW=open|closed`; supervisor `_trigger_show_fields` inits
`SHOW_WINDOW=closed` and only the literal `open` opens; manual fire
markers + queued fires DEFER (marker kept) while closed. Accepted
bounds: one-tick end-boundary precision; first-sight at window-open
seeds without firing.

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
brief texts, so the editor pane seeds a true edit). Phase D1 (#383) grew
EXACTLY-ONE selectors: `name=` (by pipeline — gallery cards/native triggers
have no role; ledger None, trust lives on `/api/triggers`) and `token=`
(one run's state file under the canonical token grammar; renders the run's
EMBEDDED doc as degraded truth + a `run{}` block w/ `parent_token`
breadcrumb). The page has four tabs (gallery/triggers/runs/canvas); the
list tabs render `GET /api/triggers` (= `build_triggers_view`: trigger
cards + per-trigger tiers + rollup + REFUSED verbatim + `list_runs`)
behind their own raw-bytes guard. Lifecycle: `/api/control` actions
`trigger_fire`/`trigger_stop`/`trigger_resume` write the supervisor's
lane-scoped `var/trigger-ctl/{fire,stop}/` markers (`marker_basename` in
lib/triggers.py is the one basename rule both sides share;
`queued/`+`backoff/` stay supervisor-owned/read-only; fire is
manual-mode-only, gated by `trigger_fire_ready` = the same dry
resolve_params verdict the payload shows). **D2 (#383) shipped trigger
AUTHORING**: `trigger_save` = the SD-29 writer over the SD-34 trigger
FILE shadow `var/autonomy/triggers/<name>.json` (validate_trigger-before,
gitignore guard, allow_nan=False canonical serialize + re-parse compare,
O_EXCL no-follow atomic install; binding/params problems WARN on success
— a save must be able to disable a trigger whose pipeline vanished); the
⚡ tab's create/edit form + enabled toggle ride it (a shim edit/toggle
MATERIALISES a native file after a confirm naming the execution-semantics
flip; wrapped-role + multi-event shims refuse honestly). Run-now gained
the PARAMS channel: the fire marker's BODY is a validated JSON payload
(precedence: pipeline default < trigger saved < payload; secrets refused
at write/firecheck/start — three layers, one rule);
`resolve_manual_fires` classifies a non-empty body via `triggers.py
firecheck` (rc 3 = deterministically bad → marker removed loudly; rc 1 =
transient → kept) and threads the marker path through
`run_session`/`resolve_pipeline_ready` into `pipeline.py start
--params-file`. `fire_params_check` dry-runs
`pipeline._resolve_run_params` twice (merged vs saved-only) so the
verdict is start-parity by construction. Payload projections:
`pipelines[].params` + `triggers[].fire_params` (`_declared_params` /
`_bound_doc`). Still deferred: trigger delete / reset-shadow-to-committed
(disable or remove the shadow by hand), run-now on non-manual modes. The page treats node ids as
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
#365, SD-37 — var-shadow write path); canvas NAVIGATION SHIPPED (P3c, #367,
SD-38 — minimap + search/filter, client-only over `curDoc()`, no new payload/
write surface; minimap gates on HORIZONTAL overflow only; zoom deferred to keep
the editor's `getBoundingClientRect` gesture geometry unscaled). Still deferred
on the canvas: reset-shadow-to-committed and provenance diff (both need a write
surface or a new payload), canvas zoom, and binding-a-new-pipeline (P4 gallery).
Full brief round-trip already shipped in P3b (`VIEW.briefs` + `briefText`).
