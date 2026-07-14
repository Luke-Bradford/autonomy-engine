# Foundation sub-spec (RS) — Rerun-from-failed

**Status:** proposed 2026-07-14 (writes the RS sub-spec #1 F12 depends on + gates); pending Codex.
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
**`run.reseeded{ sourceRunId: R1, frontier: NodeId[], copiedNodeStates, copiedOutputs,
copiedVariables, copiedContainers, childLinks? }`** → the reducer folds it, marking every `frontier`
node **terminal-success (copied, not executed)** with its copied outputs, and seeding
`run.variables`/container states. Dispatch then proceeds from the ready set beyond the frontier — the
same walk as a normal run.

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
  version); params may be overridden (recorded).

## Tickets (RS-series; gate #1 F12*)

| # | Ticket |
| --- | --- |
| RS1 | `run.reseeded` event schema + reducer fold (mark frontier terminal, seed vars/containers) |
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
