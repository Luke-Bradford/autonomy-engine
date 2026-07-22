import { z } from 'zod';

/**
 * #5 S9 — the tumbling-window trigger's window GEOMETRY. Deliberately narrower
 * than `RecurrenceFrequencySchema`: every tumbling frequency must yield a
 * FIXED-duration window (`[start + k*size, start + (k+1)*size)` is only
 * well-defined when `size` is constant), so the variable-length calendar units
 * (`week` is fixed but omitted as a non-goal; `month` is genuinely variable)
 * are excluded in v1. UTC only — windows are anchored at `startTime` and
 * stepped in fixed ms, so a time zone would only relabel the same instants.
 */
export const WindowFrequencySchema = z.enum(['minute', 'hour', 'day']);
export type WindowFrequency = z.infer<typeof WindowFrequencySchema>;

/**
 * #5 S9 — a `tumbling`-mode trigger's window config. Windows are the
 * contiguous, non-overlapping intervals `[startTime + k*size, startTime +
 * (k+1)*size)` for `k >= 0`, where `size = interval * frequency` (fixed ms,
 * UTC). Each window fires ONCE, when it CLOSES (`dueAt = windowEnd`) — the
 * window's data span is complete at that instant.
 *
 * IDENTITY vs FRESHNESS (the codex-hardened window key,
 * scheduler-lifecycle.md): `frequency`/`interval`/`startTime` are the window
 * GEOMETRY — they define which instants are window boundaries, and together
 * they mint the config EPOCH (`windowConfigEpoch`, server-side) that keys
 * every window. `endTime` is a BOUND, not geometry: extending or shortening it
 * never changes any window's identity, only which windows are eligible to
 * fire — so it deliberately does NOT participate in the epoch (an `endTime`
 * edit must not re-key — and thus re-fire — already-fired windows).
 */
export const WindowConfigSchema = z.object({
  frequency: WindowFrequencySchema,
  /** Window size multiplier: `interval * frequency` (e.g. `{frequency:
   * 'minute', interval: 15}` = 15-minute windows). */
  interval: z.number().int().positive(),
  /** The UTC anchor of window 0 — every window boundary is `startTime + k*size`. */
  startTime: z.string().datetime(),
  /** Optional upper bound: a window fires only if `windowEnd <= endTime` (a
   * PARTIAL trailing window never fires — its data span would be incomplete). */
  endTime: z.string().datetime().optional(),
  /**
   * #5 S10 — opt-in bounded BACKFILL: at most this many of the MOST RECENT
   * fully-closed windows missed while the trigger was down/disabled (or before
   * it existed, for a past `startTime`) are created and materialized; older
   * missed windows are permanently skipped (the durable cursor jumps past
   * them, logged). ABSENT = no backfill — the exact S9 forward-only behavior;
   * an upgrade must never surprise-fire past windows for an existing trigger,
   * so this is deliberately opt-in even though the spec's per-kind catch-up
   * line reads "tumbling = bounded backfill" (a conscious, documented
   * deviation). A BOUND like `endTime`, not geometry: it does not participate
   * in the config epoch and never re-keys windows. The write-boundary cap
   * (1000, `WindowConfigWriteSchema`) bounds the created-rows blast radius;
   * the stored shape stays lenient (structural checks only) so a row persisted
   * under a future, looser cap never throws on read.
   */
  maxBackfillWindows: z.number().int().positive().optional(),
});
export type WindowConfig = z.infer<typeof WindowConfigSchema>;

/** The #5 S10 write-boundary cap on `maxBackfillWindows` — bounds the windows
 * one backfill pass may create (see `WindowConfigWriteSchema`). */
export const MAX_BACKFILL_WINDOWS_CAP = 1000;

/**
 * WRITE-boundary shape: the stored shape PLUS the one cross-field rule —
 * `endTime`, when present, must be strictly after `startTime` (an empty or
 * negative span can never contain a whole window, so authoring one is a
 * mistake, refused up front). Shared so the client can pre-validate the same
 * way the server does (`ConcurrencyWriteSchema` precedent). `Date.parse` is
 * total here: both fields are `z.string().datetime()`-validated first.
 */
export const WindowConfigWriteSchema = WindowConfigSchema.superRefine((w, ctx) => {
  if (w.endTime !== undefined && Date.parse(w.endTime) <= Date.parse(w.startTime)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endTime'],
      message: '`endTime` must be strictly after `startTime`',
    });
  }
  // #5 S10 — cap the backfill bound at authoring time (a WRITE concern, like
  // the endTime rule above: the stored shape stays lenient on read).
  if (w.maxBackfillWindows !== undefined && w.maxBackfillWindows > MAX_BACKFILL_WINDOWS_CAP) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxBackfillWindows'],
      message: `\`maxBackfillWindows\` must be at most ${MAX_BACKFILL_WINDOWS_CAP}`,
    });
  }
});
