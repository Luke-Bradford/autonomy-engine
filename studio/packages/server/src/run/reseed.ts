import {
  resolveRunParams,
  type EngineEvent,
  type RunEvent,
  type RunState,
} from '@autonomy-studio/shared';
import { createRun, getRun } from '../repo/runs.js';
import { appendAndFold, loadEngineEvents, terminalFactFromLog } from './events.js';
import { buildEngine, driveRun, syncRunLifecycle, type DriveDeps } from './driver.js';

/**
 * RS2 — the LIVE rerun-from-failed PRODUCER: start a NEW run `R2` that skips the
 * source run `R1`'s already-succeeded work and resumes from the failure.
 *
 * The mechanism RS1 shipped (the reducer's `run.started.rerunOf` defer + the
 * `run.reseeded` fold) is applied here by APPENDING the reseed pair to R2's log:
 *   `run.triggerContext?` (R1's, replayed verbatim so `${trigger.*}` reuses R1's
 *   fire-time facts — the single SSOT, spec §"The reseed event") →
 *   `run.started{rerunOf: R1}` (defers start-time dispatch) →
 *   `run.reseeded{sourceRunId: R1, frontier, copiedOutputs, copiedContainers}`
 * (the frontier computed by the PURE `engine.reseedFrontier`).
 *
 * CRASH-SAFETY (RS1's load-bearing invariant): the deferred `run.started{rerunOf}`
 * folds to a `running`/all-pending half-state that, resumed WITHOUT its following
 * `run.reseeded`, RE-DISPATCHES the frontier (re-executing copied work). So the
 * three appends land in ONE `db.transaction` — and the run row is synced to its
 * folded status INSIDE that transaction: the row is created `pending`, and the boot
 * reconciler scans `running` rows ONLY, so a committed reseed log left on a
 * `pending` row would be permanently stranded. Syncing to `running` in-tx closes
 * that. The bus is fed only AFTER commit (a subscriber must never see an event a
 * rollback could erase), then `driveRun` re-projects and `resume` re-derives the
 * dispatch BEYOND the frontier — the exact append-in-one-tx + drive-after-commit
 * shape as `external-wait-service.ts`.
 *
 * PROVENANCE / SETTLED FORKS (operator, spec §Provenance):
 *  - **Params are NOT overridable.** R2 reuses R1's params EXACTLY (the copied
 *    frontier outputs were computed under them; a new-param/old-output mix is a
 *    silent inconsistency). `rerunFromFailed` takes no param argument. Override is
 *    a simple-rerun (F11) concern, which copies nothing.
 *  - **R2 pins R1's `pipelineVersionId`** (same immutable version ⇒ same output
 *    contract, so `copiedOutputs` are trusted raw — RS1's sourcing contract).
 *  - **`triggerId = null`, `parentRunId = null`.** A rerun is an explicit operator
 *    action, not a trigger fire; `${trigger.*}` still resolves via the replayed
 *    `run.triggerContext` event (which carries R1's triggerId), and rerun lineage
 *    is the `run.started.rerunOf` link (the `runs.rerunOf` row column is RS6).
 *
 * CONSCIOUS NON-GOAL (RS2): a rerun drives immediately and does NOT pass through
 * the launcher's concurrency admission (`launcher.ts`) — an explicit operator
 * rerun is not gated by the trigger/pipeline caps that bound AUTOMATED fires.
 * Routing reruns through admission is a later refinement, not a defect.
 */
export interface ReseedService {
  /**
   * Start a rerun-from-failed of `sourceRunId`. Resolves once R2 is durably created
   * + its reseed pair committed; R2 then DRIVES IN THE BACKGROUND (like a manual
   * fire — `launcher.launch`), so the caller does not block on the whole rerun.
   *
   * Returns R2's id + `drive`, the background drive promise. HTTP callers send
   * `202 { runId }` and ignore `drive` (a long rerun must not hold the request
   * open); tests await `drive` to observe R2's terminal outcome. `drive` never
   * rejects — `driveRun` owns its faults (`terminalizeInterrupted`) — and a crash
   * before it runs recovers via the boot reconciler (R2's row is durably `running`
   * with its reseed log, the RS1 crash-safety invariant).
   * @throws {RerunNotEligibleError} if the source run is missing, has no log, or
   *   did not terminate in a FAILURE (`failure`/`interrupted`) — only a failed run
   *   is rerun-from-failed eligible; a successful run has nothing to resume from.
   * @throws {DocUnresolvableError} if the source run's immutable pipeline version
   *   no longer resolves (deleted/unparseable) — a rerun cannot re-pin it.
   */
  rerunFromFailed(sourceRunId: string): Promise<{ runId: string; drive: Promise<void> }>;
}

/**
 * The source run cannot be rerun-from-failed: it is missing, has no event log, or
 * did not terminate in a failure. Client-safe — carries the id + a short reason,
 * never run contents. The route maps it to `409` (a conflict with the request).
 */
