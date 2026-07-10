# Pipeline+Trigger model — Phase C: `call_pipeline` + child runs + event triggers + the secret env channel

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Audience note (engineering record):** this is a build plan for the engine's own
> development loop. It cites SD-N (docs/settled-decisions.md), prevention-log #N
> (docs/review-prevention-log.md) and CP1/CP2/CP3 (codex-checkpoints skill).
> The product-layer description of what this ships lands in `docs/pipelines.md`
> (Task 11), written without any of that jargon.

**Goal:** a pipeline can invoke another pipeline as a real child run and consume its
typed outputs (`call_pipeline`, spec §4); event-bus firing becomes a trigger mode and
the legacy per-role event path retires (spec §5); `secret`-typed params gain their
first legitimate sink — a per-node env channel with engine-side redaction (spec §3.1
"secrets-last") — and everything Phase B refuses stays refused everywhere else.

**Architecture:** child runs are ordinary runs. A `call_pipeline` node starts a child
state file whose name joins the existing `inflight_tokens` glob, so the main loop
advances the child with zero new dispatch machinery (SD-12/SD-36 untouched); parent
and child signal through one new sidecar (the child parks `{outcome, outputs}` at
finish; the parent's `ready` sweep consumes it, records the call unit, and republishes
the child's projected outputs as the call node's own outputs sidecar — so
`${nodes.<call>.output.*}` resolves through the Phase B machinery unchanged). Event
firing reuses the W2 poll/seen-set engine: shimmed event roles ride the legacy
semantics verbatim through the same functions; native event triggers fire one run per
new token with the payload mapped to params inside `start_run_trigger`. Secrets never
leave the supervisor: a secret param's *value* is a credential **label** (SD-8: index
names are non-secret), the label travels through state/ready-blocks, and only the
supervisor resolves label→value (`credentials.py get`, foreground, fail-safe) directly
into the session's scoped env.

**Tech stack:** Python 3 stdlib only (`lib/pipeline.py`, `lib/triggers.py`);
macOS bash 3.2.57 (`bin/supervisor.sh`); unittest + sourced-script shell tests.

> **Codex CP1 run and folded (2026-07-10, 12 findings).** The two structural
> ones reshaped decisions 4 + 14: the session cap is RESERVED at call start
> (not counted at consumption), and native event fires are START-ONLY (no
> `run_session` in the resolver — SD-12 stays exact). Also folded: earned
> child-liveness (`status == in_progress`, never file-exists), start-time
> child-name headroom check, `secrets`-on-call-node single-error ordering,
> stdin-fed redaction (values never in a child env — `ps` inspection),
> newline-bearing secret values refused, per-log batch redaction values,
> the supervisor-side NODE_SECRET denylist twin, duplicate `--event-field`
> refusal, and `[[:space:]]` in the structural grep (BSD grep has no `\s`).
> One finding was already covered (dispatched plain units re-emit as steps,
> so WAITING cannot mask reclaim) — pinned with an explicit regression test
> (`test_reclaim_coexists_with_waiting_call`) rather than argued.

## Global Constraints

- macOS `/bin/bash` 3.2.57 floor: no `mapfile`, no `**`, no `declare -A`, no
  `${var,,}`. (CLAUDE.md; SD-1.)
- Python 3 **stdlib only** (SD-2). Config parsing via `lib/config_parser.py`.
- Every script's executable body guarded by `[ "${BASH_SOURCE[0]}" = "${0}" ] || return 0`.
- `shellcheck -S warning` clean, tests included.
- Tests are genuine: source the real script / import the real module; stub only at
  the established seams (`gh`, `_roles_enumerate`, `_triggers_enumerate`,
  `_event_poll`, `AUTONOMY_CREDENTIALS_BIN`). (SD-20.)
