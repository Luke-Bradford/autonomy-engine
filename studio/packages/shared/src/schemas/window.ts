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
 * #5 S11c — a tumbling trigger's per-window RETRY policy (ADF's tumbling
 * `retryPolicy {count, intervalInSeconds}`): a window whose run terminalizes
 * with a KNOWN failure (`failure`/`interrupted` — never `missing`, an unknown
 * outcome) is re-driven up to `count` times, `intervalInSeconds` apart, before
 * `window.failed` becomes terminal. Both fields required — a half-specified
 * policy is an authoring mistake, refused at the object shape.
 */
export const WindowRetryPolicySchema = z.object({
  /** Max re-drives per window (attempts = 1 initial + up to `count` retries). */
  count: z.number().int().positive(),
  /** Delay between a failed attempt and its retry — a STORED fact at schedule
   * time (`scheduled_wakeups.dueAt`), never recomputed. */
  intervalInSeconds: z.number().int().positive(),
});
export type WindowRetryPolicy = z.infer<typeof WindowRetryPolicySchema>;

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
  /**
   * #5 S11a — per-window CONCURRENCY: at most this many of the trigger's
   * windows may hold a run at once (window status `running`, trigger-wide,
   * ANY epoch — an old-epoch run still consumes real capacity). When set,
   * materialization is capacity-gated and a blocked window WAITS IN WINDOW
   * STATE (no run row) — the codex-hardened "blocked windows live in window
   * state, NOT as full runs" — and the launcher's per-trigger admission widens
   * to the same cap so materialized runs actually execute in parallel. ABSENT
   * = the exact S9/S10 behavior (live windows materialize ungated into the
   * admission queue; backfill fires one-at-a-time at zero running windows) —
   * an upgrade must never change a shipped trigger's semantics, so the gate is
   * opt-in like `maxBackfillWindows`. A BOUND like `endTime`, not geometry: it
   * does not participate in the config epoch and never rides the alarm ref (it
   * never affects the pending forward row's eligibility). The write-boundary
   * cap (50, ADF's tumbling `maxConcurrency` range) lives in
   * `WindowConfigWriteSchema`; the stored shape stays lenient and the gate
   * HONORS a stored over-cap value (the `maxBackfillWindows` precedent).
   */
  maxConcurrentWindows: z.number().int().positive().optional(),
  /**
   * #5 S11c — opt-in per-window RETRY (see `WindowRetryPolicySchema`). ABSENT
   * = no retry — `window.failed` is terminal on the first failed run, the
   * exact S9-S11b behavior (an upgrade must never change a shipped trigger's
   * semantics — the `maxBackfillWindows`/`maxConcurrentWindows` rule). A
   * BOUND like the other three: it does not participate in the config epoch
   * and never rides the `window_due` alarm ref (it never affects the pending
   * forward row's eligibility — it only governs the settle-time decision for
   * an already-fired window). The write-boundary caps (count ≤ 100, interval
   * 30–86400s — ADF's activity-retry range) live in `WindowConfigWriteSchema`;
   * the stored shape stays lenient and the settle path HONORS a stored
   * out-of-range value (the `maxBackfillWindows` precedent).
   */
  retry: WindowRetryPolicySchema.optional(),
});
export type WindowConfig = z.infer<typeof WindowConfigSchema>;

/** The #5 S10 write-boundary cap on `maxBackfillWindows` — bounds the windows
 * one backfill pass may create (see `WindowConfigWriteSchema`). */
export const MAX_BACKFILL_WINDOWS_CAP = 1000;

/** The #5 S11a write-boundary cap on `maxConcurrentWindows` — ADF's tumbling
 * `maxConcurrency` range is 1-50 (see `WindowConfigWriteSchema`). */
export const MAX_CONCURRENT_WINDOWS_CAP = 50;

/** #5 S11c write-boundary caps on `retry` — count bounds the duplicate-run
 * blast radius of one window (100 re-drives is already pathological);
 * the interval bounds are ADF's activity-retry range (30–86400s). */
export const MAX_WINDOW_RETRY_COUNT_CAP = 100;
export const MIN_WINDOW_RETRY_INTERVAL_SECONDS = 30;
export const MAX_WINDOW_RETRY_INTERVAL_SECONDS = 86_400;

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
  // #5 S11a — cap the per-window concurrency at authoring time (same shape:
  // write concern; the stored shape stays lenient on read).
  if (w.maxConcurrentWindows !== undefined && w.maxConcurrentWindows > MAX_CONCURRENT_WINDOWS_CAP) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxConcurrentWindows'],
      message: `\`maxConcurrentWindows\` must be at most ${MAX_CONCURRENT_WINDOWS_CAP}`,
    });
  }
  // #5 S11c — bound the retry policy at authoring time (same shape: write
  // concern; the stored shape stays lenient on read).
  if (w.retry !== undefined) {
    if (w.retry.count > MAX_WINDOW_RETRY_COUNT_CAP) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['retry', 'count'],
        message: `\`retry.count\` must be at most ${MAX_WINDOW_RETRY_COUNT_CAP}`,
      });
    }
    if (
      w.retry.intervalInSeconds < MIN_WINDOW_RETRY_INTERVAL_SECONDS ||
      w.retry.intervalInSeconds > MAX_WINDOW_RETRY_INTERVAL_SECONDS
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['retry', 'intervalInSeconds'],
        message: `\`retry.intervalInSeconds\` must be between ${MIN_WINDOW_RETRY_INTERVAL_SECONDS} and ${MAX_WINDOW_RETRY_INTERVAL_SECONDS}`,
      });
    }
  }
});
