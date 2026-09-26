import {
  TERMINAL_RUN_ROW_STATUS,
  type CancelSource,
  type RunStatus,
} from '@autonomy-studio/shared';
import { cancelQueuedRun, getRun } from '../repo/runs.js';
import type { RunCancels } from './cancel.js';
import { driveCancelIntent, type DriveDeps } from './driver.js';
import { loadEngineEvents, RunLogUnparseableError, terminalFactFromLog } from './events.js';

/**
 * CX2 (#1320) — what `cancel` did, for the route to map onto a status code
 * (spec D5). Each arm is a distinct answer, so none is folded into another:
 *  - `accepted`: `requested` means the intent is recorded and will be folded by
 *    whoever holds the run; `cancelled` means the run was `queued` and the row
 *    patch already made it terminal.
 *  - `terminal`: the run had already ended. Nothing was recorded.
 *  - `log_unreadable`: the log cannot be parsed, so no fold is possible and
 *    writing a terminal fact without one would be manufactured, not derived.
 *  - `not_found`: the row vanished between the route's ownership check and here.
 */
export type CancelVerdict =
  | { kind: 'accepted'; state: 'requested' | 'cancelled' }
  | { kind: 'terminal'; status: RunStatus }
  | { kind: 'log_unreadable' }
  | { kind: 'not_found' };

export interface RunCanceller {
  cancel(runId: string, source?: CancelSource): CancelVerdict;
}

/**
 * The route's half of a cancel (spec D6). It never appends the fact itself: a
 * live pump holds the run's state in memory, and an out-of-band append beside it
 * would fork the run's history. It records the INTENT, pokes the live pump if
 * there is one, and queues a drive behind the run's lock for the case where no
 * pump holds it (or one dropped the poke at teardown). Exactly one of those folds
 * it (`cancel.ts`).
 *
 * Authorization is the CALLER's: the route resolves the run through
 * `requireOwned` before calling this, and this takes no owner.
 */
export interface RunCancellerDeps extends DriveDeps {
  cancels: RunCancels;
  /**
   * Called after a `queued` run is ended by row patch. That terminal is written
   * without a run event, so nothing on the bus announces it, and whoever settles
   * work on a run-terminal event must be told directly. Production wires the
   * tumbling-window settle here: a window links its run while the run is still
   * queued, and would otherwise stay `running` until the next boot reconcile.
   */
  onQueuedRunCancelled?: (runId: string) => void;
}

export function createRunCanceller(deps: RunCancellerDeps): RunCanceller {
  return {
    cancel(runId, source = { kind: 'operator' }) {
      let run = getRun(deps.db, runId);
      if (run === null) return { kind: 'not_found' };

      if (run.status === 'queued') {
        if (cancelQueuedRun(deps.db, runId)) {
          deps.onQueuedRunCancelled?.(runId);
          return { kind: 'accepted', state: 'cancelled' };
        }
        // Admission won the race: the run is now `pending` (or further), and is
        // cancelled the event-sourced way below.
        run = getRun(deps.db, runId);
        if (run === null) return { kind: 'not_found' };
      }
      if (TERMINAL_RUN_ROW_STATUS.has(run.status)) return { kind: 'terminal', status: run.status };

      let events;
      try {
        events = loadEngineEvents(deps.db, runId);
      } catch (err) {
        if (err instanceof RunLogUnparseableError) return { kind: 'log_unreadable' };
        throw err;
      }
      // The LOG decides terminality, never the row (#443): a row can lag its log.
      const fact = terminalFactFromLog(events);
      if (fact !== null) return { kind: 'terminal', status: fact };

      // Idempotent: a second cancel records nothing and queues nothing.
      const alreadyFolded = events.some((e) => e.type === 'run.cancelRequested');
      if (alreadyFolded || deps.cancels.pending(runId)) {
        return { kind: 'accepted', state: 'requested' };
      }

      deps.cancels.request(runId, source);
      deps.cancels.poke(runId);
      // Not awaited: the answer is "requested", and in-flight work stops only
      // cooperatively. The drive owns its own faults (`driveLocked`); the catch
      // is for anything outside it, which has no other handler once this route
      // has answered.
      driveCancelIntent(deps, runId).catch((err: unknown) => {
        deps.log?.error({ err, runId }, 'run cancel: the serialized drive failed');
      });
      return { kind: 'accepted', state: 'requested' };
    },
  };
}