- Repo-agnostic: nothing repo-specific in `bin/`/`lib/` (SD-3).
- Fail-safe, never fail-open (SD-4): every unresolvable artifact REFUSES with a
  named reason; the reassuring verdict is earned (prevention-log #18).
- **Hard rails for this phase (kickoff directive):** `bin/safe_merge.sh` +
  `.github/workflows/**` untouched; a broken trigger never falls back to role
  dispatch; trust stays keyed per-assignment until Phase E; the dashboard keeps the
  role view until Phase D.
- Loops stay PAUSED fleet-wide throughout the build.

---

## Settled decisions + prevention-log entries binding this plan

Applicable and how:

- **SD-39** (triggers are the dispatch unit): the substrate. Phase C *amends* it in
  one narrow, pre-announced way: the **event-collision refusal exists only because
  event roles are un-shimmed**, and it retires in the same commit that lands event
  triggers (Task 10). SD-39's own text anticipates this ("event triggers land in
  Phase C"). Everything else in SD-39 — no fallback to role dispatch, shim
  name==role byte-equality, invalid-shadow-refuses — is preserved and re-tested.
- **SD-12/SD-36** (one DISPATCH per iteration; fan-out to enforced `max_parallel`;
  ephemeral worktrees): untouched. Child runs are *additional in-flight tokens*, not
  a new dispatch shape; the loop still runs one dispatch per tick.
- **SD-8** (secrets in the macOS Keychain; index files hold names/kinds/labels only;
  never argv, never logs): the entire secret-channel design is derived from it —
  labels flow, values resolve only in the supervisor, exported subshell-scoped via
  the existing `invoke_scoped_env`.
- **SD-34/SD-37** (var-shadow resolvers): unchanged; child pipelines resolve through
  `effective_pipeline_dir` via `resolve_pipeline_doc` exactly like trigger-started runs.
- **SD-25** (cron/event fire in the default lane unless pinned): event triggers keep
  the lane filter through `enumerate_triggers` (already lane-scoped).
- **Prevention-log #3** (silent fallback = fail-open): child-start failures record a
  named failure on the call unit — never a skipped node; unresolvable secret labels
  REFUSE the session; a corrupt child-outcome sidecar with the child gone records
  failure, never success.
- **Prevention-log #6** (re-validate config-sourced strings at point of use): every
  new supervisor parse (NODE_SECRET lines, event fields, child tokens) is
  charset-gated where it lands in argv/filenames.
- **Prevention-log #7/#11** (no `producer | grep -q` under pipefail): all new bash
  uses capture-then-`case`/here-string.
- **Prevention-log #12** (projections over cached data must be total): the
  child-outcome sidecar reader tolerates any shape; junk lands on the refuse side.
- **Prevention-log #17** (total readers under `set -e`): new config/marker readers
  follow the `|| true` + explicit-default pattern.
- **Prevention-log #18** (safe outcome in the default arm): child outcome mapping —
  only literal `"success"` records success; everything else (failure, capped, junk,
  missing-with-child-gone) lands on failure.
- **Prevention-log #21** (a review fix is a diff too): the same-class scan is a
  named step in every task that widens a guard.
- **SD-19 / codex-checkpoints:** CP1 runs on this plan before it ships; CP2 on the
  build PR's first push; CP3 before any rebuttal-only merge.

Not applicable: SD-27 (guardrail files — untouched here), SD-28/29-as-superseded
(no pack config writes), SD-38 (canvas nav — no UI change this phase).

## Decisions settled in this plan (the Phase C kickoff record)

The operator delegated the open Phase C decisions (kickoff directive). Each is
recorded here with its argument; the PR carries them into SD-40.

1. **Child runs ride the existing token machinery.** A child state file
   `.pipeline-run-<child-name>[--<lane>].json` lands in LOGDIR, so `inflight_tokens`
   emits it and the main loop advances it like any run. No new dispatch path, no new
   scheduler. Child name = `<parent-name>.c<parent-slot>.<node-id>` (charset-legal;
   `c<slot>` disambiguates parallel parent slots; ≤64 chars enforced at child start,
   over-length fails the call node with a named reason).
2. **Parent↔child signalling = one sidecar.** A run with `parent_run` set writes
   `var/autonomy-logs/<child-state-base>.outcome.json` (`{run_id, outcome, outputs}`)
   *before* journalling in `_finish`. The parent's `ready` sweep consumes it, records
   the call unit, republishes `outputs` as the call node's own outputs sidecar, and
   unlinks it. "Child alive" is EARNED from the child state's own
   `status == "in_progress"` (CP1: a done-marked state file — `_finish`'s
   could-not-unlink marker — must not read as alive, or a lost sidecar would
   wait forever). Missing sidecar + live child state = still waiting; missing
   sidecar + NO live child state = external interference → restart the child
   (the dispatched-unit reclaim philosophy); corrupt/missing sidecar + child
   done-or-gone = record failure (prevention-log #18).
3. **`wait` semantics (spec §4):** `wait: true` (default) = unit stays `dispatched`
   until the child outcome arrives; the child's outcome drives the parent's edges
   (success→success, failure/capped/anything-else→failure). `wait: false` = start the
   child, record the call unit **success** immediately, never read its outputs
   (statically refused, decision 7).
4. **The run cap counts call dispatches, RESERVED at start** (CP1: counting only
   at consumption would let outstanding children exceed the cap). STARTING a call
   unit — wait:true or wait:false — does `sessions += 1` in the parent
   immediately; consuming the outcome does not increment again, and `_pick` stops
   starting further call units once the remaining budget is spent (they stay
   pending for the next tick). The `max_sessions_per_run` cap therefore bounds
   child-spawn loops exactly like agent sessions (a back-edge that keeps
   re-calling a child cannot run away). Documented in `docs/pipelines.md` as
   "the cap counts dispatches".
5. **Depth + cycles:** `MAX_CALL_DEPTH = 3`. State carries `call_depth` +
   `call_path` (pipeline names, root→self; absent = 0 / `[doc name]`, so existing
   state files need no migration). A child whose pipeline is already in `call_path`,
   or whose depth exceeds the cap, fails the call node with a named reason.
6. **Child lifecycle:** a child is `kind: "native"` (roles stay dissolved — its
   `runs_as` comes from its own doc), inherits the parent's lane, executes in the
   parent's repo (the `repo` *param* remains data until the control-unit registry
   consumes it — same as Phase B). Per-trigger stop/backoff markers key on the child's
   own token name: stopping the parent freezes the parent only; a live child completes
   (bounded by its own caps) and parks its outcome. Detached (`wait:false`) children
   are fully independent (spec §4). The fleet PAUSE sentinel still holds everything.
7. **Findings-return needs a language decision** (discovered against the substrate):
   today a back-edge must target an ancestor **loop/stage container**
   (pipeline.py:1072) and `_ancestors` excludes back-edges, so the spec §2.1 example
   (`qa --failure,back--> code`, and `code`'s brief reading
   `${nodes.qa.output.findings}`) is *statically refused* on both counts. Decision:
   keep both P2a rules (they are load-bearing: an unconditioned ref to a
   not-yet-run node must refuse), and make the return channel explicit —
   **a back-edge-visible node's outputs may be referenced ONLY as the first argument
   of `default(...)`**, and `default()` gains one narrow runtime tolerance: a
   first-argument resolution failure *of the missing-node-output class only* yields
   the fallback. First visit compiles the fallback; post-bounce visits compile the
   real findings. A typo'd param still raises. The spec's example shape becomes
   `pick → stage[code] → qa(call) --failure,back--> stage[code]` with
   `${default(nodes.qa.output.findings, '')}` in code's brief — expressible today,
   no new edge semantics.
8. **A failed child's outputs still return.** `_collect_node_outputs` (parent side)
   and the child's own run-level projection include `call_pipeline` entries with
   outcome success *or* failure — a failed QA child's findings are exactly the value
   the back-edge loops back. Plain nodes stay success-only (an errored session's
   sidecar is untrustworthy).
9. **Same-container earlier-sibling output refs: BUILD** (the delegated
   decide-and-record item). The walk already runs container children in order and
   `_collect_node_outputs` already serves them; only `check_refs` blocks it. Static
   rule: a node may reference outputs of *earlier siblings in its own container*,
   plus (fixing a latent gap) *children of upstream container units* — today only
   top-level node ids are referenceable. Later siblings stay refused (in a loop that
   would read the previous round's value — nondeterministic freshness; `default()`
   + back-edges is the sanctioned pattern for "value from the future").
10. **Secret params carry credential LABELS, not values.** `resolve_params` for
    `type: secret` validates the value as a label (charset `[A-Za-z0-9._-]{1,64}`)
    and passes it through — the `secret_lookup` seam is deleted, and Phase B's
    would-resolve refusal in `start_run_trigger` retires *in the same commit* that
    lands the sink (the honesty invariant: refuse until the phase that wires it —
    this is that phase). Labels in `state["params"]`/journal are non-secret (SD-8).
11. **The sink is a per-node `secrets:` map** — `{"ENV_VAR": "${params.<name>}"}`,
    value must be EXACTLY a `${params.<secret-typed>}` ref (no interpolation, no
    functions: a secret must never mix into a string), key must match
    `[A-Z][A-Z0-9_]{0,63}` and not shadow engine/auth vars (denylist:
    `ANTHROPIC_*`, `AUTONOMY_*`, `CLAUDE_*`, `LD_*`, `DYLD_*`, and exact
    `PATH HOME SHELL IFS ENV BASH_ENV PYTHONPATH`). Everywhere else,
    `${params.<secret>}` stays refused (check_refs), and secret-typed params are
    stripped from the substitution context (defense in depth: an escaped ref
    raises "unknown param" at prepare). `call_pipeline` nodes refuse `secrets:`
    (a child's own doc declares its sinks); a caller overrides a child's secret
    param with a literal label string.
12. **Redaction boundary:** by construction the value exists only in supervisor
    memory (env lines) and the session's subshell env. Obligations: (a) never
    logged — the resolver logs labels only; (b) refused, never dropped, on any
    resolution failure; (c) a post-session **redaction sweep** replaces every
    resolved value in the session log with `[REDACTED]` (after classify, before
    return); (d) negative tests pin that briefs, ready-block stdout, state files
    and the journal never contain the value. **Documented residual:** an agent that
    echoes a secret exposes it in the live log until the sweep runs — stated in
    `docs/pipelines.md`, same residual as any env-provided credential.
13. **Event trigger schema:** `firing: {mode: "event", event: "<kind>",
    map: {"<param>": "item"|"sha"|"event"}}`. Closed event vocabulary = the four
    external kinds (`pr.opened`, `issue.created`, `merge.done`, `pr.synchronize`);
    `session.done` stays a shim-internal edge (native refusal names it). `sha` maps
    only from `pr.synchronize`. A mapped param may not also be in `trig.params`
    (overlap refused); a map may not target a secret-typed param (refused at start,
    where types are known). `concurrency.policy: queue` is refused for event mode —
    the seen-set's natural redelivery IS the queue.
14. **Native event fires are START-ONLY: one run per new token, NO session in
    the resolver** (CP1: firing `run_session` per token inside the event phase
    would contradict both the durable-claim contract and SD-12's one-dispatch-
    per-iteration — the resolver only writes state files; the main loop then
    advances them as ordinary in-flight tokens). Starts are gated by the
    trigger's concurrency policy; the seen-set advances **per started token**
    (append handled, prune to the current poll page — boundedness preserved); a
    token is "handled" the moment its RUN STARTS (the state file IS the durable
    claim). At-capacity and failed-start tokens are not advanced (redelivered).
    Cost: a native event run's first session lands one loop tick after the fire
    — stated in the honest gaps. Shimmed event roles keep the legacy semantics
    *verbatim* — same functions (`_event_role_wakes` still fires `run_session`
    directly, exactly as today), same page-replace seen advance, same
    one-wake-per-batch, same session.done handling — which is the cutover
    parity argument.
15. **Double-dispatch stays impossible throughout the transition** (the CP1
    question, sharpened): Task 9 builds all native-event machinery while event roles
    remain un-shimmed and both collision refusals stay in force — native event
    triggers validate but nothing fires them, so no window opens. Task 10 is ONE
    commit that simultaneously (a) shims event roles, (b) swaps the main loop to the
    trigger event resolver, (c) retires the legacy role-path call, and (d) removes
    both collision refusals — after it, exactly one enumerator can fire an event
    name, and the refusal's reason for existing is structurally gone. There is no
    intermediate commit where two paths can fire the same name.
16. **Split out (recorded, not built):** onboard/doctor trigger awareness + pack
    trigger starters + a doctor sweep for orphaned child-outcome sidecars → one
    follow-on ticket filed with the build PR (Task 11). Manual fires still have no
    param-override channel (spec §5 "prompts for required params" is the Phase D
    trigger editor). The dashboard keeps the role view (Phase D); tests only pin
    "child/slotted state files never crash it".

## The dataflow after Phase C (orientation)

```text
supervisor tick
  ├─ resolve_trigger_cron_due / resolve_manual_fires / resolve_queued_fires   (Phase B)
  ├─ resolve_trigger_event_wakes                                              (Task 10)
  │    ├─ shim event triggers  → _event_role_wakes (legacy semantics verbatim)
  │    └─ native event triggers→ per new token: pipeline.py start --kind native
  │                              --event-field … (START-ONLY; the run joins the
  │                              in-flight tokens and the main loop advances it)
  ├─ dispatch list = continuous triggers + IN-FLIGHT TOKENS (incl. child runs)
  └─ run_session <token> <kind>
       └─ pipeline.py ready
            ├─ sweep: dispatched call units ← consume <child>.outcome.json
            │         (record unit, republish outputs as the call node's sidecar)
            ├─ candidates: call_pipeline nodes → start_child_run (state file =
            │             a NEW in-flight token; wait:false records success now)
            ├─ steps: agent nodes → briefs + runs_as + NODE_SECRET=VAR=<label>
            └─ nothing runnable but calls outstanding → WAITING (rc-flag, no session)
       └─ secrets: label → value via credentials.py get (foreground, REFUSE on
          failure) → invoke_scoped_env; post-session redaction sweep
child run (an ordinary run)
  └─ … walks like any native run; _finish writes <base>.outcome.json
       {outcome, outputs: project_outputs(declared, merged node sidecars)}
```

## File Structure

- Modify: `lib/pipeline.py` — language (`MissingNodeOutput`, lazy `default`),
  static checker (soft back-edge refs, sibling refs, call/wait rules, `secrets:`),
  `call_pipeline` spec sheet, child-run core (`start_child_run`, outcome sidecar,
  `_sweep_call_units`, `_pick` rework, WAITING), secrets prepare/emission,
  `start_run_trigger` event fields + shared param-resolution helper.
- Modify: `lib/triggers.py` — event firing mode (schema + map), event shims,
  `event` CLI subcommand, collision-refusal retirement (Task 10 only).
- Modify: `bin/supervisor.sh` — WAITING flag, NODE_SECRET parsing + resolution +
  redaction sweep, `_event_native_wakes` + `resolve_trigger_event_wakes`,
  `has_scheduled_triggers`, legacy event path LEGACY-marked.
- Modify: `tests/test_pipeline.py`, `tests/test_triggers.py`,
  `tests/test_trigger_dispatch.sh`, `tests/test_event_bus.sh`,
  `tests/test_pipeline_runner.sh`, `tests/test_dashboard_state.py` (one tolerance
  test).
- Modify: `docs/pipelines.md`, `.claude/skills/engineering/pipelines.md`,
  `docs/settled-decisions.md` (SD-40).

No new files: every change extends an existing focused module at its established
seam. (`lib/pipeline.py` grows ~350 lines; it is already the subsystem's one home
and the skill map documents it — no split this phase.)

## Interfaces (Phase C deltas)

Consumed from Phase A/B (exact, verified against main `77b19a2`):

- `substitute(value, ctx)` / `_substitution_ctx(state_path, state)` /
  `_collect_node_outputs(state_path, state)` / `_node_outputs_rel(state_path, node_id)`
- `resolve_params(declared, overrides)` (the `secret_lookup` kwarg is DELETED in
  Task 7), `check_param_existence(declared, resolved, *, known_repos, known_accounts)`
- `resolve_pipeline_doc(repo, name)` → `(doc, meta)` (raises `PipelineError`)
- `start_run_trigger(repo, trigger_name, state_path, lane="", *, known_repos=None,
  known_accounts=None)` — gains `event_fields=None` (Task 9)
- `triggers.enumerate_triggers(repo, lane=None)` → `(triggers, warnings)`
- supervisor: `inflight_tokens`, `token_name`/`token_slot`, `pipeline_state_file`,
  `filter_dispatchable_tokens`, `trigger_start_token_for`, `_trigger_show_fields`,
  `_event_poll`, `_event_role_wakes`, `_event_write_seen`, `invoke_scoped_env`,
  `resolve_pipeline_ready` (PB_* arrays), `record_pipeline_outcome`.

Produced for later tasks / Phase D (exact):

- `pipeline.MissingNodeOutput(PipelineError)` — raised by `_resolve_ref` for
  unknown-node / unknown-output-name refs.
- `pipeline.MAX_CALL_DEPTH = 3`.
- `pipeline.start_child_run(repo, parent_state_path, parent_state, node)` →
  `(child_name, child_state_path)`; raises `PipelineError`.
- `pipeline._run_outcome_rel(state_path)` → `var/autonomy-logs/<base>.outcome.json`.
- `ready` CLI: prints `WAITING` (new terminal line, alongside `DONE <outcome>`);
  `_print_step` gains repeated `NODE_SECRET=<VAR>=<label>` lines.
- state (additive): `parent_run`, `parent_node`, `call_depth`, `call_path`;
  journal (additive): `parent_run`.
- `pipeline.py start … --kind native --event-field k=v` (repeatable; k ∈ item|sha).
- `triggers.py event <repo> [--lane l]` → TSV `name kind evspec policy max`
  (`evspec` = single event for native, comma-list for shim).
- supervisor: `PIPE_WAIT` global (set by `resolve_pipeline_ready`, checked by the
  main loop), `resolve_node_secret_env` (sets `NS_ENV_LINES`/`NS_VALUES`),
  `redact_session_log <log>` (reads `NS_VALUES`), `_event_native_wakes`,
  `resolve_trigger_event_wakes`, `has_scheduled_triggers`.

## Cutover / parity proof obligations (Task 10 tests each one)

1. A shimmed event role fires through the SAME `_event_role_wakes` body with the
   same seen-file name (`<role>__<event>.seen`) — no replay, no drop, at cutover
   (byte-equal marker names; first-sight seeding cannot re-trigger because the
   files already exist).
2. `session.done` still wakes shim event roles exactly when a loop session ran the
   previous tick — and is refused on native triggers at validate time.
3. A failed shim event session leaves the seen-set (redelivery) — legacy semantics.
4. A broken native event trigger file refuses AND keeps its same-name shim
   suppressed — never a fall back to role dispatch (SD-39 hard rail, re-proven on
   the event path).
5. After cutover exactly ONE enumerator exists (`resolve_trigger_event_wakes`);
   `resolve_event_wakes` is LEGACY-marked and uncalled by the main loop (structural
   double-dispatch impossibility — grep-proven in a test).
6. Non-event dispatch is byte-identical: continuous/schedule/manual paths and their
   tests pass unmodified through Tasks 1–9 (no supervisor main-loop diff before
   Task 10 except the WAITING case and NODE_SECRET refusals, both additive).
7. Child tokens never disturb existing token consumers: `inflight_tokens` output
   for a repo with only classic runs is byte-identical; a child state file appears
   as exactly one extra well-formed token.

---

### Task 1: the language — `MissingNodeOutput` + lazy `default()`

**Files:**
- Modify: `lib/pipeline.py` (after `PipelineError`, ~line 236; `_resolve_ref`
  ~line 364; `_resolve_expr` ~line 443)
- Test: `tests/test_pipeline.py`

**Interfaces:**
- Consumes: `_resolve_ref`, `_resolve_expr`, `_split_args`, `_resolve_arg` (Phase A).
- Produces: `MissingNodeOutput(PipelineError)`; `default()` evaluates its first
  argument lazily and maps ONLY `MissingNodeOutput` to the fallback.

- [ ] **Step 1: Write the failing tests**

```python
class LazyDefaultTest(unittest.TestCase):
    CTX = {"params": {"x": "v"}, "nodes": {"done": {"branch": "b1"}},
           "run": {"id": "r"}}

    def test_missing_node_output_is_typed(self):
        with self.assertRaises(pipeline.MissingNodeOutput):
            pipeline.substitute("${nodes.ghost.output.x}", self.CTX)
        with self.assertRaises(pipeline.MissingNodeOutput):
            pipeline.substitute("${nodes.done.output.ghost}", self.CTX)

    def test_default_tolerates_missing_node_output(self):
        out = pipeline.substitute(
            "${default(nodes.ghost.output.findings, 'none yet')}", self.CTX)
        self.assertEqual(out, "none yet")

    def test_default_still_resolves_present_output(self):
        out = pipeline.substitute(
            "${default(nodes.done.output.branch, 'none')}", self.CTX)
        self.assertEqual(out, "b1")

    def test_default_does_not_mask_param_typos(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.substitute("${default(params.ghost, 'x')}", self.CTX)

    def test_default_empty_first_arg_still_falls_back(self):
        ctx = {"params": {"m": ""}, "nodes": {}, "run": {}}
        self.assertEqual(
            pipeline.substitute("${default(params.m, 'fb')}", ctx), "fb")
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest tests.test_pipeline.LazyDefaultTest -v`
Expected: FAIL — `AttributeError: module 'pipeline' has no attribute 'MissingNodeOutput'`.

- [ ] **Step 3: Implement**

After `PipelineError` (line ~236):

```python
class MissingNodeOutput(PipelineError):
    """A ${nodes.<id>.output.<x>} whose node has not (yet) recorded that
    output. The ONE error class default() maps to its fallback -- the
    findings-return channel (a back-edge target's first visit legitimately
    predates the source's outputs). Every other resolution failure (a
    typo'd param, an unknown run field) stays a hard PipelineError."""
```

In `_resolve_ref`, the nodes branch raises the subclass:

```python
    if parts[0] == "nodes" and len(parts) == 4 and parts[2] == "output":
        outs = ctx.get("nodes", {}).get(parts[1])
        if outs is None or parts[3] not in outs:
            raise MissingNodeOutput("unknown node output ${nodes.%s.output.%s}"
                                    % (parts[1], parts[3]))
        return outs[parts[3]]
```

In `_resolve_expr`, branch BEFORE the generic allowlist dispatch (keep the
`_ALLOWED_FUNCS["default"]` entry — the static checker and arity errors still read
it):

```python
    m = _CALL_RE.match(expr)
    if m and m.group(1) == "default":
        args_raw = _split_args(m.group(2))
        if len(args_raw) != 2:
            raise PipelineError("function 'default' arity: expected 2, got %d"
                                % len(args_raw))
        try:
            first = _resolve_arg(args_raw[0], ctx)
        except MissingNodeOutput:
            return _resolve_arg(args_raw[1], ctx)
        if first in (None, "", False):
            return _resolve_arg(args_raw[1], ctx)
        return first
```

- [ ] **Step 4: Run to verify pass**

Run: `python3 -m unittest tests.test_pipeline.LazyDefaultTest -v` → PASS.
Then the whole file: `python3 -m unittest tests.test_pipeline -v` → PASS (the
Phase A/B substitution tests pin that nothing else changed).

- [ ] **Step 5: Same-class scan + commit**

Scan: every raiser inside `_resolve_ref` — params/run branches stay
`PipelineError` (deliberate: only node outputs are time-dependent). State the scan
in the commit body.

```bash
git add lib/pipeline.py tests/test_pipeline.py
git commit -m "feat(#376): MissingNodeOutput + lazy default() -- the findings-return tolerance (Task 1)"
```

---

### Task 2: static checker — back-edge-visible refs in `default()`, container-child + earlier-sibling refs

**Files:**
- Modify: `lib/pipeline.py` (`_check_expr_static` ~line 750, `check_refs` ~line 808)
- Test: `tests/test_pipeline.py`

**Interfaces:**
- Consumes: `_ancestors(doc, uid)`, `effective_edges`, `_con_by_id`.
- Produces: `_unit_node_ids(doc, uid)`, `_soft_visible(doc, unit)`;
  `_check_expr_static(expr, declared_params, allowed_nodes, soft_nodes, errors,
  where, soft_ok=False)` (signature change — update every caller).

- [ ] **Step 1: Write the failing tests**

```python
def _findings_doc():
    """The spec S2.1 example, expressed with today's back-edge rule:
    pick -> stage[code] -> qa, qa --failure,back--> stage."""
    return {
        "name": "t2m", "version": 1, "caps": {"max_sessions_per_run": 10},
        "params": [], "outputs": [],
        "nodes": [
            {"id": "pick", "type": "pick", "brief_ref": "pick.md"},
            {"id": "code", "type": "agent_task", "brief_ref": "code.md"},
            {"id": "qa", "type": "check", "brief_ref": "qa.md"},
        ],
        "containers": [{"id": "st", "kind": "stage", "children": ["code"]}],
        "edges": [
            {"from": "pick", "to": "st", "on": "success"},
            {"from": "st", "to": "qa", "on": "success"},
            {"from": "qa", "to": "st", "on": "failure", "back": True,
             "max_bounces": 3},
        ],
    }

class SoftBackEdgeRefTest(unittest.TestCase):
    def test_bare_future_ref_refuses(self):
        doc = _findings_doc()
        doc["nodes"][1]["runs_as"] = {"model": "${nodes.qa.output.findings}"}
        errs = pipeline.validate_doc(doc)
        self.assertTrue(any("strict upstream" in e for e in errs), errs)

    def test_future_ref_inside_default_validates(self):
        # exercised through a STRING FIELD the scanner walks; brief text is
        # checked by the same _check_expr_static at compile time
        doc = _findings_doc()
        doc["params"] = [{"name": "m", "type": "model", "required": False,
                          "default": "claude-sonnet-5"}]
        doc["nodes"][1]["runs_as"] = {
            "model": "${default(nodes.qa.output.model_hint, params.m)}"}
        self.assertEqual(pipeline.validate_doc(doc), [])

    def test_default_second_arg_gets_no_soft_pass(self):
        doc = _findings_doc()
        doc["nodes"][1]["runs_as"] = {
            "model": "${default(params_missing_entirely, nodes.qa.output.h)}"}
        errs = pipeline.validate_doc(doc)
        self.assertTrue(errs)   # both args refuse: bad ref + non-soft position

    def test_soft_set_requires_the_bounce_path(self):
        # qa's back-edge removed -> code may NOT soft-reference qa
        doc = _findings_doc()
        doc["edges"] = doc["edges"][:2]
        doc["nodes"][1]["runs_as"] = {
            "model": "${default(nodes.qa.output.h, 'x')}"}
        self.assertTrue(pipeline.validate_doc(doc))

class SiblingRefTest(unittest.TestCase):
    def _doc(self):
        return {
            "name": "sib", "version": 1, "caps": {"max_sessions_per_run": 9},
            "nodes": [
                {"id": "a", "type": "agent_task", "brief_ref": "a.md"},
                {"id": "b", "type": "agent_task", "brief_ref": "b.md"},
                {"id": "c", "type": "agent_task", "brief_ref": "c.md"},
            ],
            "containers": [{"id": "st", "kind": "stage",
                            "children": ["a", "b"]}],
            "edges": [{"from": "st", "to": "c", "on": "success"}],
        }

    def test_earlier_sibling_ref_validates(self):
        doc = self._doc()
        doc["nodes"][1]["runs_as"] = {"model": "${nodes.a.output.m}"}
        self.assertEqual(pipeline.validate_doc(doc), [])

    def test_later_sibling_ref_refuses(self):
        doc = self._doc()
        doc["nodes"][0]["runs_as"] = {"model": "${nodes.b.output.m}"}
        self.assertTrue(pipeline.validate_doc(doc))

    def test_upstream_container_child_ref_validates(self):
        doc = self._doc()
        doc["nodes"][2]["runs_as"] = {"model": "${nodes.b.output.m}"}
        self.assertEqual(pipeline.validate_doc(doc), [])
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest tests.test_pipeline.SoftBackEdgeRefTest tests.test_pipeline.SiblingRefTest -v`
Expected: FAIL — soft refs and sibling/container-child refs are refused today
(`does not name a strict upstream node`); the bare-refusal message assertion
(`strict upstream`) also fails until the message is updated.

- [ ] **Step 3: Implement**

Helpers (near `_ancestors`):

```python
def _unit_node_ids(doc, uid):
    """Node ids a UNIT contributes to the reference namespace: itself for a
    plain node, its children for a container. Total over garbage shapes."""
    con = None
    for c in doc.get("containers") or []:
        if isinstance(c, dict) and c.get("id") == uid:
            con = c
            break
    if con is None:
        return [uid]
    return [ch for ch in (con.get("children") or []) if isinstance(ch, str)]


def _soft_visible(doc, unit):
    """Node ids whose outputs `unit` may reference ONLY inside default():
    back-edge sources that re-run this unit when they bounce. src is
    soft-visible to unit iff unit lies on the re-run stretch -- unit is the
    back-edge target or downstream of it, AND strictly upstream of src."""
    soft = set()
    try:
        edges = effective_edges(doc)
    except Exception:
        return soft
    anc_of_unit = _ancestors(doc, unit)
    for e in edges:
        if not (isinstance(e, dict) and e.get("back")):
            continue
        src, tgt = e.get("from"), e.get("to")
        if not (isinstance(src, str) and isinstance(tgt, str)):
            continue
        if (unit == tgt or tgt in anc_of_unit) and unit in _ancestors(doc, src):
            soft.update(_unit_node_ids(doc, src))
    return soft
```

`_check_expr_static` — new params + threading (full replacement of the function
signature and the two touched branches):

```python
def _check_expr_static(expr, declared_params, allowed_nodes, soft_nodes,
                       errors, where, soft_ok=False):
    ...
        for j, a in enumerate(args):
            a = a.strip()
            if len(a) >= 2 and a[0] == a[-1] and a[0] in "'\"":
                continue
            if re.match(r"^-?\d+$", a):
                continue
            _check_expr_static(a, declared_params, allowed_nodes, soft_nodes,
                               errors, where,
                               soft_ok=(fn == "default" and j == 0))
        return
    ...
    if parts[0] == "nodes" and len(parts) == 4 and parts[2] == "output":
        if parts[1] in allowed_nodes:
            return
        if soft_ok and parts[1] in soft_nodes:
            return
        errors.append("%s: ${nodes.%s.output.%s} does not name a strict "
                      "upstream node -- its outputs cannot exist yet (a "
                      "back-edge-visible node's outputs may be read only as "
                      "default()'s first argument)"
                      % (where, parts[1], parts[3]))
        return
```

`check_refs.scan` — replace the `allowed` derivation (and delete the Phase B
"does NOT statically allow that" comment, which this task retires):

```python
    def _allowed_node_ids(nid, unit):
        allowed = set()
        for a in _ancestors(doc, unit):
            allowed.update(_unit_node_ids(doc, a))
        cid = con_of.get(nid)
        if cid is not None:
            sibs = _unit_node_ids(doc, cid)
            if nid in sibs:
                allowed.update(sibs[:sibs.index(nid)])   # EARLIER siblings only
        return allowed

    def scan(where, v, unit, nid=None):
        if isinstance(v, str):
            if "${" in v.replace("$${", ""):
                allowed = _allowed_node_ids(nid, unit) if unit else set()
                soft = _soft_visible(doc, unit) if unit else set()
                ...
                for b in bodies:
                    _check_expr_static(b, declared, allowed, soft, errors, where)
```

and thread `nid` through the two `scan(...)` call sites (`scan(where, clean, unit,
nid)` for nodes; containers pass `nid=None`). `compile_brief`-time checking needs
no change: brief TEXT is validated at prepare via `substitute` (runtime), and
statically the brief file is not scanned — unchanged from Phase B.

- [ ] **Step 4: Run to verify pass**

`python3 -m unittest tests.test_pipeline -v` → PASS (Phase B `check_refs` tests
that pinned the container-sibling refusal flip their expectation — update them in
this commit and SAY SO in the commit body: the refusal was recorded as a
Phase C decide-point in the Phase B code comment).

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline.py tests/test_pipeline.py
git commit -m "feat(#376): back-edge-visible refs via default() + same-container earlier-sibling refs (Task 2, decisions 7+9)"
```

---

### Task 3: `call_pipeline` — spec sheet + validator

**Files:**
- Modify: `lib/pipeline.py` (`SPEC_SHEETS` ~line 45, `_NODE_KEYS` ~line 191,
  `validate_doc` node loop ~line 916, `check_refs`)
- Test: `tests/test_pipeline.py`

**Interfaces:**
- Produces: `SPEC_SHEETS["call_pipeline"]` (deferred: False → `NODE_TYPES` gains
  it automatically); node keys `pipeline`, `params`, `wait`;
  `MAX_CALL_DEPTH = 3` (constant, used in Task 4).

- [ ] **Step 1: Write the failing tests**

```python
def _call_doc(wait=True, params=None):
    return {
        "name": "parent", "version": 1, "caps": {"max_sessions_per_run": 9},
        "params": [{"name": "repo", "type": "string", "required": False,
                    "default": "r"}],
        "nodes": [
            {"id": "code", "type": "agent_task", "brief_ref": "code.md"},
            {"id": "qa", "type": "call_pipeline", "pipeline": "qa-sweep",
             "params": params if params is not None
             else {"target": "${nodes.code.output.branch}"},
             "wait": wait},
        ],
        "edges": [{"from": "code", "to": "qa", "on": "success"}],
    }

class CallPipelineValidationTest(unittest.TestCase):
    def test_minimal_call_doc_validates(self):
        self.assertEqual(pipeline.validate_doc(_call_doc()), [])

    def test_call_is_a_live_node_type(self):
        self.assertIn("call_pipeline", pipeline.NODE_TYPES)
        self.assertNotIn("call_pipeline", pipeline.DEFERRED_NODE_TYPES)

    def test_call_refuses_brief_and_runs_as(self):
        doc = _call_doc()
        doc["nodes"][1]["brief_ref"] = "x.md"
        self.assertTrue(pipeline.validate_doc(doc))
        doc = _call_doc()
        doc["nodes"][1]["runs_as"] = {"model": "m"}
        self.assertTrue(pipeline.validate_doc(doc))

    def test_call_requires_valid_pipeline_name(self):
        doc = _call_doc()
        doc["nodes"][1]["pipeline"] = "../escape"
        self.assertTrue(pipeline.validate_doc(doc))
        del doc["nodes"][1]["pipeline"]
        self.assertTrue(pipeline.validate_doc(doc))

    def test_call_params_must_be_scalar_map(self):
        self.assertTrue(pipeline.validate_doc(_call_doc(params={"k": []})))
        self.assertTrue(pipeline.validate_doc(_call_doc(params="nope")))

    def test_wait_must_be_bool(self):
        doc = _call_doc()
        doc["nodes"][1]["wait"] = "yes"
        self.assertTrue(pipeline.validate_doc(doc))

    def test_call_keys_refused_on_other_types(self):
        doc = _call_doc()
        doc["nodes"][0]["wait"] = True
        self.assertTrue(pipeline.validate_doc(doc))

    def test_detached_call_outputs_are_unreadable(self):
        doc = _call_doc(wait=False)
        doc["nodes"].append({"id": "z", "type": "agent_task",
                             "brief_ref": "z.md",
                             "runs_as": {"model": "${nodes.qa.output.v}"}})
        doc["edges"].append({"from": "qa", "to": "z", "on": "success"})
        errs = pipeline.validate_doc(doc)
        self.assertTrue(any("detached" in e for e in errs), errs)

    def test_call_inside_loop_container_validates(self):
        doc = _call_doc()
        doc["containers"] = [{"id": "lp", "kind": "loop",
                              "children": ["code", "qa"],
                              "exit_when": "verdict", "max_rounds": 3}]
        doc["edges"] = []
        self.assertEqual(pipeline.validate_doc(doc), [])
```

- [ ] **Step 2: Run to verify failure**

`python3 -m unittest tests.test_pipeline.CallPipelineValidationTest -v` →
FAIL (`unknown type 'call_pipeline'`, unknown keys).

- [ ] **Step 3: Implement**

`SPEC_SHEETS` gains (alphabetical placement beside the other work-group sheets):

```python
    "call_pipeline": {
        "label": "call pipeline", "group": "work", "icon": "\U0001f4de",
        "required": [["pipeline", "the pipeline to run as a CHILD run"]],
        "optional": [["params", "override the child's saved defaults "
                      "(values may use ${...})"],
                     ["wait", "true (default): wait, read outputs, child "
                      "outcome drives edges; false: detach"]],
        "emits": "child outcome (success/failure); outputs -> "
                 "${nodes.<id>.output.*} when waited",
        "deferred": False, "guarded": ["depth cap", "cycle refusal"]},
```

Constants: `_NODE_KEYS` gains `"pipeline", "params", "wait"`;
`MAX_CALL_DEPTH = 3` beside `MAX_PARALLEL_CEIL`.

`validate_doc` node loop — after the `ntype` checks, replace the brief/legacy
exactly-one block with a type-branch:

```python
        has_brief = "brief_ref" in node
        has_legacy = "legacy_prompt" in node
        if ntype == "call_pipeline":
            for bad in ("brief_ref", "legacy_prompt", "runs_as", "secrets"):
                if bad in node:
                    errors.append("%s: %r does not belong on call_pipeline "
                                  "(the child's own doc carries it)"
                                  % (where, bad))
            if not valid_pipeline_name(node.get("pipeline")):
                errors.append("%s: pipeline: required, charset "
                              "[A-Za-z0-9._-]{1,64} (existence is checked at "
                              "call time)" % where)
            cparams = node.get("params")
            if cparams is not None:
                if not isinstance(cparams, dict):
                    errors.append("%s: params must be a mapping of "
                                  "name -> scalar" % where)
                else:
                    for k, v in cparams.items():
                        if not (isinstance(k, str) and _NAME_RE.match(k)):
                            errors.append("%s: params key %r invalid charset"
                                          % (where, k))
                        if not (isinstance(v, (str, int, float, bool))
                                or v is None):
                            errors.append("%s: params.%s must be a scalar"
                                          % (where, k))
            if "wait" in node and not isinstance(node["wait"], bool):
                errors.append("%s: wait must be a bool" % where)
        else:
            for bad in ("pipeline", "params", "wait"):
                if bad in node:
                    errors.append("%s: %r only belongs on call_pipeline"
                                  % (where, bad))
            if has_brief == has_legacy:
                errors.append("%s: exactly one of brief_ref / legacy_prompt "
                              "required" % where)
```

(`secrets` in the refusal list forward-references Task 7's key — add it to
`_NODE_KEYS` there; listing it here is a no-op until then and keeps the two
tasks commit-independent. Note it in the commit body.)

`check_refs` — detached-output refusal. Inside `check_refs`, before `scan` is
called, build the detached set; in `_check_expr_static`'s nodes branch the
`allowed` check stays first, so implement the refusal in `check_refs` by
REMOVING detached call ids from both `allowed` and `soft` and emitting the
specific message when named:

```python
    detached = set()
    for n in _lst(doc.get("nodes")):
        if isinstance(n, dict) and n.get("type") == "call_pipeline" \
                and n.get("wait") is False and isinstance(n.get("id"), str):
            detached.add(n["id"])
```

and in `scan`, after computing `allowed`/`soft`:

```python
                allowed -= detached
                soft -= detached
                for b in bodies:
                    for did in detached:
                        if ("nodes.%s.output." % did) in b:
                            errors.append("%s: ${nodes.%s.output...} names a "
                                          "detached (wait:false) call -- its "
                                          "outputs never return" % (where, did))
```

- [ ] **Step 4: Run to verify pass**

`python3 -m unittest tests.test_pipeline -v` → PASS.
Also `python3 -m unittest tests.test_dashboard_state -v` — the canvas viewer
derives its palette from `SPEC_SHEETS`; the new sheet must not break
`build_pipeline_view` (it is data-driven; expect PASS untouched).

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline.py tests/test_pipeline.py
git commit -m "feat(#376): call_pipeline un-deferred -- spec sheet + validator rules (Task 3)"
```

---

### Task 4: child-run core — `start_child_run`, the outcome sidecar, run-level outputs

**Files:**
- Modify: `lib/pipeline.py` (`start_run_trigger` ~line 1396 — extract the shared
  helper; `_finish` ~line 1826; new functions beside `_node_outputs_rel`)
- Test: `tests/test_pipeline.py`

**Interfaces:**
- Consumes: `resolve_pipeline_doc`, `resolve_params`, `check_param_existence`,
  `_substitution_ctx`, `substitute`, `_atomic_write_json`, `read_outputs`,
  `project_outputs`.
- Produces:
  - `_resolve_run_params(repo, doc, overrides, *, known_repos, known_accounts)`
    → `{name: value}` — the ONE place invoker params resolve (start_run_trigger
    and start_child_run both call it; Task 7 edits it once).
  - `_run_outcome_rel(state_path)`; `_write_child_outcome(state, state_path, outcome)`.
  - `start_child_run(repo, parent_state_path, parent_state, node)` →
    `(child_name, child_state_path)`.
  - state additions: `parent_run`, `parent_node`, `call_depth`, `call_path`;
    journal addition: `parent_run`.

- [ ] **Step 1: Write the failing tests**

(Fixtures: build a tmp repo dir with `.autonomy/pipelines/<name>/pipeline.json`
+ briefs the way the Phase B `start_run_trigger` tests already do — reuse their
helper if one exists in `tests/test_pipeline.py`; otherwise this shape:)

```python
class ChildRunTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.logdir = os.path.join(self.repo, "var", "autonomy-logs")
        os.makedirs(self.logdir)
        self._write_pipeline("qa-sweep", {
            "name": "qa-sweep", "version": 1,
            "caps": {"max_sessions_per_run": 4},
            "params": [{"name": "target", "type": "string", "required": True}],
            "outputs": [{"name": "findings", "type": "string"}],
            "nodes": [{"id": "scan", "type": "check", "brief_ref": "scan.md"}],
        }, briefs={"scan.md": "scan ${params.target}"})

    def _write_pipeline(self, name, doc, briefs):
        d = os.path.join(self.repo, ".autonomy", "pipelines", name)
        os.makedirs(d)
        with open(os.path.join(d, "pipeline.json"), "w") as fh:
            json.dump(doc, fh)
        for fn, text in briefs.items():
            with open(os.path.join(d, fn), "w") as fh:
                fh.write(text)

    def _parent_state(self, node_params=None, name="par"):
        doc = _call_doc()          # Task 3 helper
        doc["nodes"][1]["params"] = node_params if node_params is not None \
            else {"target": "${nodes.code.output.branch}"}
        state_path = os.path.join(self.logdir, ".pipeline-run-%s.json" % name)
        state = {"fmt": 2, "run_id": "%s-x-1" % name, "role": name,
                 "lane": "", "doc": dict(doc, edges=pipeline.effective_edges(doc)),
                 "meta": {}, "trigger": name, "kind": "native", "params": {},
                 "run": {"id": "%s-x-1" % name, "pipeline": doc["name"],
                         "trigger": name, "repo": self.repo},
                 "started": 1, "sessions": 0,
                 "units": {"code": {"status": "success"},
                           "qa": {"status": "pending"}},
                 "container_pos": {}, "rounds": {}, "bounces": {},
                 "nodes_done": [{"id": "code", "type": "agent_task",
                                 "outcome": "success", "unit": "code",
                                 "via": [], "session_log": ""}],
                 "status": "in_progress"}
        pipeline._atomic_write_json(state_path, state)
        # code's outputs sidecar feeds the call params
        outp = os.path.join(self.logdir, ".pipeline-run-%s.code.outputs.json" % name)
        pipeline.write_output(outp, "branch", "feat/x")
        return state_path, state

    def test_child_starts_with_substituted_params(self):
        sp, st = self._parent_state()
        name, cpath = pipeline.start_child_run(
            self.repo, sp, st, st["doc"]["nodes"][1])
        self.assertEqual(name, "par.c0.qa")
        child = json.load(open(cpath))
        self.assertEqual(child["params"], {"target": "feat/x"})
        self.assertEqual(child["kind"], "native")
        self.assertEqual(child["parent_run"], st["run_id"])
        self.assertEqual(child["call_depth"], 1)
        self.assertEqual(child["call_path"], ["parent", "qa-sweep"])

    def test_cycle_refused(self):
        sp, st = self._parent_state()
        st["call_path"] = ["qa-sweep"]
        with self.assertRaises(pipeline.PipelineError):
            pipeline.start_child_run(self.repo, sp, st, st["doc"]["nodes"][1])

    def test_depth_cap_refused(self):
        sp, st = self._parent_state()
        st["call_depth"] = pipeline.MAX_CALL_DEPTH
        with self.assertRaises(pipeline.PipelineError):
            pipeline.start_child_run(self.repo, sp, st, st["doc"]["nodes"][1])

    def test_overlong_child_name_refused(self):
        sp, st = self._parent_state(name="p" * 58)
        with self.assertRaises(pipeline.PipelineError):
            pipeline.start_child_run(self.repo, sp, st, st["doc"]["nodes"][1])

    def test_required_child_param_missing_refuses(self):
        sp, st = self._parent_state(node_params={})
        with self.assertRaises(pipeline.PipelineError):
            pipeline.start_child_run(self.repo, sp, st, st["doc"]["nodes"][1])

    def test_existing_child_state_refuses(self):
        sp, st = self._parent_state()
        stale = os.path.join(self.logdir, ".pipeline-run-par.c0.qa.json")
        with open(stale, "w") as fh:
            fh.write("{}")
        with self.assertRaises(pipeline.PipelineError):
            pipeline.start_child_run(self.repo, sp, st, st["doc"]["nodes"][1])

class ChildOutcomeSidecarTest(unittest.TestCase):
    # build a CHILD state (parent_run set, declared outputs) in a tmp logdir,
    # write its node sidecar, drive _finish via record_outcome's DONE path
    def test_finish_parks_outcome_and_projected_outputs(self):
        ...  # asserts <base>.outcome.json == {"run_id": ..., "outcome": "success",
             #                                  "outputs": {"findings": "f1"}}

    def test_projection_type_mismatch_downgrades_to_failure(self):
        ...  # declared number, sidecar value "abc" -> parked outcome "failure",
             # "error" names the projection, NO outputs key

    def test_failed_call_entries_still_contribute_outputs(self):
        ...  # nodes_done entry {type: call_pipeline, outcome: failure} with a
             # sidecar -> its values ARE merged (decision 8)

    def test_journal_line_carries_parent_run(self):
        ...  # journal written by _finish gains "parent_run"
```

(Write the three `...` bodies out in full when implementing the test file — they
follow `ChildRunTest`'s fixture pattern; each is ~15 lines. The assertions named
in the comments are the contract.)

- [ ] **Step 2: Run to verify failure**

`python3 -m unittest tests.test_pipeline.ChildRunTest -v` → FAIL
(`no attribute 'start_child_run'`).

- [ ] **Step 3: Implement**

Extract the shared resolution core out of `start_run_trigger` (behaviour
byte-identical — the Phase B secrets refusal moves with it):

```python
def _resolve_run_params(repo, doc, overrides, *, known_repos=None,
                        known_accounts=None):
    """Invoker param resolution for a parameterised run (a trigger OR a
    calling pipeline -- the same slot, spec S3). Phase B semantics verbatim:
    secrets that would resolve are refused (the env-channel sink flips this
    in ONE place -- here -- when it lands)."""
    declared = doc.get("params") or []
    resolving_secrets = sorted(
        p["name"] for p in declared
        if isinstance(p, dict) and p.get("type") == "secret"
        and ("default" in p or p.get("name") in overrides))
    if resolving_secrets:
        raise PipelineError(
            "secret param(s) %s would resolve (invoker value or pipeline "
            "default) but no dispatch sink for secrets exists yet -- "
            "refusing rather than accept-and-ignore"
            % ", ".join(resolving_secrets))
    params = resolve_params(declared, overrides, secret_lookup=None)
    check_param_existence(
        declared, params,
        known_repos=known_repos or _registered_repos,
        known_accounts=known_accounts or _known_accounts)
    return params
```

`start_run_trigger` shrinks to call it (delete its inline copy of the same
block). Then:

```python
def _state_base(state_path):
    base = os.path.basename(state_path)
    if base.endswith(".json"):
        base = base[:-len(".json")]
    return base


def _run_outcome_rel(state_path):
    """The parked child outcome, derived exactly like the verdict/outputs
    sidecars -- one naming rule everywhere, lane/slot-safe for free."""
    return "var/autonomy-logs/%s.outcome.json" % _state_base(state_path)


def _child_token_name(parent_state_path, parent_state, node_id):
    """<parent-name>.c<parent-slot>.<node-id> -- parsed from the state
    FILENAME with inflight_tokens' exact rules (strip @slot from the end,
    then --lane), so both sides agree by construction."""
    base = _state_base(parent_state_path)
    if base.startswith(".pipeline-run-"):
        base = base[len(".pipeline-run-"):]
    slot = "0"
    if "@" in base:
        base, slot = base.rsplit("@", 1)
    lane = parent_state.get("lane") or ""
    if lane and base.endswith("--%s" % lane):
        base = base[:-(len(lane) + 2)]
    return "%s.c%s.%s" % (base, slot, node_id)


def start_child_run(repo, parent_state_path, parent_state, node):
    """Spawn the CHILD run for a call_pipeline node (spec S4): a real run,
    resolved+parameterised exactly like a trigger-started run -- the caller
    occupies the trigger's override slot. Returns (child_name,
    child_state_path); raises PipelineError on every refusal (the caller
    records the call unit as failed -- a broken call must fail the node,
    never crash the walk)."""
    child_name = _child_token_name(parent_state_path, parent_state, node["id"])
    if not _NAME_RE.match(child_name):
        raise PipelineError("child run name %r is over 64 chars or invalid "
                            "-- shorten the trigger/pipeline/node names"
                            % child_name)
    depth = int(parent_state.get("call_depth") or 0) + 1
    if depth > MAX_CALL_DEPTH:
        raise PipelineError("call depth %d exceeds MAX_CALL_DEPTH=%d"
                            % (depth, MAX_CALL_DEPTH))
    call_path = list(parent_state.get("call_path")
                     or [parent_state.get("doc", {}).get("name", "")])
    if node["pipeline"] in call_path:
        raise PipelineError("call cycle: %s -> %s"
                            % (" -> ".join(call_path), node["pipeline"]))
    doc, meta = resolve_pipeline_doc(repo, node["pipeline"])
    ctx = _substitution_ctx(parent_state_path, parent_state)
    overrides = {}
    for k, v in (node.get("params") or {}).items():
        overrides[k] = substitute(v, ctx)     # ONE pass; values stay inert
    params = _resolve_run_params(repo, doc, overrides)
    doc = dict(doc)
    doc["edges"] = effective_edges(doc)
    lane = parent_state.get("lane") or ""
    child_base = "%s--%s" % (child_name, lane) if lane else child_name
    child_state_path = os.path.join(os.path.dirname(parent_state_path),
                                    ".pipeline-run-%s.json" % child_base)
    if os.path.exists(child_state_path):
        raise PipelineError("child state %s already exists -- a previous "
                            "child was interrupted mid-consume; remove the "
                            "file to recover" % child_state_path)
    run_id = "%s-%s-%d" % (child_name, time.strftime("%Y%m%dT%H%M%S"),
                           os.getpid())
    state = {"fmt": 2, "run_id": run_id,
             "role": child_name, "lane": lane, "doc": doc, "meta": meta,
             "trigger": child_name, "kind": "native", "params": params,
             "run": {"id": run_id, "pipeline": doc["name"],
                     "trigger": child_name, "repo": repo},
             "parent_run": parent_state.get("run_id", ""),
             "parent_node": node["id"],
             "call_depth": depth, "call_path": call_path + [node["pipeline"]],
             "started": int(time.time()), "sessions": 0,
             "units": dict((u, {"status": "pending"}) for u in _top_units(doc)),
             "container_pos": {}, "rounds": {}, "bounces": {},
             "nodes_done": [], "status": "in_progress"}
    _atomic_write_json(child_state_path, state)
    return child_name, child_state_path
```

`_write_child_outcome` + `_finish` delta (sidecar FIRST, so a write failure
leaves the run in_progress and it retries — never a silently lost outcome):

```python
def _write_child_outcome(state, state_path, outcome):
    """Park {outcome, outputs} for the parent's sweep. Outputs = the child's
    DECLARED outputs projected from its node sidecars in completion order;
    call entries contribute on failure too (decision 8). A projection
    failure DOWNGRADES the parked outcome to failure with the error named
    -- unvalidated data never crosses runs (fail-safe)."""
    raw = {}
    logdir = os.path.dirname(state_path)
    for entry in state.get("nodes_done", []):
        if not isinstance(entry, dict):
            continue
        usable = entry.get("outcome") == "success" or (
            entry.get("type") == "call_pipeline"
            and entry.get("outcome") in ("success", "failure"))
        if not usable:
            continue
        rel = _node_outputs_rel(state_path, entry.get("id"))
        raw.update(read_outputs(os.path.join(logdir, os.path.basename(rel))))
    payload = {"run_id": state.get("run_id", ""), "outcome": outcome}
    try:
        payload["outputs"] = project_outputs(
            (state.get("doc") or {}).get("outputs") or [], raw)
    except PipelineError as exc:
        payload = {"run_id": state.get("run_id", ""), "outcome": "failure",
                   "error": "outputs projection failed: %s" % exc}
    path = os.path.join(os.path.dirname(state_path), os.path.basename(
        _run_outcome_rel(state_path)))
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, sort_keys=True)
    os.replace(tmp, path)
```

In `_finish`, first lines become:

```python
def _finish(state, state_path, outcome, journal_path):
    state["status"] = "done"
    state["outcome"] = outcome
    if state.get("parent_run"):
        _write_child_outcome(state, state_path, outcome)
    if journal_path:
        _journal_append(journal_path, state)
    ...
```

Deterministic name-headroom at RUN START (CP1: an over-long trigger name must
refuse the run up front, not fail every call node one by one at sweep time —
same verdict, delivered before any session burns). New helper, called from
`start_run_trigger` and `start_run` right after the doc resolves, and from
`start_child_run` after the child doc resolves (grandchild headroom):

```python
def _check_call_name_headroom(doc, run_name):
    """Every call node must yield a charset-legal child token:
    <run_name>.c<slot>.<node_id> with slot up to one digit (concurrency max
    is <= 8). Raises PipelineError naming the first offender."""
    for n in doc.get("nodes") or []:
        if not (isinstance(n, dict) and n.get("type") == "call_pipeline"):
            continue
        worst = "%s.c9.%s" % (run_name, n.get("id", ""))
        if not _NAME_RE.match(worst):
            raise PipelineError(
                "call node %r: child token %r would exceed the 64-char name "
                "limit -- shorten the trigger or node name (refusing the run "
                "up front rather than failing every call at sweep time)"
                % (n.get("id"), worst))
```

(with a `ChildRunTest` sibling: a trigger whose name makes any call-node child
token over-long refuses at `start_run_trigger` time with the headroom message;
`test_overlong_child_name_refused` stays as the start_child_run-level backstop
for the grandchild case.)

`_journal_append`'s record gains one additive field after `"trigger"`:

```python
        "parent_run": state.get("parent_run", ""),
```

- [ ] **Step 4: Run to verify pass**

`python3 -m unittest tests.test_pipeline -v` → PASS (Phase B
`start_run_trigger` tests prove the extraction changed nothing).

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline.py tests/test_pipeline.py
git commit -m "feat(#376): child-run core -- start_child_run + outcome sidecar + shared param resolution (Task 4)"
```

---

### Task 5: walk integration — the `ready` sweep, call dispatch, WAITING

**Files:**
- Modify: `lib/pipeline.py` (`_pick` ~line 1957, `next_node`, `ready_set`,
  `main` `ready`/`next` printing ~line 2209/2224)
- Test: `tests/test_pipeline.py`

**Interfaces:**
- Consumes: `start_child_run`, `_run_outcome_rel` (Task 4); `_pick_candidates`
  (dispatched units ARE candidates — the reclaim contract this task refines for
  call units).
- Produces: `_pick` third kind `("waiting", None)`; `ready` CLI prints `WAITING`;
  `next` prints `WAITING`; call units carry `unit["child"] = <child_name>`;
  nodes_done call entries: `{"id", "type": "call_pipeline", "outcome",
  "unit", "via", "child_run", "detached"?: True, "error"?: str,
  "child_outcome"?: str}`.

- [ ] **Step 1: Write the failing tests**

```python
class CallWalkTest(unittest.TestCase):
    # fixture: tmp repo from ChildRunTest + a parent state whose next
    # candidate is the qa call node (code already success, as in Task 4)

    def _ready(self, sp):
        return pipeline.ready_set(sp, self.logdir, 8,
                                  journal_path=self.journal)

    def test_call_candidate_starts_child_and_waits(self):
        sp, st = self._parent_state()
        out = self._ready(sp)
        self.assertEqual(out, "WAITING")          # see Step 3: sentinel return
        child_state = os.path.join(self.logdir,
                                   ".pipeline-run-par.c0.qa.json")
        self.assertTrue(os.path.isfile(child_state))
        st2 = json.load(open(sp))
        self.assertEqual(st2["units"]["qa"]["status"], "dispatched")
        self.assertEqual(st2["units"]["qa"]["child"], "par.c0.qa")

    def test_waiting_while_child_alive(self):
        sp, st = self._parent_state()
        self._ready(sp)
        self.assertEqual(self._ready(sp), "WAITING")   # no duplicate child
        self.assertEqual(
            1, len([f for f in os.listdir(self.logdir) if ".c0.qa" in f
                    and f.endswith(".json")]))

    def test_child_outcome_consumed_records_and_republishes_outputs(self):
        sp, st = self._parent_state()
        self._ready(sp)
        # simulate the child finishing: remove its state, park its outcome
        os.unlink(os.path.join(self.logdir, ".pipeline-run-par.c0.qa.json"))
        with open(os.path.join(self.logdir,
                  ".pipeline-run-par.c0.qa.outcome.json"), "w") as fh:
            json.dump({"run_id": "c", "outcome": "success",
                       "outputs": {"findings": "f1"}}, fh)
        out = self._ready(sp)                     # run finishes: [] (DONE path)
        self.assertEqual(out, [])
        # the call node's own outputs sidecar now serves ${nodes.qa.output.*}
        got = pipeline.read_outputs(os.path.join(
            self.logdir, ".pipeline-run-par.qa.outputs.json"))
        self.assertEqual(got, {"findings": "f1"})
        # journal line: outcome success, one call entry with child_run
        rec = json.loads(open(self.journal).read().splitlines()[-1])
        entries = [n for n in rec["nodes"] if n["id"] == "qa"]
        self.assertEqual(entries[0]["type"], "call_pipeline")
        self.assertTrue(entries[0]["child_run"])

    def test_child_failure_drives_failure_edges(self):
        # parent doc variant: qa --failure--> fix (agent node)
        ...  # park {"outcome": "failure", "outputs": {"findings": "f"}};
             # ready returns the fix step; ${default(nodes.qa.output.findings,'')}
             # in fix's brief compiles "f" (decision 8: failure outputs return)

    def test_corrupt_sidecar_child_gone_records_failure(self):
        ...  # write junk bytes to the outcome sidecar, no child state ->
             # unit failure, entry["error"] names it (prevention-log #18)

    def test_child_vanished_restarts(self):
        ...  # dispatched call unit, no sidecar, no child state -> a FRESH
             # child state appears (reclaim), unit stays dispatched

    def test_wait_false_records_success_immediately(self):
        ...  # wait:false doc: ready returns the next agent step in the SAME
             # call (or [] when last); unit qa == success; child state exists;
             # entry has detached: True

    def test_call_start_failure_records_unit_failure(self):
        ...  # node.pipeline = "ghost" -> unit failure, entry error names the
             # unresolvable pipeline; run outcome failure unless handled

    def test_call_start_reserves_session_budget(self):
        ...  # cap 1: starting the wait:true call sets sessions == 1
             # IMMEDIATELY; consuming the outcome does NOT increment again;
             # a following agent node then cap-finishes the run as "capped"
             # (decision 4: reserved at start)

    def test_budget_exhausted_leaves_call_pending(self):
        ...  # cap already spent, call unit pending -> _pick does NOT start
             # a child; unit stays pending (never a silent skip)

    def test_done_marked_child_without_sidecar_records_failure(self):
        ...  # child state file present but status "done" (the _finish
             # could-not-unlink marker), NO sidecar -> unit failure with
             # "sidecar is missing" named; NEVER an eternal wait (CP1)

    def test_reclaim_coexists_with_waiting_call(self):
        ...  # one dispatched AGENT unit (crash reclaim) + one waiting call
             # unit -> ready returns the re-prepared agent STEP, not WAITING
             # (the reclaim contract survives the new protocol)
```

(Write the `...` bodies in full — each follows the first three tests' fixture
pattern. `test_child_failure_drives_failure_edges` is the findings-return
end-to-end proof and MUST assert the compiled brief text contains the parked
findings value.)

- [ ] **Step 2: Run to verify failure**

`python3 -m unittest tests.test_pipeline.CallWalkTest -v` → FAIL (today the
call candidate raises inside `_prepare_step` — no brief).

- [ ] **Step 3: Implement**

New sweep + dispatch helpers (beside `_pick`):

```python
def _record_call_entry(state, uid, nid, outcome, extra):
    """Append a call node's journal entry + resolve the unit terminal state
    through the SAME rails a session record uses (via/back-edges/skips).
    Does NOT touch state["sessions"] -- the budget is RESERVED at call START
    (_start_call_unit, decision 4), never at consumption. Containers: a call
    node inside a container advances container_pos exactly like
    record_outcome's mid-container arm."""
    doc = state["doc"]
    entry = {"id": nid, "type": "call_pipeline", "outcome": outcome,
             "unit": uid,
             "via": sorted(set(e["on"] for e in _incoming_edges(doc, uid)
                               if _edge_state(state, e) == "satisfied")),
             "session_log": ""}
    entry.update(extra)
    state["nodes_done"].append(entry)
    unit = state["units"][uid]
    con = _con_by_id(doc, uid)
    status = "success" if outcome == "success" else "failure"
    if con is None:
        unit["status"] = status
    else:
        pos = int(state["container_pos"].get(uid, 0))
        children = con["children"]
        if status == "failure":
            unit["status"] = "failure"
        elif pos == len(children) - 1:
            # loop-exit verdicts come from sessions; a call as the last loop
            # child exits on success (documented in docs/pipelines.md)
            unit["status"] = "success"
        else:
            state["container_pos"][uid] = pos + 1
            unit["status"] = "pending"
    if unit["status"] not in ("pending", "dispatched"):
        _traverse_back_edges(doc, state, uid)
        _propagate_skips(doc, state)


def _child_alive(child_state_path):
    """EARNED liveness: the child state file exists, parses, and says
    in_progress. A done-marked state (_finish's could-not-unlink marker) or
    unreadable/garbage state is NOT alive -- treating it as alive would make
    a lost sidecar wait forever (CP1; prevention-log #18: the reassuring
    verdict is earned). Total reader."""
    try:
        with open(child_state_path, encoding="utf-8") as fh:
            st = json.load(fh)
        return isinstance(st, dict) and st.get("status") == "in_progress"
    except (OSError, ValueError):
        return False


def _sweep_call_units(state_path, state):
    """Consume terminal children of dispatched call units. The reclaim rule
    refined for calls: sidecar present -> consume; child ALIVE (in_progress
    by its own state, _child_alive) -> keep waiting (NEVER a duplicate
    child); no sidecar + child not alive + state file GONE -> restart the
    child (external interference; duplicate work beats a stranded run); no
    usable sidecar + child done-or-garbage -> record failure
    (prevention-log #18)."""
    doc = state["doc"]
    logdir = os.path.dirname(state_path)
    for uid in _top_units(doc):
        unit = state["units"][uid]
        if unit.get("status") != "dispatched" or "child" not in unit:
            continue
        nid = _expected_node(doc, state, uid)
        child = unit["child"]
        lane = state.get("lane") or ""
        child_base = "%s--%s" % (child, lane) if lane else child
        child_state = os.path.join(logdir,
                                   ".pipeline-run-%s.json" % child_base)
        sidecar = os.path.join(logdir,
                               ".pipeline-run-%s.outcome.json" % child_base)
        try:
            with open(sidecar, encoding="utf-8") as fh:
                payload = json.load(fh)
            if not isinstance(payload, dict):
                raise ValueError("not an object")
        except OSError:
            if _child_alive(child_state):
                continue                          # child alive: wait
            if not os.path.exists(child_state):
                del unit["child"]                 # vanished: restart
                _start_call_unit(state_path, state, uid,
                                 _node_by_id(doc, nid))
                continue
            # done-marked/garbage child state with NO sidecar: the outcome
            # is unrecoverable -- record failure, never wait forever
            _record_call_entry(state, uid, nid, "failure",
                               {"child_run": child,
                                "error": "child finished but its outcome "
                                         "sidecar is missing"})
            continue
        except ValueError as exc:
            if _child_alive(child_state):
                continue                          # child alive: not terminal yet
            _record_call_entry(state, uid, nid, "failure",
                               {"child_run": child,
                                "error": "corrupt child outcome: %s" % exc})
            _unlink_quiet(sidecar)
            continue
        outcome = "success" if payload.get("outcome") == "success" \
            else "failure"                        # earned, never defaulted
        outs = payload.get("outputs")
        if isinstance(outs, dict) and outs:
            rel = _node_outputs_rel(state_path, nid)
            path = os.path.join(logdir, os.path.basename(rel))
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(outs, fh)
            os.replace(tmp, path)
        extra = {"child_run": payload.get("run_id", child),
                 "child_outcome": str(payload.get("outcome"))}
        if "error" in payload:
            extra["error"] = str(payload["error"])
        _record_call_entry(state, uid, nid, outcome, extra)
        _unlink_quiet(sidecar)


def _unlink_quiet(path):
    try:
        os.unlink(path)
    except OSError:
        pass


def _start_call_unit(state_path, state, uid, node):
    """Dispatch a call candidate: RESERVE one budget unit (decision 4 --
    sessions += 1 at START, whatever happens next), then start the child
    (wait:true parks the unit dispatched; wait:false records success NOW).
    Start failures record a named unit failure -- the walk continues on
    failure edges, never crashes (prevention-log #3: a refused call is a
    loud failure, not a skipped node)."""
    repo = (state.get("run") or {}).get("repo", "")
    nid = node["id"]
    state["sessions"] += 1                       # the cap counts dispatches
    try:
        child_name, _cpath = start_child_run(repo, state_path, state, node)
    except PipelineError as exc:
        _record_call_entry(state, uid, nid, "failure",
                           {"child_run": "", "error": str(exc)})
        return
    if node.get("wait", True):
        state["units"][uid]["status"] = "dispatched"
        state["units"][uid]["child"] = child_name
    else:
        _record_call_entry(state, uid, nid, "success",
                           {"child_run": child_name, "detached": True})
```

(A RESTART from the sweep (vanished child) also passes through here and pays a
fresh budget unit — deliberate: restarts are dispatches, and the cap is what
bounds a pathological delete-restart loop.)

`_pick` rework — sweep first, call-aware dispatch loop, waiting exit (full
replacement of the body from `candidates = ...`):

```python
def _pick(state_path, state, n, brief_path_for, journal_path):
    doc = state["doc"]
    _sweep_call_units(state_path, state)
    cap = doc["caps"]["max_sessions_per_run"]
    avail = cap - state["sessions"]
    if avail <= 0 and not _any_dispatched(doc, state):
        return "done", _finish(state, state_path, "capped", journal_path)
    candidates = _pick_candidates(doc, state)
    if not candidates:
        if _any_dispatched(doc, state):
            raise PipelineError("no candidates but a batch is outstanding "
                                "in %s -- refusing" % state_path)
        pending = [u for u in _top_units(doc)
                   if state["units"][u]["status"] == "pending"]
        if pending:
            raise PipelineError("walk stalled with pending units %s in %s -- "
                                "refusing" % (", ".join(pending), state_path))
        return "done", _finish(state, state_path, _walk_outcome(doc, state),
                               journal_path)
    n_eff = max(1, min(n, int(doc["caps"].get("max_parallel", 1)), avail))
    steps = []
    for uid in candidates:
        nid = _expected_node(doc, state, uid)
        node = _node_by_id(doc, nid)
        if node is not None and node.get("type") == "call_pipeline":
            if state["units"][uid]["status"] == "dispatched":
                continue                    # waiting on its child (sweep owns it)
            if state["sessions"] >= cap:
                continue                    # budget spent: stays pending (dec. 4)
            _start_call_unit(state_path, state, uid, node)
            continue
        if len(steps) >= n_eff:
            continue
        steps.append(_prepare_step(state_path, state, uid,
                                   brief_path_for(uid)))
        state["units"][uid]["status"] = "dispatched"
    _atomic_write_json(state_path, state)
    if steps:
        return "steps", steps
    if _any_dispatched(doc, state):
        return "waiting", None
    # every candidate this pass was a call unit that resolved immediately
    # (wait:false or start-failure) -- re-enter for the next frontier
    return _pick(state_path, state, n, brief_path_for, journal_path)
```

(Note the reclaim contract survives untouched: a dispatched PLAIN unit is still
a candidate and is re-prepared into `steps` exactly as before — `waiting` is
only reachable when every dispatched unit is a call unit whose child is being
waited on. A regression test pins the coexistence: one dispatched agent unit +
one waiting call unit → ready returns the re-prepared agent STEP, not WAITING.)

(The tail recursion is bounded: each re-entry either consumed candidates into
terminal states or finishes/waits — at most `len(units)` frames.)

`ready_set` returns the sentinel string for the waiting kind:

```python
    kind, result = _pick(...)
    if kind == "done":
        return []
    if kind == "waiting":
        return "WAITING"
    return result
```

`next_node` mirrors (`return {"status": "waiting"}`), and the CLI `ready`/`next`
branches print `WAITING` (place BEFORE the block loop; `ready`'s CLI already
prints `DONE …` on `[]` — follow its structure).

**Type-consistency note:** `ready_set` now returns `[] | "WAITING" | list[step]`;
its only non-test consumer is the CLI. Update the CLI's `ready` branch:

```python
        steps = ready_set(pos[0], opts["--brief-dir"], n,
                          journal_path=opts["--journal"])
        if steps == "WAITING":
            print("WAITING")
            return 0
        if not steps:
            print("DONE ...")   # existing done-print logic unchanged
```

- [ ] **Step 4: Run to verify pass**

`python3 -m unittest tests.test_pipeline -v` → PASS. Then the shell runner
suite (nothing changed for classic docs — parity):
`bash tests/test_pipeline_runner.sh` → PASS.

- [ ] **Step 5: Same-class scan + commit**

Scan: every consumer of `ready_set`/`next_node` (grep `ready_set\|next_node`
across `lib/ bin/ tests/`) handles the new kind. State the list in the commit.

```bash
git add lib/pipeline.py tests/test_pipeline.py
git commit -m "feat(#376): call_pipeline walk integration -- child sweep, WAITING protocol, call dispatch (Task 5)"
```

---

### Task 6: supervisor — WAITING flag + child tokens end-to-end

**Files:**
- Modify: `bin/supervisor.sh` (`resolve_pipeline_ready` ~line 1685, `run_session`
  ~line 1951, main loop outcome `case` ~line 2537)
- Test: `tests/test_trigger_dispatch.sh`, `tests/test_dashboard_state.py`

**Interfaces:**
- Consumes: `ready` printing `WAITING` (Task 5).
- Produces: `PIPE_WAIT` global; main loop treats a waiting run as a paced no-op
  (no session, no error backoff, no fingerprint record, no session.done edge).

- [ ] **Step 1: Write the failing tests**

In `tests/test_trigger_dispatch.sh` (sourced-supervisor pattern already used
there — stub `python3` via a PATH shim or the established seam the file uses):

```bash
# WAITING: ready prints WAITING -> run_session returns 2 with PIPE_WAIT=1
# and invokes NO adapter
t_waiting_run_is_a_paced_noop() {
  stub_pipeline_ready_output "WAITING"
  PIPE_WAIT=0
  run_session coder shim; rc=$?
  check "waiting rc is dispatch-skip" "2" "$rc"
  check "PIPE_WAIT flag set" "1" "$PIPE_WAIT"
  check "no agent invoked" "0" "$(agent_invocations)"
}

# child state file -> exactly one extra well-formed token (parity inv. 7)
t_child_state_becomes_inflight_token() {
  : >"$LOGDIR/.pipeline-run-coder.json"
  : >"$LOGDIR/.pipeline-run-coder.c0.qa.json"
  out="$(inflight_tokens)"
  case "$out" in
    *"coder.c0.qa"*) check "child token present" 0 0 ;;
    *) check "child token present" 0 1 ;;
  esac
}
```

(Adopt the file's existing helper names for stubs/checks — read the file first;
`stub_pipeline_ready_output`/`agent_invocations` stand for its established
stubbing seam, do not invent a parallel one.)

In `tests/test_dashboard_state.py`:

```python
def test_child_run_state_files_never_crash_build_repo_state(self):
    # drop .pipeline-run-coder.c0.qa.json (valid fmt-2 JSON) into the
    # fixture's var/autonomy-logs; build_repo_state must not raise and the
    # role view stays intact (Phase D renders children; Phase C only
    # tolerates them)
