# Foundation specs — adversarial end-to-end challenge findings (round 1)

**Method:** 7 independent adversarial reviewers (6 opus subagents + codex), each tracing studio
END-TO-END against Microsoft's ADF docs as the yardstick: LLM-flavours, pipeline-authoring
(4 real pipelines node-by-node), trigger-config, UI-interaction, monitor/audit, dynamic-config/
ADF-parity, + a codex 2-journey cross-spec pass. All read-only; several read the SHIPPED engine code.

**Verdict:** the **engine/event spine is strong** (pure reducer, durable per-transition events,
immutable cost facts, provenance, the S1 durable-alarm consolidation). The gaps cluster in **three
layers that the "trace it end-to-end" method exposed and per-spec review missed**:
- **(A) The dynamic/expression layer — the north-star "config-driven" is largely UNBUILT.** The
  `${}` function catalog, system variables, and trigger-context binding are referenced everywhere
  and defined nowhere.
- **(B) The read/render layer** — many behaviors the engine records durably (waiting/retry, tumbling
  windows, suppressed fires, reseeded frontiers, per-activity I/O, CLI-agent cost) have **no monitor
  read-model or UI surface**; several UI authoring primitives (params/vars authoring, undo,
  call_pipeline) have **no ticket**.
- **(C) Unpropagated corrections** — the overview's integration fixes were never written back into
  the #1/#4 spec bodies, so an implementer reading the owning spec gets the pre-review (wrong) design.

## TIER 1 — structural, multi-lens corroborated, must fix BEFORE build

