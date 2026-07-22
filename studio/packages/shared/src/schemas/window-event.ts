import { z } from 'zod';
import { WindowFrequencySchema } from './window.js';

/**
 * #5 S9 — the tumbling-window DOMAIN EVENTS. Per the spec's codex-hardened
 * block: "Tumbling state = projection, not truth. Window lifecycle is domain
 * events; the `tumbling_window_state` table is a materialized projection with
 * uniqueness."
 *
 * This union is deliberately SEPARATE from `EngineEventSchema` (the per-RUN
 * append log): a window exists BEFORE any run materializes for it, so its
 * lifecycle cannot live in a run's log. Window events get their own append
 * table (`window_events`, server-side), scoped by the codex-hardened window
 * key `(triggerId, configEpoch, windowStart)` — those three ride the ROW
 * (columns), so each event's payload carries only what the type adds.
 *
 * The projection (`tumbling_window_state`) is rebuildable by folding a
 * window's events in append order (`foldWindowStatus` is the pure fold's
 * status half; the server's rebuild test pins projection == fold).
 */

export const WINDOW_EVENT_TYPES = [
  'window.created',
  'window.runCreated',
  'window.succeeded',
  'window.failed',
  'window.retryScheduled',
  'window.retryDue',
] as const;

export const WindowEventTypeSchema = z.enum(WINDOW_EVENT_TYPES);
export type WindowEventType = z.infer<typeof WindowEventTypeSchema>;

/**
 * `window.created` — the window became known/due and entered the state
 * projection as `waiting`. The payload is SELF-SUFFICIENT (geometry snapshot):
 * after a later config edit the old epoch's window size is no longer derivable
 * from the live trigger config, so the event must carry everything a rebuild
 * needs — `windowEnd` plus the geometry tuple that minted the epoch.
 */
export const WindowCreatedPayloadSchema = z.object({
  windowEnd: z.string().datetime(),
  frequency: WindowFrequencySchema,
  interval: z.number().int().positive(),
  startTime: z.string().datetime(),
  /**
   * #5 S10 — HOW the window became known: `'live'` = the forward `window_due`
   * chain (the S9 path), `'backfill'` = the bounded backfill pass re-covering
   * windows missed during downtime. OPTIONAL and absent in every pre-S10 log
   * (absent = live semantically) — the schema stays read-compatible with S9
   * events rather than manufacturing a value on parse. Origin drives the
   * materialization gate (backfill windows fire one-at-a-time; live windows
   * keep S9's ungated behavior) — recorded on the event so a rebuild can
   * re-derive the projection's `origin` column.
   */
  origin: z.enum(['live', 'backfill']).optional(),
});
export type WindowOrigin = NonNullable<z.infer<typeof WindowCreatedPayloadSchema>['origin']>;

/**
 * `window.runCreated` — exactly one run materialized for the window
 * (projection `waiting → running`). `via` records HOW: `'fire'` = the normal
 * launcher fire; `'reconcile'` = a crash between the fire and this event's
 * append left the run unlinked, and reconcile LINKED the existing run instead
 * of firing a second one (the single-fire heal).
 */
export const WindowRunCreatedPayloadSchema = z.object({
  runId: z.string().min(1),
  via: z.enum(['fire', 'reconcile']),
});

/** `window.succeeded` — the window's run reached `success`. */
export const WindowSucceededPayloadSchema = z.object({
  runId: z.string().min(1),
});

/**
 * `window.failed` — the window's run terminalized without success, and #5
 * S11c's retry policy did NOT claim it (no policy, budget exhausted, stale
 * epoch, unreadable trigger row, or an unknown outcome). TERMINAL: a failed
 * window is never re-driven — a retry happens INSTEAD of this event
 * (`window.retryScheduled`), never after it. `runStatus`: `failure` (the run
 * failed), `interrupted` (crash/abort — a terminal run fact), or `missing`
 * (the linked run row is GONE at reconcile time — an absent fact folded
 * closed as failure, never silently dropped).
 */
export const WindowFailedPayloadSchema = z.object({
  runId: z.string().min(1).nullable(),
  runStatus: z.enum(['failure', 'interrupted', 'missing']),
});