```

- [ ] **Step 2: Run to verify failure**

`bash tests/test_trigger_dispatch.sh` → the WAITING test FAILS (unknown output
shape treated as a refusal today).

- [ ] **Step 3: Implement**

`resolve_pipeline_ready`: add `PIPE_WAIT=0` to the reset block (line ~1689) and
extend the sentinel `case`:

```bash
  case "$out" in
    DONE*) PIPE_DONE=1; return 0 ;;
    WAITING*) PIPE_WAIT=1; return 0 ;;
  esac
```

`run_session`, right after the `PIPE_DONE` block (~line 1955):

```bash
  if [ "$PIPE_WAIT" = "1" ]; then
    # A wait:true call_pipeline child is running as its OWN in-flight token;
    # this run has nothing to dispatch until the child parks its outcome.
    # rc 2 = the dispatch-skip family; the flag refines it in the main loop
    # (no error backoff -- waiting is healthy, not a failure).
    log "pipeline: run for '$role' waiting on child pipeline run(s) -- no session this tick"
    return 2
  fi
```

Main loop — reset the flag before dispatch and branch on it after (around
line 2528):

```bash
    PIPE_WAIT=0
    run_session "$role" "$kind"; outcome=$?
    fp_skips=0
    session_end_park
    if [ "$PIPE_WAIT" = "1" ]; then
      log "run '$role' waiting on child run(s) -- pace ${PACE}s"
      heartbeat "child-wait" "waiting on a child pipeline run" "$(( $(date -u +%s) + PACE ))"
      sleep "$PACE"; continue
    fi
    case $outcome in
    ...
