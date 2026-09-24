import type { EngineEvent, RunEvent, RunState } from '@autonomy-studio/shared';
import type { Db } from '../repo/types.js';
import { appendAndFold, type DiagnosticLog } from './events.js';
import { driveRun, syncRunLifecycle, type DriveDeps } from './driver.js';

/**
 * #1021 — the ONE home for appending to a run from OUTSIDE its drive: the webhook
 * completer (`external-wait-service.ts`), the child-return reactor (`child.ts`),
 * the rerun reseed (`reseed.ts`) and the durable-alarm fire
 * (`scheduler/durable-alarm-handler.ts`). Each owns a DIFFERENT guard (a
 * correlation-row CAS, a `call.started` lookup, a fresh run, an alarm-identity
 * check) and keeps it; what they share is the ORDERING, which has two
 * non-obvious hazards and was hand-rolled four times:
 *
 *  1. Append + fold + lifecycle sync happen INSIDE the caller's transaction with
 *     NO bus — `foldOutOfBand`. Publishing inside the transaction would let a
 *     live-tail subscriber observe an event a rollback then erases. There is no
 *     bus parameter, so the in-transaction publish cannot be written through it.
 *  2. AFTER commit, publish the committed records, THEN drive — `publishThenDrive`.
 *     `driveRun` may bill real LLM calls, so it must never start inside the
 *     transaction (a rollback would erase the log the detached drive appends to).
 *     That half is REFUSED at run time rather than documented: see
 *     `assertNoOpenTransaction`.
 *
 * One hazard stays a convention, because it cannot be detected cheaply:
 * `driveRun` takes the run's drive lock itself, and `drives.serialize` is a
 * non-reentrant `pLimit(1)` — so `publishThenDrive` must never be called while
 * the SAME run's lock is held, or it deadlocks. `child.ts`'s `kick` (#796) is
 * the worked example: it releases the lock first and lets `driveRun`
 * re-take it.
 *
 * The alarm handler uses only the first half: its transaction belongs to the
 * clock (`scheduler/alarms.ts`), which already publishes the returned records
 * after commit and runs the handler's `afterCommit` drive.
 */

/**
 * Append and fold `events` onto `state` in order, then sync the run row's
 * lifecycle to the resulting status. Call it inside the transaction that holds
 * the caller's guard, so the guard, the append and the row sync commit or roll
 * back together. Returns the folded state and the records to hand to
 * `publishThenDrive` (or to the clock) once the transaction has committed.
 *
 * The run is taken from the events themselves, and every event must name the
 * same one — a separate `runId` argument could sync one run's row after
 * appending to another's log.
 */
export function foldOutOfBand(
  db: Db,
  engine: Parameters<typeof appendAndFold>[2],
  state: RunState,
  events: readonly [EngineEvent, ...EngineEvent[]],
  log?: DiagnosticLog,
): { state: RunState; records: [RunEvent, ...RunEvent[]] } {
  const runId = sameRun(events);
  let folded = state;
  const records: RunEvent[] = [];
  for (const event of events) {
    const result = appendAndFold(db, undefined, engine, folded, event, log);
    folded = result.state;
    records.push(result.record);
  }
  syncRunLifecycle(db, runId, folded.status);
  return { state: folded, records: records as [RunEvent, ...RunEvent[]] };
}

/**
 * AFTER commit: publish `records` to the live-tail bus in order, then start the
 * run's drive and return it. Deliberately NOT `async`: the open-transaction
 * refusal must throw SYNCHRONOUSLY, so that a misplaced call inside a
 * transaction callback rolls that transaction back, rather than surfacing as a
 * rejected `drive` — which two callers document as never rejecting and may
 * discard with `void`.
 *
 * The returned promise is `driveRun`'s, and so never rejects: `driveRun` owns its
 * own faults (`terminalizeInterrupted`).
 */
export function publishThenDrive(
  deps: DriveDeps,
  records: readonly [RunEvent, ...RunEvent[]],
): Promise<void> {
  assertNoOpenTransaction(deps.db);
  const runId = sameRun(records);
  for (const record of records) deps.bus?.publish(record);
  return driveRun(deps, runId);
}

/**
 * Refuse unless `db` provably has NO open transaction. Fails CLOSED on a handle
 * that cannot answer: a drizzle transaction handle carries no `$client` (only
 * the root database returned by `drizzle()` does), and a handle without one
 * reads as "not in a transaction" if probed naively — the fail-open direction.
 */
function assertNoOpenTransaction(db: Db): void {
  const client = (db as Db & { $client?: { inTransaction?: unknown } }).$client;
  if (client?.inTransaction !== false) {
    throw new Error(
      'publishThenDrive: refusing to publish or drive with a transaction open (or on a handle ' +
        'that cannot say) — a rolled-back event must never reach a subscriber, and a drive ' +
        'must never start inside a transaction',
    );
  }
}

function sameRun(events: readonly [{ runId: string }, ...{ runId: string }[]]): string {
  const runId = events[0].runId;
  for (const e of events) {
    if (e.runId !== runId) {
      throw new Error(`out-of-band append spans two runs ('${runId}' and '${e.runId}')`);
    }
  }
  return runId;
}