**T1. The `${}` expression FUNCTION CATALOG is undefined.** [pipeline C1 + dynamic-config C1, both
CRITICAL; touches #1/#2/#4] No `equals/greater/less/and/or/not/length/contains/substring/concat/
json/int/coalesce/createArray/formatDateTime/utcNow/…` — the ~100 ADF built-ins. So **no `if`/
`switch`/`until`/`filter` condition, no `set_variable` compute, no dynamic filename, no json-parse of
an LLM text output can be authored.** The crown-jewel language has no operators. → **NEW Spec #6:
Expression language** — enumerate the closed function allowlist by category with types; define the
interpolation model (`@expr` whole-value vs `@{expr}` string-embedded; multi-`${}`; nested
composition); SSOT the `validateRefs` checker enforces. **Build-order prerequisite alongside F0.**

**T2. Trigger-context → pipeline binding + system variables are missing.** [triggers C1/C2/C3 +
codex + dynamic-config C2/C3 — 3-4 lenses] No way to get an **event payload**, `${trigger.scheduledTime}`
/`windowStart`, a **run-now param override**, or `${run.RunId}`/`${pipeline.TriggerType}` INTO a run.
`${trigger.*}` is restricted to tumbling-only (a regression vs ADF, which exposes it to schedule +
all runs). Under event-sourcing this needs a durable seed. → **(a) a durable `run.triggerContext`
seed event** appended at launch (resolver folds it — no out-of-band preload); **(b) general
`${trigger.*}` namespace per trigger type** (schedule scheduledTime/startTime; event body/eventData;
window start/end); **(c) `${run.*}`/`${pipeline.*}` system variables** (RunId, PipelineName,
TriggerType/Name/Time); **(d) expression-valued param bindings** at trigger-def + a run-now override
body; **(e) how dispatch-time values (`utcNow`, RunId) enter the INERT language** — driver-stamped
facts resolved at dispatch, replay-safe. Folds into #5 + #6.

**T3. The overview's ownership corrections were never propagated into the #1/#4/#2 spec bodies.**
[codex + LLM C3 + dynamic-config I5 — 4 lenses] #4 still says "`if` routes via **success/failure**";
A0 still "**amends #1**"; #1 D4 still describes a per-feature retry timer (superseded by #5 S1);
#2's table still says "classify **drives success edges**." → **Back-propagate the integration fixes
as real edits:** move the unified `Edge` discriminated union INTO #1's body (single owner); strip
stale timer prose from #1 D4; correct the #2 classify table; remove #4 A0's "amends" + fix its
catalog. Mechanical but critical — writing-plans must treat the overview's corrections list as EDITS.

**T4. The loop model doesn't move data.** [pipeline C3/C4, CRITICAL] `foreach` can't **aggregate
per-item outputs** — no `${nodes.<foreach>.output.results}` typed as an array-of-child-output-shape,
so `foreach → filter → write` is unbuildable. Loop-body outputs are **round-local and cleared**, so
cross-iteration data (iteration N feeding N+1) is impossible via node refs and silently requires a
variable — undocumented, and `validateRefs` masks it as a nullability nit. Currently **worse than
ADF** (whose Set-Variable-append workaround we hard-reject). → Define the `foreach` aggregate output
as a first-class typed value (input-order-stable regardless of `batchCount`); extend `OutputSpec`/
`validateRefs` for array-of-child-shape; document "outputs round-local, variables persist" and fix
the diagnostic; specify container output projection (the A3 TODO).

**T5. The subscription/CLI LLM flavour is second-class.** [LLM C1, CRITICAL; monitor C3;
dynamic-config] `llm_call.connectionKinds = [anthropic_api, openai_api, ollama]` **excludes CLI/
subscription** — a Claude-Max/no-API-key user can't build a classifier/summarizer (only `agent_task`,
a coding subprocess that **isn't even a connection**). No **quota/reset-window** model (a sub cap
returns a reset epoch, not `retry-after` — the parent engine's `.last_usage_reset` invariant). Cost
conflates `$0-marginal` (sub/local) with `unknown`. → **Add a `cli`/`agent` connection kind
`llm_call` accepts** + a single-shot CLI adapter (`claude -p`/`codex exec` → stdout completion);
**quota/reset-window primitive**; **split `meteringStatus` → metered/unpriced/unknown**; run-cost
projection carries a **completeness flag** (unmetered node ⇒ total is a lower bound, shown as "≥").

## TIER 2 — important, cross-spec

- **T6. `Node.config.outputs` undefined in #1 + no nested/deep addressing + no `${nodes.x.status}`.**
  [codex + LLM I7 + dynamic-config I3] #2 lowers structured output to it but #1 never defines the
  field; typing is flat top-level only (no `output.a.b.c[2]` into a `json`-typed output, no array
  element schemas, no node-status read for OR-fan-in). → Define `Node.config.outputs: OutputSpec[]`
  in #1 (validation/canonicalization/git-serialization); decide bracketed deep-path addressing; add
  `${nodes.x.status}`.
- **T7. Multi-incoming-edge JOIN semantics (AND vs OR) undefined.** [dynamic-config I4] Correctness-
  critical for try/catch + fan-in; absent from #1 D5 + #4 A0. → Specify (ADF = AND-of-predecessors,
  OR among conditions on one predecessor) + characterization tests with F1.
- **T8. `classify → switch` pattern + no-match/default + enum↔case exhaustiveness.** [LLM C3 +
  pipeline] `llm_call` (execution) can't emit branches; a downstream `switch` reads
  `${nodes.classify.output.category}`. Undefined: no-branch-matched behavior; enum→case coverage. →
  Write the pattern; mandatory `default`; validate switch exhaustiveness against the enum at save.
- **T9. Connections aren't parameterizable; `connectionId`/`model` can't be dynamic.**
  [dynamic-config I1] Can't route Anthropic-vs-OpenAI by param (for an "ADF for AI" tool). → Connection
  parameters (non-secret, expression-bound at dispatch) + `connectionId`/`model` as validated `${}`
  refs (or explicit deferral).
- **T10. No config-field secret injection (`SecretRef` sink).** [dynamic-config I2] Secret is
  connection-only — `http_request` can't put a token in a header. The overview's "canonical
  `SecretRef`/`SecretSink`" is asserted but **not actually specified in #1 D8** (which only covers
  redaction + connection creds). → Define `SecretRef` node-config secure fields carry, resolved at
  dispatch, never logged.
- **T11. Tool side-effects break the event-sourcing invariant; `ToolDef` undefined.** [LLM C2] An
  opaque tool loop doing a file-write/HTTP is a real side-effect with no durable event; cancel
  mid-loop leaves partial committed effects. → Define `ToolDef`; MVP tools read-only/pure OR promote
  side-effecting tool calls to real driver events (the deferred resumable-loop sub-spec).
- **T12. Missing durable events + monitor read-models.** [codex + monitor + triggers] Add
  `trigger.fired`/`run.created`/`run.admitted`, `node.skipped`/`edge.notTaken`, foreach lifecycle
  events, `run.triggerContext`; extend R1/R2 with `triggerContext`/`windowContext`/version
  `provenance`/`activePointerAtCreation` so "which version did window N run" is answerable.
- **T13. Monitor UI can't surface what the engine records.** [monitor — extensive] waiting/retrying
  invisible (U11 status enum predates S6); **no activity drill-in ticket** (ADF's core primitive);
  tumbling-window state invisible (not runs); suppressed/refused trigger fires invisible (no
  trigger-runs view); filter/time-range absent + client-side-only doesn't scale; no cross-run Gantt;
  no cost column / consumption; **rerun-from-failed paints copied frontier nodes as plain "success"
  — a correctness lie**; no Cancel; branch-taken/foreach-iterations/child-run nav absent; prompt/
  completion secure default unspecified; **non-version audit absent** (who disabled a trigger, who
  published, what was active last Tuesday). → Reconcile UI status enum + R2 with S6 (v1); add
  activity-drill-in, trigger-runs, tumbling, filter-pane, cost-column, cancel, rerun-distinct-render,
  cross-run-Gantt tickets; event-source workspace mutations + publish history.
- **T14. UI authoring core is thin.** [UI — extensive] **No UI to author params/variables/outputs/
  globals** (flyout references them, nothing defines them); **no undo/redo** (store has no history
  model — retrofit is expensive, do it early); the **Save-vs-Publish reconciliation ticket the
  overview promised is absent** from U0-U15 (3-spec contradiction); **edge outcome should be picked
  by dragging a colored source handle** (ADF), not a retro dropdown, and `if`/`switch` need
  per-branch handles (`true`/`false`/case) — no handle model; **`call_pipeline` authoring entirely
  absent**; no copy/paste, no multi-select, no version-history/picker UI, no container-config forms,
  drag-drop drop mechanics unspecified; many UI tickets depend on unbuilt foundation schema with no
  stated dependency; U8a's "node-level issue list" needs the deferred R3 structured diagnostics. →
  A batch of UI authoring tickets + hard dependency annotations onto the foundation schema.

## TIER 3 — notes, smaller gaps, deliberate deferrals to confirm

Connection reachability/"test connection" probe (LLM I2) · Anthropic prompt-caching cost buckets
(LLM I3) · strict-JSON optional-field lowering (LLM I5) · refusal/truncation success taxonomy +
normalized `stopReason` (LLM I6) · `${item}` scoping when filter chains after foreach + sub-field/
`range()`/nested-foreach (pipeline I5 + dynamic-config M3) · retry/timeout/`batchCount` as
expressions not literals (dynamic-config M1) · timezone/DST run-windows + schedule vs tumbling
concurrency starvation + edit/disable/delete-while-queued (triggers I3/I4/I5) · shell/`script` +
git first-class activity + errorMap (pipeline I4) · webhook payload→typed-output + expiry-routing
contract (pipeline I2/I3) · global params env-override deferral note (dynamic-config I6) · runs-list
not live / duration conflates wait-time / R1 payload pagination (monitor M3/M5/M6) · in-app version
diff (monitor M1) · single-vs-`system` system-prompt canonical form (LLM I8).

## Refinement plan (round 1)

1. **NEW Spec #6 — Expression language** (T1): function catalog + interpolation model + system
   variables (`${run.*}`/`${pipeline.*}`) + how dispatch-time values enter the inert language.
   Prereq alongside F0.
2. **Trigger-context primitive** (T2): `run.triggerContext` seed event + `${trigger.*}` per type +
   expression param bindings + run-now override — into #5 + #6.
3. **Propagate the ownership corrections** (T3) as real edits into #1/#4/#2 bodies.
4. **Loop-dataflow model** (T4) into #4 + #1: foreach aggregate output + container projection +
   outputs-vs-variables rule.
5. **Subscription/CLI connection + quota** (T5) into #2 + a connection-kinds note.
6. **Targeted revisions** for T6–T11 into #1/#2/#4 (Node.config.outputs, join semantics,
   classify→switch, connection params, SecretRef sink, ToolDef).
7. **Monitor + UI ticket batches** (T12–T14) into the UI epic + #5 read-models.
8. Fold Tier-3 notes as spec caveats / explicit deferrals.
9. **Re-challenge (round 2)** on the refined T1–T5 before build.

**Bottom line:** the challenge validated the engine spine and found that the *usable-product* layers
(dynamic config, monitoring, authoring UX) are materially under-specified against ADF. None is a
dead end; all are addressable. The design is sound where it's deep (events, versions, cost) and thin
exactly where a user actually touches it — which is the right thing to have learned before building.
</content>