```

(`session_end_park` stays before the branch — the paced no-op must not hold an
attached `main` either. `fp_skips=0` staying unconditional is deliberate: a
waiting tick is not a fingerprint skip.)

- [ ] **Step 4: Run to verify pass**

```
bash tests/test_trigger_dispatch.sh        → PASS
python3 -m unittest tests.test_dashboard_state -v  → PASS
shellcheck -S warning bin/supervisor.sh tests/test_trigger_dispatch.sh
```

- [ ] **Step 5: Commit**

```bash
git add bin/supervisor.sh tests/test_trigger_dispatch.sh tests/test_dashboard_state.py
git commit -m "feat(#376): supervisor WAITING flag -- child runs advance as their own tokens (Task 6)"
```

---

### Task 7: secrets, python side — label passthrough + the `secrets:` sink + NODE_SECRET emission

**Files:**
- Modify: `lib/pipeline.py` (`resolve_params` ~line 518, `_resolve_run_params`
  (Task 4), `_check_expr_static` secret branch ~line 788, `validate_doc`,
  `_substitution_ctx` ~line 1866, `_prepare_step` ~line 1908, `_print_step`
  ~line 2158)
- Test: `tests/test_pipeline.py`

**Interfaces:**
- Consumes: `_NAME_RE`, `_REF_RE`.
- Produces: `resolve_params(declared, overrides)` (kwarg gone); node key
  `secrets`; step dict key `"secrets": {VAR: label}`; CLI lines
  `NODE_SECRET=<VAR>=<label>`; `_SECRET_ENV_RE`, `_SECRET_ENV_DENY`,
  `_SECRET_ENV_DENY_EXACT`.

- [ ] **Step 1: Write the failing tests**

```python
class SecretChannelTest(unittest.TestCase):
    DECL = [{"name": "tok", "type": "secret", "required": True}]

    def test_secret_value_is_a_label_passthrough(self):
        out = pipeline.resolve_params(self.DECL, {"tok": "gh-token"})
        self.assertEqual(out, {"tok": "gh-token"})

    def test_secret_label_charset_gated(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.resolve_params(self.DECL, {"tok": "bad label!"})

    def test_secret_lookup_seam_is_gone(self):
        with self.assertRaises(TypeError):
            pipeline.resolve_params(self.DECL, {"tok": "x"},
                                    secret_lookup=lambda v: v)

    def _doc(self, secrets=None, ptype="secret"):
        return {"name": "s", "version": 1,
                "caps": {"max_sessions_per_run": 4},
                "params": [{"name": "tok", "type": ptype, "required": True}],
                "nodes": [{"id": "a", "type": "agent_task",
                           "brief_ref": "a.md",
                           "secrets": secrets if secrets is not None
                           else {"MY_TOKEN": "${params.tok}"}}]}

    def test_secrets_field_validates(self):
        self.assertEqual(pipeline.validate_doc(self._doc()), [])

    def test_secrets_value_must_be_exact_secret_ref(self):
        for bad in ("${params.tok}x", "${default(params.tok,'')}",
                    "literal", "${run.id}"):
            self.assertTrue(pipeline.validate_doc(self._doc({"V": bad})), bad)

    def test_secrets_ref_must_target_secret_typed_param(self):
        self.assertTrue(pipeline.validate_doc(self._doc(ptype="string")))

    def test_secrets_key_charset_and_denylist(self):
        for bad in ("lower", "1X", "ANTHROPIC_API_KEY", "AUTONOMY_X",
                    "PATH", "DYLD_INSERT_LIBRARIES"):
            self.assertTrue(
                pipeline.validate_doc(self._doc({bad: "${params.tok}"})), bad)

    def test_secret_ref_outside_secrets_still_refuses(self):
        doc = self._doc()
        doc["nodes"][0]["runs_as"] = {"model": "${params.tok}"}
        errs = pipeline.validate_doc(doc)
        self.assertTrue(any("secret" in e for e in errs), errs)

    def test_secret_params_stripped_from_substitution_ctx(self):
        state = {"params": {"tok": "gh-token"},
                 "doc": {"params": self.DECL}, "run": {}}
        ctx = pipeline._substitution_ctx("/tmp/x.json", state)
        self.assertNotIn("tok", ctx["params"])

    def test_prepare_emits_node_secret_lines(self):
        ...  # full prepare fixture (tmp pipeline dir + state): the step dict
             # carries {"secrets": {"MY_TOKEN": "gh-token"}} and the CLI
             # `ready` output contains NODE_SECRET=MY_TOKEN=gh-token

    def test_saved_secret_default_now_resolves_as_label(self):
        decl = [{"name": "tok", "type": "secret", "default": "gh-token"}]
        out = pipeline.resolve_params(decl, {})
        self.assertEqual(out, {"tok": "gh-token"})
```

Also FLIP the Phase B pins in the same commit (they pinned the no-sink
refusal): the `start_run_trigger` secrets-refusal tests now assert the run
STARTS and `state["params"]` carries the label. Name them in the commit body.

- [ ] **Step 2: Run to verify failure**

`python3 -m unittest tests.test_pipeline.SecretChannelTest -v` → FAIL.

- [ ] **Step 3: Implement**

Constants (beside `_REF_RE`):

```python
_SECRET_ENV_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_SECRET_ENV_DENY = ("ANTHROPIC_", "AUTONOMY_", "CLAUDE_", "LD_", "DYLD_")
_SECRET_ENV_DENY_EXACT = frozenset(
    ("PATH", "HOME", "SHELL", "IFS", "ENV", "BASH_ENV", "PYTHONPATH"))
```

`resolve_params`: signature drops `secret_lookup`; the secret arm becomes:

```python
        if typ == "secret":
            if not (_is_str(value) and _NAME_RE.match(value)):
                raise PipelineError(
                    "param %r: a secret's value is a credential LABEL "
                    "(charset [A-Za-z0-9._-]{1,64}), got %r -- the value "
                    "resolves only at the dispatch env sink" % (name, value))
            out[name] = value
            continue
```

`_resolve_run_params` (Task 4): DELETE the `resolving_secrets` refusal block in
this same commit — the sink now exists; labels are non-secret state (SD-8).
Update its docstring: "secret params resolve to credential LABELS here; the
VALUE resolves only supervisor-side at the env sink."

`_check_expr_static` secret branch message becomes:

```python
        elif decl.get("type") == "secret":
            errors.append("%s: ${params.%s} is secret-typed -- its only "
                          "sink is a node's secrets: map (the env channel); "
                          "briefs, runs_as and call params never carry a "
                          "secret" % (where, parts[1]))
```

`validate_doc`: `_NODE_KEYS` gains `"secrets"`; add after `_validate_runs_as`:

```python
        _validate_secrets_field(where, node, doc, errors)
```

```python
def _validate_secrets_field(where, node, doc, errors):
    sec = node.get("secrets")
    if sec is None:
        return
    if node.get("type") == "call_pipeline":
        return   # Task 3's type-branch owns that refusal -- one error, not two
    if not isinstance(sec, dict) or not sec:
        errors.append("%s: secrets must be a non-empty mapping "
                      "ENV_VAR -> ${params.<secret-typed>}" % where)
        return
    decl = {p.get("name"): p for p in (doc.get("params") or [])
            if isinstance(p, dict)}
    for var, ref in sec.items():
        if not (isinstance(var, str) and _SECRET_ENV_RE.match(var)):
            errors.append("%s: secrets key %r must match "
                          "[A-Z][A-Z0-9_]{0,63}" % (where, var))
        elif var in _SECRET_ENV_DENY_EXACT or any(
                var.startswith(p) for p in _SECRET_ENV_DENY):
            errors.append("%s: secrets key %r would shadow an engine/auth "
                          "variable -- refused" % (where, var))
        pname = _secret_ref_param(ref)
        if pname is None:
            errors.append("%s: secrets.%s must be EXACTLY "
                          "${params.<name>} -- a secret never mixes into a "
                          "string or function" % (where, var))
        elif (decl.get(pname) or {}).get("type") != "secret":
            errors.append("%s: secrets.%s references %r which is not a "
                          "declared secret param" % (where, var, pname))


def _secret_ref_param(ref):
    """'${params.x}' -> 'x'; anything else -> None. No regex re-use of the
    generic scanner: the EXACT form is the security property."""
    if not isinstance(ref, str):
        return None
    m = re.match(r"^\$\{params\.([A-Za-z0-9._-]{1,64})\}$", ref)
    return m.group(1) if m else None
```

`check_refs`: exclude the field from the generic scan (its own validator above
owns it): `clean = {k: v for k, v in node.items() if k not in _REF_FREE_FIELDS
and k != "secrets"}`.

`_substitution_ctx` strips secret-typed params (defense in depth — an escaped
ref now raises "unknown param" at prepare):

```python
def _substitution_ctx(state_path, state):
    params = dict(state.get("params") or {})
    for p in (state.get("doc") or {}).get("params") or []:
        if isinstance(p, dict) and p.get("type") == "secret":
            params.pop(p.get("name"), None)
    return {"params": params,
            "nodes": _collect_node_outputs(state_path, state),
            "run": state.get("run") or {}}
```

`_prepare_step`, after the runs_as block:

```python
    secrets_map = {}
    for var, ref in (node.get("secrets") or {}).items():
        pname = _secret_ref_param(ref)
        label = (state.get("params") or {}).get(pname) if pname else None
        if not (isinstance(label, str) and _NAME_RE.match(label)):
            raise PipelineError("node %r: secrets.%s has no resolvable "
                                "credential label -- refusing dispatch"
                                % (node["id"], var))
        secrets_map[var] = label
    step = {"status": "node", "unit": uid, "node": node["id"], "kind": kind,
            "prompt": prompt, "verdict": verdict_rel, "runs_as": merged}
    if secrets_map:
        step["secrets"] = secrets_map
    return step
```

`_print_step` appends (labels are index names — non-secret, SD-8):

```python
    for var in sorted(step.get("secrets") or {}):
        print("NODE_SECRET=%s=%s" % (var, step["secrets"][var]))
```

- [ ] **Step 4: Run to verify pass**

`python3 -m unittest tests.test_pipeline -v` → PASS (including the flipped
Phase B pins).

- [ ] **Step 5: Same-class scan + commit**

Scan: grep `secret_lookup` repo-wide — every reference deleted (lib, tests,
docs). Grep `resolving_secrets` — gone. State both in the commit body.

```bash
git add lib/pipeline.py tests/test_pipeline.py
git commit -m "feat(#376): secret env channel, python side -- label passthrough + secrets: sink + NODE_SECRET (Task 7, decisions 10-11)"
```

---

### Task 8: secrets, supervisor side — resolution, scoped export, redaction sweep

**Files:**
- Modify: `bin/supervisor.sh` (`resolve_pipeline_ready` parser ~line 1712,
  `run_single_session` ~line 2049, `dispatch_batch` ~line 2122, new helpers
  beside `resolve_role_credential` ~line 709)
- Test: `tests/test_trigger_dispatch.sh` (or `tests/test_pipeline_runner.sh`,
  whichever already stubs the ready-block parse — put the tests beside the
  existing NODE_MODEL parse tests)

**Interfaces:**
- Consumes: `NODE_SECRET=<VAR>=<label>` lines (Task 7); `credentials.py get
  <label>` (prints value, rc 1 when missing — verified); `invoke_scoped_env`;
  `AUTONOMY_CREDENTIALS_BIN` test seam.
- Produces: `PB_SECRET[i]` array (newline-joined `VAR=label`);
  `resolve_node_secret_env` (consumes `$1`=VAR=label lines + `$2`=existing
  env_lines, sets `NS_ENV_LINES` + `NS_VALUES`, rc 1 REFUSE);
  `redact_session_log <log>` (reads `NS_VALUES`).

- [ ] **Step 1: Write the failing tests**

```bash
# NODE_SECRET parse: malformed line REFUSES the block (a session missing its
# secret is a broken constraint artifact -- prevention-log #3, account parity)
t_node_secret_malformed_refuses() { ... }   # NODE_SECRET=noequals -> rc 1
t_node_secret_bad_var_refuses()   { ... }   # NODE_SECRET=my-var=lbl -> rc 1
t_node_secret_parsed_per_block()  { ... }   # two blocks, distinct PB_SECRET[i]

# resolution: label -> value via the AUTONOMY_CREDENTIALS_BIN seam
t_secret_resolves_into_env_lines() {
  AUTONOMY_CREDENTIALS_BIN="$STUB_DIR/cred_ok"     # prints "s3cr3t-value"
  if resolve_node_secret_env "MY_TOKEN=gh-token" "A=1"; then rc=0; else rc=1; fi
  check "resolves" "0" "$rc"
  case "$NS_ENV_LINES" in *"MY_TOKEN=s3cr3t-value"*) ok=0;; *) ok=1;; esac
  check "env line built" "0" "$ok"
}
t_secret_missing_refuses() { ... }          # stub rc 1 -> rc 1, NS_ENV_LINES=""
t_secret_dup_of_account_var_refuses() { ... } # $2 already has MY_TOKEN= -> rc 1
t_secret_newline_value_refuses() { ... }     # stub prints 2 lines -> rc 1
t_node_secret_denylisted_var_refuses() { ... } # NODE_SECRET=ANTHROPIC_API_KEY=x
                                               # -> resolve_pipeline_ready rc 1
