import type { RunStatus, WaitingReason } from '@autonomy-studio/shared';
import type { StatusTone } from './nodeStatus';

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
 * Worded by the same three rules `nodeStatus.ts` states in full, applied here:
 *
 *  1. An identifier that already reads as English keeps it — `pending`,
 *     `running`, `success`, `failure`, `skipped`, `interrupted`.
 *  2. A status naming the ENGINE's act is re-worded to say what the RUN is
 *     doing. `queued` records that admission put the fire in the durable queue;
 *     the operator is asking why it has not started, and the answer is that it
 *     is holding for a concurrency slot. (`launcher.ts`: a fire is queued when
 *     the PIPELINE is at its `concurrency` cap, or when a `queue`-policy trigger
 *     is at its own — a `skip_if_running`/`parallel` trigger over its cap is
 *     SKIPPED rather than queued. When a slot frees, `drainPipelineQueue` admits
 *     across that pipeline's triggers least-recently-served first, oldest-queued
 *     first within a trigger; only `pending`/`running` occupy a slot.)
 *  3. A park says WHAT it is parked on — see `runStatusLabel`.
 *
 * NOT in scope, deliberately: the `queued` a trigger FIRE returns
 * (`TriggersPage`'s toast renders `FireOutcome`, a different enum answering
 * "what did this fire do" rather than "what is this run doing"). Wording the two
 * alike would assert they are the same fact. They are adjacent, not identical.
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

/**
 * U29 (#1015) — what COLOUR a run is, for the surfaces that paint rather than
 * word: the cross-run timeline's bars.
 *
 * Here rather than in the chart for the reason the file header gives — the run
 * vocabulary lives in one place — and exhaustive by construction for the reason
 * `RUN_STATUS_LABELS` is: a ninth `RunStatus` must force a decision rather than
 * fall through to a default hue. That default is not hypothetical. A timeline
 * bar carries a `background` so the track is visible at all, so a status with no
 * tone does not render as nothing; it renders as a plausible grey bar that
 * reports a FAILURE as neutral, which is the one thing a monitoring chart may
 * not do. `palette.test.ts` pins a CSS rule for every tone this can return.
 *
 * The tone vocabulary is `nodeStatus.ts`'s `StatusTone`, deliberately shared:
 * "this went wrong" should be the same red whether the thing is a node or a run.
 * The MAPPING is not shared, and could not be — these are different enums — and
 * the same non-injectivity the node half records applies here: several statuses
 * collapse onto `holding`, which is fine on a chart where the WORD sits beside
 * the bar.
 *
 * Two calls worth stating rather than leaving to be inferred:
 *
 *  - `interrupted` is `failure`, not `neutral`. The run did not do what it was
 *    asked to; that it was stopped from outside rather than by an activity
 *    throwing is a distinction the label already draws. Greying it would hide
 *    the row an operator scanning for trouble is looking for.
 *  - `pending` and `queued` are `holding`, not `running`. Neither is plotted as
 *    a bar today — `unplottableReason` refuses `queued` outright, and `pending`
 *    is plottable but has no finish to measure — and nothing renders a swatch
 *    for the named list beneath the chart, so NO surface currently reads either
 *    tone. They are worded anyway because the map is exhaustive by construction:
 *    the only thing reading them is `palette.test.ts`'s completeness loop, which
 *    is what guarantees a CSS rule exists before some later surface does read
 *    one. Getting them right now is cheaper than discovering the default grey
 *    later, and "running" would be the same lie in a swatch that plotting a
 *    queued fire would be in a bar.
 */
const RUN_TONES: Record<RunStatus, StatusTone> = {
  pending: 'holding',
  queued: 'holding',
  running: 'running',
  waiting: 'holding',
  success: 'success',
  failure: 'failure',
  interrupted: 'failure',
  skipped: 'skipped',
};

export function runStatusTone(status: RunStatus): StatusTone {
  return RUN_TONES[status];
}