/**
 * `window.retryScheduled` — #5 S11c: the window's run terminalized with a
 * KNOWN failure and the per-trigger retry policy has budget left, so the
 * window holds (`running → retry_pending`) until `nextAttemptAt` instead of
 * folding terminal. `runStatus` deliberately EXCLUDES `missing`: a vanished
 * run row means the outcome is unknown — the run may have SUCCEEDED — so a
 * retry would manufacture duplicate side effects from an absent fact;
 * `missing` stays a terminal `window.failed`. `attempt` is the retry ordinal
 * this event consumed (1-based); `nextAttemptAt` is the STORED due instant
 * (`scheduled_wakeups.dueAt` mirrors it — never recomputed at fold time).
 */
export const WindowRetryScheduledPayloadSchema = z.object({
  runId: z.string().min(1),
  runStatus: z.enum(['failure', 'interrupted']),
  attempt: z.number().int().positive(),
  nextAttemptAt: z.string().datetime(),
});

/**
 * `window.retryDue` — #5 S11c: the retry interval elapsed (the `window_retry`
 * alarm fired, or the sync/reconcile overdue heal drove it); the window
 * re-enters the materialize scan (`retry_pending → waiting`) and its next run
 * links via a fresh `window.runCreated`.
 */
export const WindowRetryDuePayloadSchema = z.object({
  attempt: z.number().int().positive(),
});

export const WindowEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('window.created'), payload: WindowCreatedPayloadSchema }),
  z.object({ type: z.literal('window.runCreated'), payload: WindowRunCreatedPayloadSchema }),
  z.object({ type: z.literal('window.succeeded'), payload: WindowSucceededPayloadSchema }),
  z.object({ type: z.literal('window.failed'), payload: WindowFailedPayloadSchema }),
  z.object({
    type: z.literal('window.retryScheduled'),
    payload: WindowRetryScheduledPayloadSchema,
  }),
  z.object({ type: z.literal('window.retryDue'), payload: WindowRetryDuePayloadSchema }),
]);
export type WindowEvent = z.infer<typeof WindowEventSchema>;

/**
 * The projection's status vocabulary (spec S3: "waiting / running / succeeded
 * / failed"). `waiting` = created, no run yet; `running` = a run is linked
 * (its OWN lifecycle — queued/running/waiting — is the run's story, not
 * re-modelled here); `retry_pending` (#5 S11c) = the last run failed and the
 * retry interval is elapsing — no run in flight, so the window holds NO
 * per-window concurrency slot (capacity counts `running` only) and does NOT
 * close the S10 backfill gate; `succeeded`/`failed` are terminal.
 */
export const WindowStatusSchema = z.enum([
  'waiting',
  'running',
  'succeeded',
  'failed',
  'retry_pending',
]);
export type WindowStatus = z.infer<typeof WindowStatusSchema>;

/**
 * The PURE fold from a window's event sequence (append order) to its
 * projection status — the rebuild authority the server's projection must
 * agree with. Unknown/out-of-order transitions keep the prior status (the
 * projection's own guarded writes make them unreachable; the fold stays total
 * rather than throwing on a hand-edited log).
 */
export function foldWindowStatus(events: ReadonlyArray<WindowEvent>): WindowStatus | null {
  let status: WindowStatus | null = null;
  for (const event of events) {
    switch (event.type) {
      case 'window.created':
        status = status ?? 'waiting';
        break;
      case 'window.runCreated':
        if (status === 'waiting') status = 'running';
        break;
      case 'window.succeeded':
        if (status === 'running') status = 'succeeded';
        break;
      case 'window.failed':
        // `running` only — MIRRORS the write path exactly (`completeWindow`
        // guards every terminal transition, success or failure, on the current
        // status being `running`), so the fold and the guarded projection can
        // never diverge on an out-of-order sequence.
        if (status === 'running') status = 'failed';
        break;
      case 'window.retryScheduled':
        // #5 S11c — same discipline: mirrors `retryWindow`'s `running` guard.
        if (status === 'running') status = 'retry_pending';
        break;
      case 'window.retryDue':
        // Mirrors `retryDueWindow`'s `retry_pending` guard.
        if (status === 'retry_pending') status = 'waiting';
        break;
    }
  }
  return status;
}