t_secret_value_never_logged() { ... }        # SUPLOG contains "gh-token" is OK,
                                             # "s3cr3t-value" is NOT
# redaction sweep
t_redact_session_log_scrubs_value() {
  printf 'before s3cr3t-value after\n' >"$LOGDIR/s.log"
  NS_VALUES="s3cr3t-value"
  redact_session_log "$LOGDIR/s.log"
  case "$(cat "$LOGDIR/s.log")" in
    *s3cr3t-value*) check "scrubbed" 0 1 ;;
    *"[REDACTED]"*) check "scrubbed" 0 0 ;;
  esac
}
```

(`cred_ok`/`cred_missing` stubs: 3-line scripts in the test's tmp dir honouring
`credentials.py`'s CLI shape — `get <label>` → stdout value / rc 1. The
`AUTONOMY_CREDENTIALS_BIN` seam already exists for `resolve-role`; reuse it.)

- [ ] **Step 2: Run to verify failure**

`bash tests/test_trigger_dispatch.sh` → new tests FAIL (functions undefined).

- [ ] **Step 3: Implement**

Parser: `resolve_pipeline_ready` gains `secrets=""` in the per-block reset, a
`PB_SECRET` array in the declarations/reset block, `PB_SECRET[i]="$secrets"` in
the END arm, and:

```bash
      NODE_SECRET)
        # VAR=label; both land in argv/env keys later -- refuse the whole
        # block on any malformed line (a session running WITHOUT a declared
        # secret is a broken constraint artifact, prevention-log #3).
        case "$val" in *=*) ;; *)
          log "pipeline: malformed NODE_SECRET line -- REFUSING"; return 1 ;;
        esac
        _sv="${val%%=*}"; _sl="${val#*=}"
        case "$_sv" in
          [A-Z]*) ;;
          *) log "pipeline: NODE_SECRET var name invalid -- REFUSING"; return 1 ;;
        esac
        case "$_sv" in *[!A-Z0-9_]*)
          log "pipeline: NODE_SECRET var name invalid -- REFUSING"; return 1 ;;
        esac
        # Defense-in-depth twin of the python denylist (CP1: ready-block
        # stdout is an interface boundary -- re-check at the point of use,
        # prevention-log #6).
        case "$_sv" in
          ANTHROPIC_*|AUTONOMY_*|CLAUDE_*|LD_*|DYLD_*|PATH|HOME|SHELL|IFS|ENV|BASH_ENV|PYTHONPATH)
            log "pipeline: NODE_SECRET var '$_sv' shadows an engine/auth variable -- REFUSING"; return 1 ;;
        esac
        case "$_sl" in ''|*[!A-Za-z0-9._-]*)
          log "pipeline: NODE_SECRET label invalid -- REFUSING"; return 1 ;;
        esac
        secrets="${secrets}${_sv}=${_sl}
