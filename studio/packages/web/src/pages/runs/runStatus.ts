import type { RunStatus, WaitingReason } from '@autonomy-studio/shared';

/**
 * #870 — the Monitor's ONE run-level status vocabulary, the twin of
 * `nodeStatus.ts` one level up.
 *
 * U25 ended the node table's private vocabulary; the RUN's survived it. The
 * runs list rendered the DB enum identifier verbatim, the run detail header
 * rendered either the engine's `RunLifecycleStatus` or the row's `RunStatus`
 * depending on whether a lifecycle event had landed yet, and nothing checked
 * that the two surfaces and the S6 lifecycle agreed. That is the same drift the
 * node half closed, so it is closed the same way: the vocabulary is the
 * ENGINE's/DB's, the wording lives here once, and neither surface owns words.
 *
 * WHICH ENUM IS THE SUPERSET matters, and is the reason one map can serve both
 * surfaces. The DB's `RunStatusSchema` (`shared/schemas/run.ts`) has eight
 * members; the engine's `RunLifecycleStatusSchema` (`shared/engine/types.ts`)
 * has six and is a documented SUBSET of it — `queued` and `skipped` are ROW
 * statuses the projection never produces. So `Record<RunStatus, string>` covers
 * everything either surface can show, and passing a `RunLifecycleStatus` into
 * `runStatusLabel` is checked by the compiler at the call site. That IS the
 * guard: widening the engine enum without widening the DB enum stops the build
 * in `RunDetailPage` rather than putting an unworded identifier on screen.
 *
 * Type-only against `@autonomy-studio/shared`, for the same reason
 * `nodeStatus.ts` is: the runs LIST reaches for a label with no doc, no stream
 * and no reducer in sight, and must not pull the engine in to get one.
 */

/**
 * What an OPERATOR is told a run is doing. Exhaustive by construction, so a
 * ninth DB status has to be worded deliberately instead of leaking its
 * identifier onto the screen.
 *
 * Same three rules that produced the node table (`nodeStatus.ts`):
 *
 *  1. **A status whose identifier already reads as English keeps it.**
 *     `pending`, `running`, `success`, `failure`, `skipped` and `interrupted`
 *     are not improved by paraphrase, and inventing synonyms would be a second
 *     vocabulary in the module that exists to end one.
 *  2. **A status that names the ENGINE's act is re-worded to say what the RUN
 *     is doing.** `queued` records that admission put the fire in the durable
 *     queue; the operator is asking why it has not started, and the answer is
 *     that it is holding for a concurrency slot. (`launcher.ts` — a fire is
 *     queued when it passes neither the trigger's policy cap nor the pipeline's
 *     `concurrency` cap; when a slot frees, `drainPipelineQueue` admits across
 *     that pipeline's triggers least-recently-served first, oldest-queued first
 *     WITHIN a trigger. Only `pending`/`running` occupy a slot.)
 *  3. **A park says WHAT it is parked on** — see `runStatusLabel`.
 */
const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  pending: 'pending',
  queued: 'queued (slot)',
  running: 'running',
  success: 'success',
  failure: 'failure',
  skipped: 'skipped',
  // Bare, and completed by the reason where one is known — see `runStatusLabel`.
  waiting: 'waiting',
  interrupted: 'interrupted',
};

/**
 * The parenthetical names THE THING AWAITED, as a bare noun, exactly as the
 * node labels do (`waiting (timer)` / `waiting (callback)`).
 *
 * `waiting_concurrency` deliberately shares the noun `slot` with the `queued`
 * label above. They are not two different waits worded alike — they are the
 * SAME hold at two points in the lifecycle: `queued` is pre-admission (no event
 * log yet), `waiting_concurrency` would be a run already started and re-held.
 * Giving them different nouns would claim a distinction the operator does not
 * have to care about.
 *
 * `waiting_concurrency` and `waiting_dependency` are RESERVED: the engine
 * declares them but nothing emits them yet (S6 admission and S9-S11 tumbling
 * own their producers — `types.ts` and `parkReason` in `reduce.ts` both say
 * so). They are worded here anyway because the map is exhaustive by
 * construction, not because they render today.
 */
const WAITING_REASON_LABELS: Record<WaitingReason, string> = {
  waiting_timer: 'timer',
  waiting_external: 'callback',
  waiting_concurrency: 'slot',
  waiting_dependency: 'dependency',
};

/**
 * The label for a run's status, completed by the park REASON when one is known.
 *
 * A `waiting` run that cannot say why is not a defect to be defended against —
 * it is the runs LIST, which reads the DB row and there is no `waiting_reason`
 * column on it (`RunSchema`). The reason is durable in the event log and on
 * `RunState.waitingReason`, so the detail page (which has both) says
 * `waiting (timer)` while the list says `waiting`. That is one surface knowing
 * MORE than another, not the two contradicting each other — the same shape U25
 * settled for the graph vs the node table.
 *
 * A reason passed with a non-`waiting` status is ignored, mirroring the
 * reducer, which nulls `waitingReason` on every edge out of `waiting`
 * (`unparkIfWaiting`).
 */
export function runStatusLabel(
  status: RunStatus,
  waitingReason: WaitingReason | null = null,
): string {
  if (status === 'waiting' && waitingReason !== null) {
    return `waiting (${WAITING_REASON_LABELS[waitingReason]})`;
  }
  return RUN_STATUS_LABELS[status];
}
