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
});

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
 * `window.failed` — the window's run terminalized without success.
 * `runStatus`: `failure` (the run failed), `interrupted` (crash/abort — a
 * terminal run fact, so the window is terminal too; #5 S11's per-trigger retry
 * policy is what will re-drive a failed window), or `missing` (the linked run
 * row is GONE at reconcile time — an absent fact folded closed as failure,
 * never silently dropped).
 */
export const WindowFailedPayloadSchema = z.object({
  runId: z.string().min(1).nullable(),
  runStatus: z.enum(['failure', 'interrupted', 'missing']),
});

export const WindowEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('window.created'), payload: WindowCreatedPayloadSchema }),
  z.object({ type: z.literal('window.runCreated'), payload: WindowRunCreatedPayloadSchema }),
  z.object({ type: z.literal('window.succeeded'), payload: WindowSucceededPayloadSchema }),
  z.object({ type: z.literal('window.failed'), payload: WindowFailedPayloadSchema }),
]);
export type WindowEvent = z.infer<typeof WindowEventSchema>;

/**
 * The projection's status vocabulary (spec S3: "waiting / running / succeeded
 * / failed"). `waiting` = created, no run yet; `running` = a run is linked
 * (its OWN lifecycle — queued/running/waiting — is the run's story, not
 * re-modelled here); `succeeded`/`failed` are terminal.
 */
export const WindowStatusSchema = z.enum(['waiting', 'running', 'succeeded', 'failed']);
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
    }
  }
  return status;
}