" ;;
```

Helpers (beside `resolve_role_credential`):

```bash
# Resolve NODE_SECRET labels to values -- FOREGROUND, fail-safe: any failure
# REFUSES (rc 1) with only the LABEL named; the value never reaches a log or
# argv (SD-8). $1 = newline VAR=label lines; $2 = the env lines already
# resolved (account auth) -- a duplicate VAR refuses rather than clobbering
# auth. Sets NS_ENV_LINES (VAR=value lines) + NS_VALUES (values, for the
# redaction sweep). Globals, not stdout: a $() subshell could not set them.
resolve_node_secret_env() {
  local lines="$1" existing="$2" line var label value
  NS_ENV_LINES=""; NS_VALUES=""
  [ -n "$lines" ] && mkdir -p "$LOGDIR" 2>/dev/null
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    var="${line%%=*}"; label="${line#*=}"
    case "$existing" in
      "$var="*|*"
$var="*)
        log "dispatch: secret env var '$var' collides with resolved auth env -- REFUSING session"
        NS_ENV_LINES=""; NS_VALUES=""; return 1 ;;
    esac
    if [ -n "${AUTONOMY_CREDENTIALS_BIN:-}" ]; then
      value="$("$AUTONOMY_CREDENTIALS_BIN" get "$label" 2>>"$SUPLOG")" || value=""
    else
      value="$(python3 "$ENGINE_HOME/lib/credentials.py" get "$label" 2>>"$SUPLOG")" || value=""
    fi
    if [ -z "$value" ]; then
      log "dispatch: secret '$label' (for $var) did not resolve -- REFUSING session (fail-safe)"
      NS_ENV_LINES=""; NS_VALUES=""; return 1
    fi
    case "$value" in
      *$'\n'*|*$'\r'*)
        # CP1: an embedded newline would corrupt the VAR=value line protocol
        # AND the redaction value list -- refuse, never truncate/mangle.
        log "dispatch: secret '$label' (for $var) contains a newline -- REFUSING session (unsupported shape)"
        NS_ENV_LINES=""; NS_VALUES=""; return 1 ;;
    esac
    NS_ENV_LINES="${NS_ENV_LINES}${var}=${value}
