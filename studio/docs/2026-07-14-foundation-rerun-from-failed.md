# Foundation sub-spec (RS) — Rerun-from-failed

**Status:** proposed 2026-07-14 (writes the RS sub-spec #1 F12 depends on + gates); pending Codex.
**RS1 SHIPPED 2026-07-24** (built-block below) — `run.reseeded` event + reducer fold + `rerunOf`
defer-settle. The headless build loop honoured the operator-pre-settled forks in place of Codex:
frontier = strict successful prefix (Open-Q1); param-override FORBID on rerun-from-failed, allowed
only on simple rerun F11 (Open-Q2 — and the Provenance contradiction below is fixed); a copied
non-deterministic (LLM) output is reused verbatim (Open-Q3, the spec's own lean).
**Scope:** the reseed-event semantics + frontier algorithm for **rerun-from-failed** — start a NEW run
that skips already-succeeded work and resumes from the failure. Referenced-but-deferred by #1 D7/F12;
must land before F12* builds. **Foundation layer — engine.**
**Non-goal:** simple rerun (F11, a fresh run of the same version) — that needs no reseed.

## Invariant (why a reseed EVENT, not a projection preload)

A run's state = fold(its OWN `run_events`). A rerun that copies a prior run's successful outputs must
carry that copy **as a durable event at the head of the new run's log**, or the new run isn't
self-deriving (replay/boot-reconcile would reconstruct a different state — the codex round-1 finding).

## The reseed event

New run `R2` (rerun-from-failed of `R1`) begins:
`run.started{ pipelineVersionId, params, rerunOf: R1 }` →
**`run.reseeded{ sourceRunId: R1, frontier: NodeId[], copiedOutputs, copiedContainers,
childLinks? }`** → the reducer folds it, marking every `frontier`
node **terminal-success (copied, not executed)** with its copied outputs, and seeding
container states. Dispatch then proceeds from the ready set beyond the frontier — the
same walk as a normal run.

**RS1 shape reconciled against the SHIPPED engine (built-block below):**
- The proposed `copiedNodeStates` + `copiedVariables` fields are DROPPED — the engine has **no
  `run.variables` concept**; the only run-level writable channel is per-node `outputs`, so
  `copiedOutputs` (`nodeId → {name → value}`) alone carries the copied prefix, and `frontier` +
  `copiedOutputs` fully determine the copied node states.
- `copiedTriggerContext` is DROPPED as a field — the "reuse R1's `${trigger.*}`" requirement (still
  load-bearing) is met by **REPLAYING R1's `run.triggerContext` before `run.started`** (the existing
  pre-start seed mechanism, single SSOT), exactly as an original trigger-launched run does. RS2's
  reseed producer emits it for a trigger-launched rerun.
- `frontier` lists **top-level node ids only**; container internals are copied via `copiedContainers`
  (a mid-flight container re-runs whole; RS3). The reducer trusts the manifest (an internal engine
  event); it guards structural totality (unknown node/container id → diagnostic + skip) but not the
  frontier well-formedness RS2/RS3 own.
- **`run.started{rerunOf}` DEFERS dispatch** (the fold returns no settle commands) so `run.reseeded`
  marks the copied frontier BEFORE any node dispatches. **CRASH-SAFETY INVARIANT:** the intermediate
  deferred-`running`-without-reseed state is NOT the `pending` half the reconciler resyncs harmlessly
  — a resume of it re-dispatches the frontier. RS2's producer therefore MUST append
  `run.triggerContext?` + `run.started{rerunOf}` + `run.reseeded` in ONE transaction; no crash window
  may persist the half-state.

## The frontier (defined in ENGINE terms, not UI terms)

- **Frontier = the maximal set of nodes that (a) reached `success` in R1 AND (b) every path from them
  to the failed node(s) is via successful predecessors** — i.e. the successful "prefix" whose outputs
  the resumed run needs. Failed / downstream / skipped nodes are NOT copied; they re-run.
- **Copied:** frontier nodes' `status=success` + their `outputs`; `run.variables` as of the last
  successful write before the failure; container states for fully-completed containers.
- **Attempts reset** for re-executed nodes (fresh `attemptId` sequence in R2); copied nodes keep no
  live attempt (they don't execute).
- **Determinism:** the frontier is computed from R1's event log (pure function of the log), so it is
  reproducible.

## Containers, loops, `call_pipeline` (the hard edges)

- **Loop/until/foreach containers:** a container that fully completed in R1 is copied as a terminal
  unit (its projected outputs copied); a container that was MID-flight at the failure is NOT copied —
  it re-runs from the start (loop round state is not partially reseeded; the round-local reset rule
  makes partial-loop reseed unsound). Documented limitation.
- **`call_pipeline`:** a completed call node is copied as terminal with its stored child outputs +
  a `childLinks` entry `{callNodeId, sourceChildRunId}` recording provenance — **the child run is NOT
  re-created** (the deterministic `childRunId` from R1 is referenced as provenance, never re-spawned).
  A non-frontier (failed/mid-flight) call node **re-runs and spawns a FRESH child** (a new
  deterministic `childRunId` derived from R2 + node + attempt). (Default lean = fresh child for
  anything not on the frontier; provenance-mapping only for copied ones.)
- **`secureOutput` outputs cannot be reseeded** (emit-time redaction, #1 D8) — a frontier node whose
  output is secure is **NOT copiable** → it (and its downstream) re-run. Documented; the run's cost
  reflects that re-execution.

## Cost, audit, monitor (interactions)

- **Cost (#2):** copied nodes emit NO new `activity.metered` (they didn't run); re-executed nodes
  meter normally. The rerun UI warns "may incur additional cost." The run-cost projection for R2 is
  only R2's real spend (copied work is free).
- **Audit / monitor (T13):** the Monitor overlay MUST render **copied-vs-executed** distinctly (a
  copied frontier node shows "reused from run R1", not a plain "success" — else it's a correctness
  lie). `runs.rerunOf = R1`; a rerun-history grouping + Run-type column (Original / Rerun /
  Rerun-from-failed) surfaces the lineage.
- **Provenance:** R2 pins the SAME `pipelineVersionId` as R1 (rerun re-runs the same immutable
  version). Params are **NOT** overridable on rerun-from-failed — the copied frontier outputs were
  computed under R1's params, so a new-param/old-output mix is a silent inconsistency; params reuse
  R1's exactly (Open-Q2 settled). Param override is allowed ONLY on simple rerun (F11), which copies
  nothing. (This corrects the earlier "params may be overridden (recorded)" wording, which was true
  for F11 but wrong for rerun-from-failed.)

## Tickets (RS-series; gate #1 F12*)

| # | Ticket |
| --- | --- |
| RS1 | `run.reseeded` event schema + reducer fold (mark frontier terminal, seed outputs/containers) — **SHIPPED 2026-07-24** (`rerunOf` defer-settle + `onReseeded` fold + guards; built-block below) |
| RS2 | Frontier algorithm (pure over R1's log) + `rerunOf` link + live producer — **SHIPPED 2026-07-24** (`Engine.reseedFrontier` satisfied-edge strict prefix + `createReseedService` atomic reseed-pair producer + `POST /api/runs/:id/rerun-from-failed`; built-block below) |
| RS3 | Container/loop reseed rules (completed=copy, mid-flight=re-run) — **SHIPPED 2026-07-24** (rule delivered by RS1+RS2; RS3 = the end-to-end copy-vs-re-run SOUNDNESS proof across container kinds + a `driveRun` reseed seam; built-block below) |
| RS4 | `call_pipeline`: `childLinks` provenance for copied; fresh child for non-frontier |
| RS5 | `secureOutput` non-copiable rule → forced re-execution of secure frontier + downstream |
| RS6 | Monitor copied-vs-executed render + rerun-history grouping (T13) — **copied-vs-executed SHIPPED 2026-08-05** (#918: `deriveNodeActivity` folds `run.reseeded`, so a copied node carries its copied outputs and a `copiedFromRunId`; the node table's Detail cell reads `reused from run <id>` and the drill-in names the source run and drops the "has not started" sentence). The run GRAPH is deliberately exempt — the reducer writes a copied node `{status:'success', attempts:0}`, identical to an executed success, so `RunState` carries no marker for it to read. **Rerun-history grouping + the Run-type column are still open.** |

## Open questions (for Codex)

1. Frontier granularity: strict "successful prefix" vs a looser "all successes not downstream of a
   failure" — the latter copies more but risks copying a node whose *inputs* would now differ. Confirm
   the strict definition is right (copy only what the resume needs).
2. Params overridden on rerun-from-failed: do copied nodes' outputs (computed under old params) become
   inconsistent with new params? Likely forbid param-override on rerun-from-failed (only on simple
   rerun F11); confirm.
3. A frontier node with a non-deterministic output (LLM) — copying it is CORRECT (don't re-bill), but
   confirm the user understands the resumed run reuses the original LLM output verbatim.

**Open-questions status (RS1):** Q1 (strict prefix), Q2 (forbid param-override on rerun-from-failed)
and Q3 (reuse LLM output verbatim) are all settled per the operator pre-settled runway; the code
honours them. They remain listed for the Codex pass on the RS2-RS6 tail.

## RS1 built-block (2026-07-24) — `run.reseeded` event + reducer fold + `rerunOf` defer-settle

RS1 delivers the reseed MECHANISM (schema + pure fold only); RS2 computes the `frontier` and wires
the live producer. No storage migration — the `run_events` table stores `type`/`payload` as an open
string + JSON blob, so a new `EngineEventSchema` variant is picked up by the append/replay parse with
no DB change.

- **`run.started.rerunOf` (optional) is the defer signal.** Present → `onRunStarted` seeds the
  node/container map but returns NO settle commands, so no node dispatches before the copy. Absent →
  an ordinary run starts + settles unchanged (durable back-compat; an old log carries none).
- **`onReseeded` fold** (arrives on the deferred `running` run): guards that the run is fresh/
  un-progressed (any non-`pending` node/container OR any recorded output ⇒ a duplicate reseed or a
  reseed on an ordinary run ⇒ no-op + diagnostic, never a silent rewrite — the `onRunTriggerContext`
  posture); marks each `frontier` node `{status:'success', attempts:0, retries:0}` (no live attempt —
  copied, not executed) and writes `copiedOutputs[nodeId]` into `state.outputs`; seeds each
  `copiedContainers` entry — which MUST be a completed TERMINAL unit (`TERMINAL_CONTAINER`); a
  non-terminal (`pending`/`active`) copy is REFUSED (diagnostic, not applied) because a live
  container's settle walk reads absent instance-key node states and would throw out of the never-throw
  reducer — AND MIRRORS its `outputs` into `state.outputs[containerId]` (the sole source `buildCtx`
  reads for `${nodes.<container>.output.*}`, symmetric to `exitContainer`); then **settles ONCE** so
  the walk dispatches beyond the frontier. A copied
  `success` node is in `TERMINAL_NODE`, so edge routing / `allTopLevelTerminal` / `runOutcomeFailure`
  treat it identically to an executed success. Unknown frontier node / container id, or a non-terminal
  container → diagnostic + skip (the pure fold stays total).
- **Trust boundary:** `copiedOutputs` are written RAW (not re-`validateOutputs`/`storeOutputs`-d). The
  RS2 sourcing contract: they come from R1's projected `state.outputs`, already `storeOutputs`-
  normalized (undeclared keys filtered, optional→present-null), and R2 pins the SAME immutable
  `pipelineVersionId` (⇒ same output contract) as R1. Consistent with "validate at boundaries, trust
  internal code": the event is engine-generated and Zod-shape-validated on append/replay.
- **CRASH-SAFETY invariant** (see "The reseed event" above): RS2's producer MUST append the reseed
  pair (+ any `run.triggerContext` replay) atomically. RS1 pins the hazard with a characterization
  test — a lone `run.started{rerunOf}` half-state, resumed, re-dispatches the frontier — so the
  invariant can't bit-rot silently.
- **Deferred to later slices:** `childLinks` (RS4, a backward-compatible optional-field addition — a
  frontier `call_pipeline` node is copied-terminal and never re-spawns a child, so nothing needs it
  until RS6 renders provenance); `secureOutput` non-copiable exclusion (RS5); the `runs.rerunOf` row
  lineage + Monitor copied-vs-executed render (RS6).

## RS2 built-block (2026-07-24) — frontier algorithm + `rerunOf` link + live producer

RS2 makes the RS1 mechanism reachable: it COMPUTES the frontier from R1's log and DRIVES a new run R2
that carries the reseed pair.

- **`Engine.reseedFrontier(sourceState)` — the PURE frontier** (`engine/reduce.ts`, a method on
  `createEngine` so it reuses the reducer's OWN `edgeState` + the `partitionReadiness` predecessor
  SSOT — zero drift). INCLUSION RULE (strict successful prefix, Open-Q1): a top-level entity (node
  OR container) is included iff (a) it reached terminal `success` in R1 AND (b) every incoming edge
  that was **satisfied** in R1 comes from an included entity. The **satisfied-edge** test — not a
  naive "all direct predecessors" — is load-bearing: a not-taken branch edge / dead failure edge is
  `impossible`/`unsatisfied-terminal`, so a downstream success join whose SKIPPED sibling did not
  contribute is still copiable (a naive rule would re-run the whole post-branch graph on every
  rerun-from-failed). Returns `{frontier, copiedOutputs, copiedContainers}` — RS1's manifest minus
  `sourceRunId`. Soundness: a copied entity's whole satisfied-edge ancestry is copied identically,
  and a non-copied predecessor re-runs to its SAME outcome (a skipped branch re-skips, a failed node
  re-fails) because ITS inputs are copied-identical — so a copied `${}` ref stays consistent.
  Containers are copied whole when terminal-`success` (RS3 owns the loop-round / foreach-instance
  copiability NUANCES on top; a mid-flight container is already excluded — not terminal-success).
- **`createReseedService(deps).rerunFromFailed(sourceRunId)` — the LIVE producer**
  (`server/src/run/reseed.ts`), mirroring `external-wait-service.ts`'s append-in-ONE-transaction +
  drive-after-commit shape. It appends `run.triggerContext?` (R1's, replayed VERBATIM — swap runId —
  the single SSOT for `${trigger.*}` reuse) + `run.started{rerunOf:R1}` + `run.reseeded{…}` in ONE
  `db.transaction`, folding each (`appendAndFold`, `bus=undefined` in-tx) and syncing R2's row status
  INSIDE the tx. The in-tx sync is load-bearing crash-safety: R2 is created `pending`, and the boot
  reconciler scans `running` rows ONLY, so a committed reseed log on a `pending` row would be
  permanently stranded — syncing to `running` in-tx closes RS1's crash window. After commit it
  publishes the records to the bus, then `driveRun` re-projects and `resume` re-derives the dispatch
  BEYOND the frontier (a settled `ready` node carries its `currentAttemptId`; copied frontier
  successes carry none and are skipped — no double execution).
- **Eligibility:** R1 must have a log AND have TERMINATED in a FAILURE (`failure` OR `interrupted`;
  `success` is refused — a successful run has nothing to resume from, that is F11's job) — else
  `RerunNotEligibleError` (→ 409). An unresolvable pinned version → `DocUnresolvableError` (→ 409).
- **Provenance / SETTLED forks:** params reuse R1's EXACTLY (no override arg — override is F11-only);
  R2 pins R1's `pipelineVersionId`; `triggerId`/`parentRunId` are `null` (a rerun is an explicit
  operator action, not a trigger fire; `${trigger.*}` resolves via the replayed context event; rerun
  lineage is the `run.started.rerunOf` link — the `runs.rerunOf` COLUMN is RS6).
- **Route:** `POST /api/runs/:id/rerun-from-failed` → `202 {runId}` (`routes/runs.ts`), owner-scoped
  via `requireOwned` BEFORE the producer (authz at the boundary; a missing OR not-owned run is the
  same 404 — no oracle).
- **CONSCIOUS NON-GOAL (RS2):** a rerun drives immediately and does NOT pass through the launcher's
  concurrency admission — an explicit operator rerun is not gated by the trigger/pipeline caps that
  bound AUTOMATED fires. Routing reruns through admission is a later refinement, not a defect.
- **`secureOutput` (RS5) is a NO-OP today:** the field ships with F4 and does not exist yet, so no
  frontier node can carry a redacted output — there is nothing to exclude or leak.

## RS3 built-block (2026-07-24) — container/loop reseed rules (completed=copy, mid-flight=re-run)

**The RULE was delivered by RS1+RS2; RS3 has no production-logic change.** `reseedFrontier`
(`engine/reduce.ts`) includes a container in the copied set iff it reached terminal `success`
(`isSuccessContainer`); a mid-flight (`active`) / `failure` container is excluded → re-runs whole.
RS1's `onReseeded` fold seeds a `copiedContainers` entry only if it is a `TERMINAL_CONTAINER`
(refuses a non-terminal copy with a diagnostic) and mirrors its `outputs` into
`state.outputs[containerId]`. So "completed = copy whole, mid-flight/failed = re-run whole" is
already enforced by shipped code. RS2 explicitly handed RS3 the "loop-round / foreach-instance
copiability NUANCES" — which resolve NOT to new code but to a **soundness property to prove**.

- **The soundness property:** a completed container is copied WHOLE via `copiedContainers`
  (`{...containerState}` — its `round`/`items`/`results`/`nextItem`/`doomed` carried), but its
  internal body / instance-key node states are NOT seeded into R2's `state.nodes`. This is sound
  because nothing reads them once the container is copied-terminal: every settle read of a
  container's child node state is guarded by a container-status check a copied-`success` container
  fails BEFORE the read (`stepContainers`, `stepForeachParallel`, the settle top-entity + active-
  child loops); `fireBackEdges` is undefined-safe (an absent body child yields `bodyTerminal=false`,
  never a throw); and a live parallel foreach already DELETES its instance-key child nodes on item
  completion, so a copied terminal foreach legitimately carrying none is behaviourally identical to
  a live-completed one. External downstream nodes can only read `${nodes.<container>.output.*}`
  (`validateDoc` forbids a cross-boundary edge to a container CHILD), served by the mirrored
  `state.outputs[containerId]`.
- **The RS3 deliverable = the end-to-end characterization net.** `engine/__tests__/reseed-rs3.test.ts`
  DRIVES a real R1 container run to quiescence (unlike `reseed-frontier.test.ts`, which fabricates
  R1 state), computes the manifest `reseedFrontier` produces, then drives R2 from it, for every
  DRIVABLE container kind — **stage**, **foreach sequential**, **foreach PARALLEL** (`batchCount>=2`,
  proving the deleted-instance-node copies soundly), **loop** (exitWhen/round machinery) — asserting:
  the container is copied `success`, its body is NEVER re-dispatched (its child stays seeded
  `pending`), the downstream RE-RUNS, R2 converges with NO diagnostic/throw, and R2 self-derives from
  its own `run.started{rerunOf}` + `run.reseeded` log alone (CP1). Plus a **failed-container** case
  proving the container re-enters and re-runs its whole body in R2, and a `driveRun` **reseed seam**
  (`opts.reseed` folds the atomic two-event head the live producer appends) pinned directly in
  `helpers/run-driver.test.ts`.
- **BARE-loop refinement DEFERRED (not built).** `reseedFrontier` conservatively EXCLUDES every
  top-level node in a bare back-edge loop body (re-runs it whole). Copying a fully-settled bare loop
  would be a marginal optimisation at real correctness risk — a copied loop member's
  `soft`/`default(${x})` back-edge ref can freeze at an obsolete iteration, and `fireBackEdges` only
  self-corrects via `resetNodes` ON a satisfied back-edge traversal a copied-`success` member never
  takes (R2 restarts with a fresh `bounces` budget). The conservative exclusion is CORRECT, just
  sub-optimal; the refinement stays deferred as an explicit optional.
- **NESTED containers are not representable** (a container child MUST be a node, and all containers
  are top-level entities), so there is no nested-container copiability case to test.
- **No R1/RS2 semantics changed:** the diff is tests + the additive `driveRun` reseed seam + this
  doc. The never-throw pure reducer and the RS1 crash-safety atomicity invariant are untouched.
