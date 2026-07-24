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
| RS2 | Frontier algorithm (pure over R1's log) + `rerunOf` link |
| RS3 | Container/loop reseed rules (completed=copy, mid-flight=re-run) |
| RS4 | `call_pipeline`: `childLinks` provenance for copied; fresh child for non-frontier |
| RS5 | `secureOutput` non-copiable rule → forced re-execution of secure frontier + downstream |
| RS6 | Monitor copied-vs-executed render + rerun-history grouping (T13) |

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