"
    NS_VALUES="${NS_VALUES}${value}
"
  done <<EOF
$lines
EOF
  return 0
}

# Best-effort post-session redaction: replace every resolved secret value in
# the session log with [REDACTED]. Runs AFTER classify (the outcome grep must
# see the raw log) -- documented residual: a live tail can see an agent-echoed
# secret until this runs. Values reach python via STDIN, never env or argv
# (CP1: a child's environment is inspectable via `ps` -- stdin is not; SD-8's
# boundary stays "supervisor memory + the session's own subshell env").
# Literal byte replace (no regex metachars). Newline-free values guaranteed
# by resolve_node_secret_env, so one value per stdin line is unambiguous.
redact_session_log() {
  local logf="$1"
  [ -n "${NS_VALUES:-}" ] && [ -f "$logf" ] || return 0
  printf '%s' "$NS_VALUES" | python3 -c '
import sys
path = sys.argv[1]
vals = [v for v in sys.stdin.read().split("\n") if v]
data = open(path, "rb").read()
for v in vals:
    data = data.replace(v.encode("utf-8"), b"[REDACTED]")
open(path, "wb").write(data)
' "$logf" 2>>"$SUPLOG" || log "WARN could not redact session log $logf"
}
```

Wiring — `run_single_session` (block 0), after the verdict `rm -f` and before
`invoke_scoped_env`:

```bash
  NS_ENV_LINES=""; NS_VALUES=""
  if [ -n "${PB_SECRET[0]}" ]; then
    resolve_node_secret_env "${PB_SECRET[0]}" "$env_lines" || return 2
    env_lines="${env_lines}
${NS_ENV_LINES}"
  fi
```

and after `agent_classify_outcome`:

```bash
  redact_session_log "$log_file"
```

`dispatch_batch`: per-block, in the setup loop (beside the per-block account
resolution — same foreground/fail-safe pattern):

```bash
    if [ -n "${PB_SECRET[i]}" ]; then
      if ! resolve_node_secret_env "${PB_SECRET[i]}" "$envl"; then
        log "dispatch: node '${PB_NODE[i]}' secret did not resolve -- REFUSING batch (fail-safe)"
        abort_batch
        return 2
      fi
      envl="${envl}
${NS_ENV_LINES}"
      ns_vals[i]="$NS_VALUES"
    fi
```

(`local ns_vals=()` declared beside the other per-block arrays — PER-LOG
values, CP1: aggregating every block's values and sweeping them across every
log would widen the blast radius and blur the per-session redaction tests.)
In the collection loop, after each classify:
`NS_VALUES="${ns_vals[i]:-}" redact_session_log "${logs[i]}"`.

- [ ] **Step 4: Run to verify pass**

```
bash tests/test_trigger_dispatch.sh → PASS
shellcheck -S warning bin/supervisor.sh tests/test_trigger_dispatch.sh
bash tests/run_all.sh → PASS
```

- [ ] **Step 5: Same-class scan + commit**

Scan: every `log`/`printf` line touched in this diff — none may carry `$value`,
`$NS_ENV_LINES`, `$NS_VALUES`, `$envl` (grep the diff for those vars inside
`log "` lines). State it in the commit.

```bash
git add bin/supervisor.sh tests/test_trigger_dispatch.sh
git commit -m "feat(#376): secret env channel, supervisor side -- foreground resolve + scoped export + redaction sweep (Task 8, decision 12)"
```

---

### Task 9: event triggers — schema, `event` CLI, `--event-field` start channel (refusals INTACT)

**Files:**
- Modify: `lib/triggers.py` (`FIRING_MODES`/`_FIRING_KEYS` ~line 24,
  `validate_trigger` ~line 86, `main` ~line 293)
- Modify: `lib/pipeline.py` (`start_run_trigger` ~line 1396, CLI `start`
  ~line 2187)
- Test: `tests/test_triggers.py`, `tests/test_pipeline.py`

**Interfaces:**
- Produces: `EVENT_KINDS = ("pr.opened", "issue.created", "merge.done",
  "pr.synchronize")`; `EVENT_FIELDS = ("item", "sha", "event")`;
  native trigger schema `firing: {mode: "event", event, map?}`;
  `triggers.py event <repo> [--lane l]` → TSV `name kind evspec policy max`;
  `start_run_trigger(..., event_fields=None)`;
  `pipeline.py start … --event-field k=v` (repeatable, k ∈ item|sha).
- **Both Phase B collision refusals stay in force this task** (decision 15):
  `enumerate_triggers`' event-role refusal and `start_run_trigger`'s chokepoint.
  Native event triggers validate + enumerate but NOTHING fires them yet.

- [ ] **Step 1: Write the failing tests**

`tests/test_triggers.py`:

```python
class EventTriggerSchemaTest(unittest.TestCase):
    def _trig(self, firing=None, **kw):
        t = {"name": "qa-on-pr", "pipeline": "qa-sweep",
             "params": {"repo": "/r"},
             "firing": firing or {"mode": "event", "event": "pr.opened",
                                  "map": {"pr": "item"}}}
        t.update(kw)
        return t

    def test_event_mode_validates(self):
        self.assertEqual(triggers.validate_trigger(self._trig(), "qa-on-pr"), [])

    def test_event_kind_closed_vocabulary(self):
        for bad in ("session.done", "push", ""):
            t = self._trig({"mode": "event", "event": bad})
            self.assertTrue(triggers.validate_trigger(t, "qa-on-pr"), bad)

    def test_map_fields_closed(self):
        t = self._trig({"mode": "event", "event": "pr.opened",
                        "map": {"pr": "body"}})
        self.assertTrue(triggers.validate_trigger(t, "qa-on-pr"))

    def test_sha_only_for_synchronize(self):
        t = self._trig({"mode": "event", "event": "pr.opened",
                        "map": {"s": "sha"}})
        self.assertTrue(triggers.validate_trigger(t, "qa-on-pr"))
        t = self._trig({"mode": "event", "event": "pr.synchronize",
                        "map": {"s": "sha"}})
        self.assertEqual(triggers.validate_trigger(t, "qa-on-pr"), [])

    def test_map_overlap_with_static_params_refused(self):
        t = self._trig({"mode": "event", "event": "pr.opened",
                        "map": {"repo": "item"}})
        self.assertTrue(triggers.validate_trigger(t, "qa-on-pr"))

    def test_queue_policy_refused_for_event_mode(self):
        t = self._trig(concurrency={"policy": "queue", "max": 1})
        self.assertTrue(triggers.validate_trigger(t, "qa-on-pr"))

    def test_event_key_refused_on_other_modes(self):
        t = self._trig({"mode": "continuous", "event": "pr.opened"})
        self.assertTrue(triggers.validate_trigger(t, "qa-on-pr"))

class EventCliTest(unittest.TestCase):
    ...  # tmp repo: one native event trigger file + config WITHOUT event
         # roles -> `triggers.py event` prints "qa-on-pr\tnative\tpr.opened\tskip\t1";
         # continuous/cron/manual listings do NOT include it; `dispatch`
         # unchanged (parity)

class EventStartChannelTest(unittest.TestCase):   # tests/test_pipeline.py ok too
    ...  # start_run_trigger(..., event_fields={"item": "42"}) on a mapped
         # native trigger resolves the param (number 42 via _coerce);
         # event_fields on a continuous trigger REFUSES; a mapped trigger
         # started with NO event_fields REFUSES; map targeting a secret-typed
         # child param REFUSES; the implicit field event=<kind> maps too
```

- [ ] **Step 2: Run to verify failure**

`python3 -m unittest tests.test_triggers -v` → FAIL (event mode still in
`DEFERRED_FIRING_MODES`).

- [ ] **Step 3: Implement**

`lib/triggers.py` constants:

```python
_FIRING_KEYS = frozenset(("mode", "schedule", "event", "map"))
FIRING_MODES = ("continuous", "schedule", "manual", "event")
EVENT_KINDS = ("pr.opened", "issue.created", "merge.done", "pr.synchronize")
EVENT_FIELDS = ("item", "sha", "event")
```

(delete `DEFERRED_FIRING_MODES` and its validate branch — grep-check nothing
else reads it.)

`validate_trigger` firing block additions:

```python
        if mode == "event":
            ev = firing.get("event")
            if ev not in EVENT_KINDS:
                errors.append("firing.event: must be one of %s "
                              "(session.done is an internal loop edge, "
                              "not a subscribable event)"
                              % ", ".join(EVENT_KINDS))
            mp = firing.get("map")
            if mp is not None:
                if not isinstance(mp, dict):
                    errors.append("firing.map: must be {param: item|sha|event}")
                else:
                    for k, v in mp.items():
                        if not (isinstance(k, str)
                                and pipeline._NAME_RE.match(k)):
                            errors.append("firing.map: key %r invalid "
                                          "charset" % (k,))
                        if v not in EVENT_FIELDS:
                            errors.append("firing.map.%s: field must be one "
                                          "of %s" % (k, ", ".join(EVENT_FIELDS)))
                        elif v == "sha" and ev != "pr.synchronize":
                            errors.append("firing.map.%s: 'sha' exists only "
                                          "on pr.synchronize payloads" % k)
                        if isinstance(params, dict) and k in params:
                            errors.append("firing.map.%s: also set in params "
                                          "-- one source per param, remove "
                                          "one" % k)
        else:
            for k in ("event", "map"):
                if k in firing:
                    errors.append("firing.%s: only valid with mode=event" % k)
```

and in the concurrency block, after the queue-bound check:

```python
            elif pol == "queue" and (trig.get("firing") or {}).get(
                    "mode") == "event":
                errors.append("concurrency: queue is not valid for event "
                              "mode -- the event seen-set redelivers "
                              "unhandled tokens, which IS the queue")
```

CLI `event` subcommand (beside `cron`; shims are Task 10 — until then this
lists natives only, and the test pins that):

```python
    if cmd == "event":
        try:
            trigs, warns = enumerate_triggers(pos[0], lane)
        except PipelineError as exc:
            print("triggers event: %s" % exc, file=sys.stderr)
            return 1
        for w in warns:
            print("WARN %s" % w, file=sys.stderr)
        for t in trigs:
            f = t["firing"]
            if f.get("mode") != "event":
                continue
            c = t["concurrency"]
            spec = f.get("events_csv") if t["kind"] == "shim" else f.get("event")
            print("%s\t%s\t%s\t%s\t%d" % (t["name"], t["kind"], spec,
                                          c["policy"], c["max"]))
        return 0
```

(add `event` to the `cmd in ("dispatch", "cron", "validate")` usage-gate tuple.)

`lib/pipeline.py` — `start_run_trigger` gains `event_fields=None`; after
`load_trigger` + the (still-present) collision block, replace
`overrides = trig["params"]` usage:

```python
    firing = trig.get("firing") or {}
    overrides = dict(trig["params"])
    mapping = firing.get("map") or {}
    if event_fields is not None and firing.get("mode") != "event":
        raise PipelineError("trigger %r: event fields supplied to a "
                            "non-event trigger -- refusing" % trigger_name)
    if firing.get("mode") == "event" and mapping and event_fields is None:
        raise PipelineError("trigger %r maps event payload fields but no "
                            "event fields were supplied -- an event run "
                            "starts from the event resolver" % trigger_name)
    if event_fields is not None:
        fields = dict(event_fields)
        fields.setdefault("event", firing.get("event", ""))
        for pname, fld in mapping.items():
            if fld not in fields or fields[fld] in (None, ""):
                raise PipelineError("trigger %r: event payload has no field "
                                    "%r for param %r" % (trigger_name, fld,
                                                         pname))
            overrides[pname] = fields[fld]
```

and after `doc, meta = resolve_pipeline_doc(...)`:

```python
    if event_fields is not None:
        decl_types = {p.get("name"): p.get("type")
                      for p in (doc.get("params") or []) if isinstance(p, dict)}
        for pname in mapping:
            if decl_types.get(pname) == "secret":
                raise PipelineError("trigger %r: firing.map targets secret "
                                    "param %r -- an event payload is never a "
                                    "credential" % (trigger_name, pname))
    params = _resolve_run_params(repo, doc, overrides,
                                 known_repos=known_repos,
                                 known_accounts=known_accounts)
```

CLI `start`: collect repeatable `--event-field` before `_split_opts` (it only
handles single-valued opts):

```python
        ev_fields, rest2 = {}, []
        i = 0
        while i < len(rest):
            if rest[i] == "--event-field" and i + 1 < len(rest):
                kv = rest[i + 1]
                k, _, v = kv.partition("=")
                if k not in ("item", "sha") or not v or \
                        not re.match(r"^[A-Za-z0-9:._-]{1,128}$", v):
                    print("pipeline start: bad --event-field %r" % kv,
                          file=sys.stderr)
                    return 2
                if k in ev_fields:
                    # payload mapping is a control boundary: a silent
                    # last-wins on a duplicate field is fail-open (CP1)
                    print("pipeline start: duplicate --event-field %r" % k,
                          file=sys.stderr)
                    return 2
                ev_fields[k] = v
                i += 2
            else:
                rest2.append(rest[i])
                i += 1
        rest = rest2
```

and pass `event_fields=ev_fields or None` into `start_run_trigger` (native arm
only; `--event-field` with `--kind shim` → usage error, print + rc 2).

- [ ] **Step 4: Run to verify pass**

`python3 -m unittest tests.test_triggers tests.test_pipeline -v` → PASS.
Phase B pins that event-collision refusals hold: still PASS untouched (the
proof the window never opened).

- [ ] **Step 5: Commit**

```bash
git add lib/triggers.py lib/pipeline.py tests/test_triggers.py tests/test_pipeline.py
git commit -m "feat(#376): event trigger schema + event CLI + --event-field start channel; collision refusals intact (Task 9, decisions 13-15)"
```

---

### Task 10: the event CUTOVER — ONE commit: shims + new resolver + legacy retirement + refusal removal

**Files:**
- Modify: `lib/triggers.py` (`shim_triggers` ~line 172, `enumerate_triggers`
  ~line 245)
- Modify: `lib/pipeline.py` (`start_run_trigger` collision block ~line 1415)
- Modify: `bin/supervisor.sh` (event section ~line 1368, main loop ~line 2417,
  `has_scheduled_roles` ~line 586)
- Test: `tests/test_triggers.py`, `tests/test_event_bus.sh`