export class RerunNotEligibleError extends Error {
  constructor(
    public readonly sourceRunId: string,
    public readonly reason: string,
  ) {
    super(`run '${sourceRunId}' cannot be rerun-from-failed: ${reason}`);
    this.name = 'RerunNotEligibleError';
  }
}

export function createReseedService(deps: DriveDeps): ReseedService {
  const { db } = deps;
  return {
    async rerunFromFailed(sourceRunId: string): Promise<{ runId: string; drive: Promise<void> }> {
      // 1. The source run must exist, have a log, and have FAILED. The LOG decides
      // terminality (#443) — never a re-fold. `success` is deliberately excluded:
      // rerun-from-failed resumes from a failure; a fully-successful run would copy
      // its entire graph and finish immediately (a simple rerun's job, F11).
      const sourceEvents = loadEngineEvents(db, sourceRunId);
      if (sourceEvents.length === 0) {
        throw new RerunNotEligibleError(sourceRunId, 'the run has no event log');
      }
      const terminal = terminalFactFromLog(sourceEvents);
      if (terminal === null) {
        throw new RerunNotEligibleError(sourceRunId, 'the run has not terminated');
      }
      if (terminal === 'success') {
        throw new RerunNotEligibleError(sourceRunId, 'the run succeeded (nothing to resume from)');
      }

      const source = getRun(db, sourceRunId);
      if (source === null) {
        // Raced a deletion between the log read and here.
        throw new RerunNotEligibleError(sourceRunId, 'the run no longer exists');
      }

      // 2. Resolve the SAME immutable version R1 pinned; build the engine + project
      // R1's state. `resolveDoc` throws `DocUnresolvableError` if the version is
      // gone/unparseable — a rerun cannot re-pin it, so let it propagate (409).
      const doc = deps.resolveDoc(source.pipelineVersionId);
      const engine = buildEngine(doc);
      const sourceState = engine.projectRunState(sourceEvents);

      // 3. The PURE frontier over R1's projection (strict successful prefix).
      const { frontier, copiedOutputs, copiedContainers } = engine.reseedFrontier(sourceState);

      // 4. `resolveRunParams` reproduces R1's resolved params (same version, same
      // raw params) for the `run.started` payload — computed BEFORE the tx (pure).
      const resolvedParams = resolveRunParams(doc, source.params);
      const sourceTctx = sourceEvents.find((e) => e.type === 'run.triggerContext');

      // 5+6. Create R2 and append the whole reseed pair in ONE transaction, so a
      // crash can never leave a `pending` R2 row with no log (or a lone
      // `run.started{rerunOf}` half-state — RS1's crash-safety invariant). The row
      // is created + its status synced to the folded state ALL in-tx; the boot
      // reconciler scans `running` rows, so a crash after commit recovers R2. `bus`
      // is `undefined` in-tx — a rolled-back event must never reach a subscriber;
      // the committed records are published after commit. Replay R1's
      // `run.triggerContext` event VERBATIM (swap runId) so `${trigger.*}` reuses
      // R1's fire-time facts.
      const { runId, records } = db.transaction(() => {
        const r2 = createRun(db, {
          ownerId: source.ownerId,
          pipelineVersionId: source.pipelineVersionId,
          triggerId: null,
          parentRunId: null,
          params: source.params,
          // RS6 — durable lineage: the row records the rerun-from-failed link in
          // the SAME tx as the `run.started{rerunOf}` event appended below, so
          // the row projection and the event log can never disagree.
          rerunOf: sourceRunId,
        });
        const events: EngineEvent[] = [];
        if (sourceTctx !== undefined && sourceTctx.type === 'run.triggerContext') {
          events.push({ ...sourceTctx, runId: r2.id });
        }
        events.push({
          type: 'run.started',
          runId: r2.id,
          pipelineVersionId: source.pipelineVersionId,
          startedAt: new Date(r2.startedAt).toISOString(),
          params: resolvedParams,
          rerunOf: sourceRunId,
        });
        events.push({
          type: 'run.reseeded',
          runId: r2.id,
          sourceRunId,
          frontier,
          copiedOutputs,
          copiedContainers,
        });

        let state: RunState = engine.seedState();
        const recs: RunEvent[] = [];
        for (const event of events) {
          const folded = appendAndFold(db, undefined, engine, state, event, deps.log);
          state = folded.state;
          recs.push(folded.record);
        }
        syncRunLifecycle(db, r2.id, state.status);
        return { runId: r2.id, records: recs };
      });

      // 7. AFTER commit: feed the live-tail bus, then drive R2 IN THE BACKGROUND
      // (fire-and-forget, the manual-fire convention — the caller does not block on
      // the whole rerun). `resume` re-derives the dispatch beyond the frontier (a
      // settled `ready` node carries its `currentAttemptId`, so `onResumed` re-emits
      // it; copied frontier successes carry none and are skipped — no double
      // execution). `driveRun` owns its own faults, so `drive` never rejects.
      for (const record of records) deps.bus?.publish(record);
      const drive = driveRun(deps, runId);
      return { runId, drive };
    },
  };
}