**Interfaces:**
- Consumes: everything from Task 9.
- Produces: event-role shims (`kind: "shim"`, `firing: {mode: "event",
  events_csv}`); `_event_native_wakes`; `resolve_trigger_event_wakes`;
  `has_scheduled_triggers`; `resolve_event_wakes` + `_event_enumerate`
  LEGACY-marked (deletion = Phase E, with the other legacy twins named in SD-39).

- [ ] **Step 1: Write the failing tests**

`tests/test_triggers.py`:

```python
class EventCutoverTest(unittest.TestCase):
    def test_event_roles_are_shimmed(self):
        cfg = {"roles": {"qa": {"enabled": True,
                                "trigger": {"type": "event",
                                            "on": "pr.opened,session.done"}}}}
        shims = [t for t in triggers.shim_triggers(cfg)
                 if t["firing"]["mode"] == "event"]
        self.assertEqual(shims[0]["name"], "qa")
        self.assertEqual(shims[0]["firing"]["events_csv"],
                         "pr.opened,session.done")

    def test_native_supersedes_event_role_shim(self):
        ...  # repo fixture: event role 'qa' + native triggers/qa.json ->
             # enumerate returns the NATIVE, warning notes supersession,
             # NO refusal

    def test_broken_native_still_suppresses_event_shim(self):
        ...  # corrupt qa.json -> refused AND shim absent (hard rail)

    def test_start_run_trigger_no_longer_probes_event_roles(self):
        ...  # trigger named like an event role starts fine; and with an
             # UNREADABLE config it still starts (the config gate existed
             # only for the retired probe -- flip of the Phase B pin)
```

`tests/test_event_bus.sh` (this file exercises the W2 functions by sourcing the
supervisor; extend it):

```bash
# parity 1-3: a SHIM event trigger routed through resolve_trigger_event_wakes
# behaves byte-identically to the legacy resolver (same seen file written,
# same single run_session, failed session leaves seen, first-sight seeds)
t_shim_event_parity() { ... }
# parity 2: session.done fires shims only when session_ran=1
t_shim_session_done_edge() { ... }
# native: START-ONLY, one run per new token -- pipeline.py start called with
# --event-field, run_session NEVER invoked by the native lane (decision 14);
# seen ADVANCES per started token and PRUNES to page; at-capacity token left
t_native_event_starts_run_per_token() { ... }
t_native_lane_never_runs_a_session() { ... }   # run_session stub records argv;
                                               # assert zero invocations
t_native_at_capacity_redelivers() { ... }
# structural: the main loop no longer calls resolve_event_wakes
# ([[:space:]] not \s -- BSD grep has no \s; a silently-unmatched pattern
# would fake the double-dispatch proof, CP1)
t_legacy_resolver_uncalled() {
  n="$(grep -c '^[[:space:]]*resolve_event_wakes ' "$ENGINE_HOME/bin/supervisor.sh" || true)"
  check "legacy event resolver uncalled by the loop" "0" "$n"
}
```

(Stub seams: `_triggers_enumerate` and `_event_poll` are already functions —
override them after sourcing, the file's established pattern. `run_session` is
stubbed to log its argv and return a scripted rc.)

- [ ] **Step 2: Run to verify failure**

`python3 -m unittest tests.test_triggers.EventCutoverTest -v` +
`bash tests/test_event_bus.sh` → FAIL.

- [ ] **Step 3: Implement (ONE commit — the double-dispatch argument lives here)**

`lib/triggers.py` — `shim_triggers` gains (docstring updated: the "event roles
are NOT shimmed" paragraph is replaced by the new contract):

```python
    for name, events_csv in roles.all_event_roles(config):
        out.append(_shim(name, {"mode": "event", "events_csv": events_csv}))
```

`enumerate_triggers`: DELETE the `event_names` set and the
`if stem in event_names:` refusal block (natives now supersede event shims via
the ordinary `native_stems` rule — the very next block).

`lib/pipeline.py` — `start_run_trigger`: DELETE the whole event-collision
chokepoint (the `roles._load_config` read + `all_event_roles` probe, lines
~1415–1429). The config read existed only for that probe; a native start no
longer requires a readable config (enumeration still does — dispatch is
unaffected). Update the Phase B pins accordingly (named in Step 1).

`bin/supervisor.sh` — mark the legacy pair:

```bash
# --- LEGACY event bus (W2, #86) -- pre-Phase-C role-path resolver. Kept for
# the parity tests only (deletion = Phase E, with the other legacy twins);
# the main loop calls resolve_trigger_event_wakes. NEVER call this from new
# code: it enumerates ROLES and would double-dispatch beside the trigger
# resolver.
```

New functions (after the legacy block):

```bash
# --- event triggers (Phase C) ------------------------------------------------
# One resolver, two lanes: SHIM event triggers ride the legacy per-role
# semantics VERBATIM (same _event_role_wakes body, same seen files -- the
# cutover parity argument); NATIVE event triggers are START-ONLY -- one run
# per new token, payload mapped to params inside start_run_trigger, and the
# run's first session lands via the MAIN LOOP like any in-flight token
# (decision 14: sessions only ever run through the one dispatch per
# iteration, SD-12). Best-effort throughout: enumeration/poll failure skips
# events this tick and never perturbs loop dispatch. NEVER returns non-zero.
resolve_trigger_event_wakes() {
  local session_ran="$1"
  local enum line name kind evspec policy max
  enum="$(_triggers_enumerate event "$AUTONOMY_TARGET_REPO")" || {
    log "WARN event: trigger enumeration failed -- skipping events this tick"
    return 0
  }
  [ -n "$enum" ] || return 0
  mkdir -p "$VARDIR/events" 2>/dev/null || {
    log "WARN event: cannot create $VARDIR/events -- skipping events this tick"
    return 0
  }
  while IFS="$(printf '\t')" read -r name kind evspec policy max; do
    [ -n "$name" ] || continue
    if ! _role_name_path_safe "$name"; then
      log "WARN event: trigger name '$name' has invalid path chars -- ignored"
      continue
    fi
    if [ "$kind" = "shim" ]; then
      _event_role_wakes "$name" "$evspec" "$session_ran"
    else
      _event_native_wakes "$name" "$evspec"
    fi
  done <<EOF
$enum
EOF
  return 0
}

# START a NATIVE event trigger's run once per NEW token -- never a session
# here (decision 14). Seen-set discipline: handled tokens append; the set
# prunes to the current poll page (bounded, monotonicity argument
# unchanged); a token is handled when its RUN STARTS (the state file is the
# durable claim -- the main loop advances it as an in-flight token);
# at-capacity/failed-start tokens stay unhandled (redelivered).
_event_native_wakes() {
  local name="$1" event="$2"
  local seen_file tokens new tok item sha handled kept state stok
  case "$event" in
    pr.opened|issue.created|merge.done|pr.synchronize) : ;;
    *) log "WARN event: unknown event '$event' for trigger '$name' -- ignored"
       return 0 ;;
  esac
  seen_file="$VARDIR/events/${name}__${event}.seen"
  tokens="$(_event_poll "$event")" || return 0
  if [ ! -f "$seen_file" ]; then
    _event_write_seen "$seen_file" "$tokens" \
      || log "WARN event: cannot seed seen-set for '$name/$event'"
    return 0
  fi
  new="$(printf '%s\n' "$tokens" | grep -v '^[[:space:]]*$' | grep -Fxv -f "$seen_file" 2>/dev/null || true)"
  # prune the carried-over seen lines to the current page (bounded set)
  kept="$(grep -Fx -f "$seen_file" <<EOF2 2>/dev/null || true
$tokens
EOF2
)"
  handled=""
  while IFS= read -r tok; do
    [ -n "$tok" ] || continue
    case "$event" in
      pr.synchronize) item="${tok%%:*}"; sha="${tok#*:}" ;;
      *)              item="$tok";       sha="" ;;
    esac
    case "$item" in ''|*[!0-9]*)
      log "WARN event: token '$tok' has no numeric item -- ignored"; continue ;;
    esac
    case "$sha" in *[!A-Za-z0-9]*)
      log "WARN event: token '$tok' has a malformed sha -- ignored"; continue ;;
    esac
    if ! stok="$(trigger_start_token_for "$name")"; then
      log "NOTE event: trigger '$name' at capacity -- '$tok' redelivered next tick"
      continue
    fi
    state="$(pipeline_state_file "$(token_name "$stok")" "$(token_slot "$stok")")"
    if [ -n "${AUTONOMY_LANE:-}" ]; then
      python3 "$ENGINE_HOME/lib/pipeline.py" start "$AUTONOMY_TARGET_REPO" \
        "$name" "$state" --lane "$AUTONOMY_LANE" --kind native \
        --event-field "item=$item" ${sha:+--event-field "sha=$sha"} \
        >>"$SUPLOG" 2>&1
    else
      python3 "$ENGINE_HOME/lib/pipeline.py" start "$AUTONOMY_TARGET_REPO" \
        "$name" "$state" --kind native \
        --event-field "item=$item" ${sha:+--event-field "sha=$sha"} \
        >>"$SUPLOG" 2>&1
    fi
    if [ $? -ne 0 ]; then
      log "WARN event: could not start trigger '$name' for $event '$tok' -- redelivered next tick"
      continue
    fi
    log "event: trigger '$name' fired by $event ($tok) -> run started ($stok); the loop advances it"
    handled="${handled}${tok}
"
  done <<EOF3
$new
EOF3
  printf '%s%s' "$kept${kept:+
}" "$handled" | grep -v '^[[:space:]]*$' >"$seen_file".tmp 2>/dev/null \
    && mv "$seen_file".tmp "$seen_file" \
    || log "WARN event: cannot advance seen for '$name/$event' -- some tokens may redeliver"
}
```

Main loop swap (line ~2417): `resolve_event_wakes "$session_ran"` →
`resolve_trigger_event_wakes "$session_ran"`.

`has_scheduled_roles` → `has_scheduled_triggers`: same contract (rc 0 when any
cron OR event trigger exists), implemented over
`_triggers_enumerate cron` + `_triggers_enumerate event` with the same
best-effort tolerance; update its one call site (the fingerprint idle cap,
line ~2516) and keep a `has_scheduled_roles()` LEGACY-marked twin only if a
test still sources it — otherwise rename outright (grep first; state the
result in the commit).

- [ ] **Step 4: Run to verify pass**

```
python3 -m unittest tests.test_triggers -v   → PASS
bash tests/test_event_bus.sh                 → PASS (legacy tests untouched
                                               still exercise the LEGACY fns)
bash tests/run_all.sh                        → PASS
shellcheck -S warning bin/supervisor.sh tests/test_event_bus.sh
```

- [ ] **Step 5: Commit (the ONE cutover commit)**

```bash
git add lib/triggers.py lib/pipeline.py bin/supervisor.sh tests/
git commit -m "feat(#376): event-trigger CUTOVER -- shims + trigger resolver in ONE commit; legacy event path retired; SD-39 collision refusal retired with its reason (Task 10, decision 15)"
```

---

### Task 11: docs, SD-40, follow-on ticket

**Files:**
- Modify: `docs/pipelines.md` (product layer — new sections: "Calling another
  pipeline", "Event triggers", "Secrets"; the cap-counts-dispatches note; the
  `default()` findings-return pattern with the stage+back-edge example; the
  redaction residual stated plainly)
- Modify: `.claude/skills/engineering/pipelines.md` (subsystem map: child runs +
  WAITING + secrets channel + event cutover; the "Still deferred" list drops
  event mode)
- Modify: `docs/settled-decisions.md` — SD-40, one entry, drafted now:

```markdown
40. **Child runs, event triggers and the secret env channel land as Phase C
    of the pipeline+trigger model** (2026-07-10, #376). A
    `call_pipeline` node spawns a CHILD run that dispatches as its own
    in-flight token (`<parent>.c<slot>.<node>`; SD-12/SD-36 untouched);
    parent and child signal through the `<child>.outcome.json` sidecar; the
    run cap counts call dispatches; depth ≤ 3, call cycles refuse; a failed
    child's projected outputs still return (the findings loop). Back-edge-
    visible node outputs are readable ONLY inside `default()`, whose missing-
    node-output tolerance is the one soft spot in the reference language;
    same-container EARLIER-sibling refs are now static-legal. Event firing is
    a trigger mode: event roles auto-shim onto the legacy per-role semantics
    verbatim, native event triggers fire one run per new token with payload→
    param mapping inside `start_run_trigger`, and TWO SD-39 rules retire
    WITH their reason in the same commit — the event-collision refusal and
    the legacy role-path event resolver (LEGACY-marked; deletion = Phase E).
    A broken native event trigger still never falls back to role dispatch.
    Secrets: a secret param's value is a credential LABEL (SD-8); the ONLY
    sink is a node's `secrets: {ENV_VAR: ${params.<name>}}` map; the value
    resolves supervisor-side (foreground, refuse-on-failure), exports
    subshell-scoped, and is scrubbed from the session log post-session; state,
    journal, briefs and ready-blocks carry labels only. Trust stays keyed
    per-assignment (Phase E re-keys); the dashboard keeps the role view
    (Phase D renders children). *(specs/2026-07-09-pipeline-trigger-model-
    design.md §3.1/§4/§5; plans/2026-07-10-pipeline-model-phaseC-call-events-
    secrets.md; #376.)*
```

- File the follow-on issue (split-out, decision 16):
  `gh issue create --title "triggers: onboard/doctor awareness + pack trigger starters + orphan child-sidecar sweep" --body ...`
  (body names the three slices and cites this plan's decision 16; NO closing
  keywords referencing open issues — prevention-log #20).

- [ ] **Step 1: Write the docs** (product voice in `docs/pipelines.md`; the
  every-feature-PR-updates-the-product-layer rule is standing).
- [ ] **Step 2: `bash tests/run_all.sh` + full shellcheck sweep** (the
  pre-push-checklist skill owns the exact list).
- [ ] **Step 3: Commit**

```bash
git add docs/pipelines.md docs/settled-decisions.md .claude/skills/engineering/pipelines.md
git commit -m "docs(#376): Phase C product docs + SD-40 + follow-on ticket filed (Task 11)"
```

---

## Honest gaps (stated, not hidden — carry into the PR body)

- **Live-tail redaction residual:** an agent that echoes a secret is visible in
  the live session log until the post-session sweep. Engine-side construction
  guarantees (no value in state/journal/briefs/ready-blocks/SUPLOG/argv) are
  tested; the tail window is documented (decision 12).
- **Orphaned child-outcome sidecars** (parent state hand-deleted mid-wait) are
  bounded litter; the sweep is in the follow-on ticket (decision 16).
- **Manual fires still have no param-override channel** (Phase D trigger editor).
- **Dashboard renders the role view**; child runs and `@slot` runs are invisible
  but crash-free (tested). Phase D renders them (spec §8 child-run links).
- **Native event first-session latency:** a native event fire is start-only, so
  the run's first session lands via the main loop — worst case one loop tick
  after the fire (a shimmed event role keeps firing its session immediately,
  legacy semantics). The price of keeping SD-12 exact (decision 14).
- **Per-event poll dedupe:** two triggers on one event poll `gh` twice per tick
  (legacy behaviour per role, unchanged). A page cache is a Phase D-adjacent
  perf slice if it ever matters.
- **A call node as the last child of a loop container** exits the loop on child
  success (no verdict channel from a child run yet) — documented in
  `docs/pipelines.md`; a child-verdict channel would be new spec surface.

## Execution notes for the build session

- Branch `feat/376-pipeline-phaseC-call-events-secrets`; TDD per task;
  pre-push-checklist before every push; CP2 on the first push; review-resolution
  per skill; probe `closingIssuesReferences` before merge; `safe_merge.sh`.
- Read `.claude/skills/engineering/pipelines.md` FIRST (the subsystem map), then
  this plan top to bottom; the spec sections that bind: §3.1, §4, §5, §11.
- Tasks 1–9 must not change any supervisor main-loop dispatch behaviour except
  the additive WAITING branch (parity obligation 6). Task 10 is the only
  cutover commit.
