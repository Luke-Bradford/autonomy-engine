import { z } from 'zod';

/**
 * #5 S5b-1 — the ADF-style recurrence MODEL for schedule triggers.
 *
 * Replaces authoring a raw cron string with a structured recurrence object
 * (`{frequency, interval, schedule?}`) that COMPILES to a cron string
 * (`recurrenceToCron`) — "croner under the hood", exactly as spec #5 §S2 frames
 * it. The compiled string is stored in the existing `Trigger.schedule` (a pure
 * DERIVED cache), so the whole firing chain — `isSchedulable`, the
 * `nextOccurrence` calculator, the `isRefFresh` freshness compare — is
 * REUSED UNCHANGED. The raw cron string stays as an escape-hatch mode for
 * power users (a trigger has EITHER a `recurrence` or a raw `schedule`, never
 * both; the repo write path derives + enforces this).
 *
 * ## v1 scope (deliberate, documented — not silent cuts)
 *
 * - **`interval > 1` ("every N periods") is server-COMPUTED, not cron-compiled**
 *   (#550, shipped). It is not faithfully cron-expressible (day/week stepping has no
 *   cron form; minute/hour/month cron-step syntax is period-GRID-anchored, not
 *   `startTime`-anchored as the semantics require), so `recurrenceToCron` still
 *   compiles ONLY the within-period pattern (interval is ignored by the compiler)
 *   and the server's `nextOccurrence` stepping calculator gates fires to the
 *   qualifying periods. Write rules: `interval > 1` REQUIRES `startTime` (the
 *   anchor that defines period 0) and is capped at `MAX_RECURRENCE_INTERVAL`.
 * - **`startTime`/`endTime` bounds land in S5b-2** (#549): a half-open window
 *   `[startTime, endTime)`, threaded to croner (`startAt`/`stopAt`) by the firing
 *   chain (`nextOccurrence`) so the bounds actually gate firing rather than being
 *   inert surface.
 *   All datetimes are UTC-with-`Z` (`z.string().datetime()` refuses offsets/naive).
 * - **`timeZone` lands in S5b-timeZone** (#552): an IANA zone in which the cron
 *   pattern is INTERPRETED, so a schedule fires at a wall-clock time in a non-UTC
 *   zone (croner 10.0.1 honours `timezone` natively, DST included). It lands WITH
 *   its real consumer — non-UTC firing threaded through `nextOccurrence` — not as a
 *   `'UTC'`-only inert field. Absent ⇒ UTC (the run-window contract), so a
 *   timeZone-free recurrence is byte-identical to a pre-#552 one. **Two seams the
 *   caller must know:** (1) `interval > 1` ("every N periods") stays UTC-only for
 *   now — the stepping calculator's period grid is UTC calendar arithmetic; a
 *   zone-aware period model (with its DST-inverse hazards) is deferred to #623, so
 *   the write boundary REFUSES `interval > 1` with a non-UTC zone rather than
 *   shipping subtly-wrong DST stepping. (2) **run windows stay UTC** — the
 *   `timeZone` governs ONLY cron interpretation; `isWithinRunWindows` still gates in
 *   UTC, so a NY-zoned recurrence gated by a UTC run window is coherent but
 *   two-zoned (documented at the `schedule-tick.ts` gate).
 */

export const RecurrenceFrequencySchema = z.enum(['minute', 'hour', 'day', 'week', 'month']);
export type RecurrenceFrequency = z.infer<typeof RecurrenceFrequencySchema>;

/**
 * #5 S5b-timeZone (#552) — is `tz` an IANA zone the runtime can resolve? True iff
 * `Intl.DateTimeFormat` accepts it. This is the SAME ICU timezone database croner
 * consumes (verified empirically, croner 10.0.1), so a zone that passes here is one
 * croner can interpret — the write-boundary guard that keeps an unresolvable zone
 * out of the firing chain, where croner throws a raw `TypeError` at `nextRun` (NOT
 * at construct) that would otherwise roll back inside the alarm clock's transaction
 * and re-deliver the row forever (see `nextOccurrence`). `''` and any non-IANA
 * string are rejected (`Intl.DateTimeFormat` throws `RangeError`). Stdlib-only, so
 * it lives here in `shared` (which imports no croner). `'UTC'` is valid.
 */
export function isValidTimeZone(tz: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The largest `interval` a recurrence may author (#550). "Every N periods" is
 * computed by the server stepping calculator, which probes forward for the next
 * qualifying period; an unbounded interval would let a schedule whose qualifying
 * periods never contain a valid occurrence (e.g. the 31st every 1000 months) probe
 * arbitrarily far. A generous cap (≈83 years of monthly periods) covers every real
 * cadence while keeping the calculator's lookahead bounded. Write-boundary only —
 * the lenient read shape stays uncapped (see `RecurrenceSchema`).
 */
export const MAX_RECURRENCE_INTERVAL = 1000;

/**
 * The ADF "advanced schedule" sub-object: which minutes/hours/week-days/
 * month-days a recurrence fires at. Every field is optional; which fields a given
 * `frequency` HONOURS (and requires) is a WRITE-boundary rule
 * (`RecurrenceWriteSchema`), not enforced on the stored shape.
 *
 * Ranges: `minutes` 0–59, `hours` 0–23, `weekDays` 0–6 (0 = Sunday, matching
 * `RunWindowSchema.days` and cron's day-of-week), `monthDays` 1–31.
 */
export const RecurrenceScheduleSchema = z.object({
  minutes: z.array(z.number().int().min(0).max(59)).nonempty().optional(),
  hours: z.array(z.number().int().min(0).max(23)).nonempty().optional(),
  weekDays: z.array(z.number().int().min(0).max(6)).nonempty().optional(),
  monthDays: z.array(z.number().int().min(1).max(31)).nonempty().optional(),
});
export type RecurrenceSchedule = z.infer<typeof RecurrenceScheduleSchema>;

/**
 * STORED/READ shape — deliberately LENIENT (no cross-field / interval refinement)
 * so it parses ANY historically-valid row, matching `TriggerParamsSchema` /
 * `ConcurrencySchema`. `interval` defaults to 1 for an authoring input that omits
 * it (the honest "every period" default; it is always then persisted, so the
 * default never fabricates an absent stored fact — contrast #473's fail-open
 * `.default([])`). Cross-field rules live on `RecurrenceWriteSchema`.
 */
export const RecurrenceSchema = z.object({
  frequency: RecurrenceFrequencySchema,
  interval: z.number().int().positive().default(1),
  schedule: RecurrenceScheduleSchema.optional(),
  /**
   * #5 S5b-2 (#549) — the recurrence's firing window `[startTime, endTime)` (both
   * optional/open-ended). UTC-with-`Z` only (`z.string().datetime()` refuses
   * offsets + naive strings), matching the run-window UTC contract. Enforced at
   * FIRE time by the firing chain (croner `startAt`/`stopAt` via
   * `nextOccurrence`), never by the compiled cron (bounds are not cron-expressible).
   * `startTime` is INCLUSIVE, `endTime` EXCLUSIVE — a standard half-open interval
   * (see `nextOccurrence`'s contract for the croner-boundary compensation).
   * Format-validated on the lenient READ shape too (like the 0–59 range checks
   * above); the cross-field `endTime > startTime` rule is a WRITE concern below.
   */
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  /**
   * #5 S5b-timeZone (#552) — the IANA zone the cron pattern is INTERPRETED in
   * (e.g. `'America/New_York'` fires a daily `09:00` at 09:00 NY wall-clock, which
   * is 14:00Z in winter / 13:00Z in summer — croner handles the DST shift). Absent
   * ⇒ UTC (the run-window contract), so a timeZone-free recurrence is byte-identical
   * to a pre-#552 one. The `startTime`/`endTime` bounds are absolute instants
   * (UTC-`Z`), so they are unaffected by this zone — the zone governs only WHICH
   * wall-clock instants the pattern picks, not the window it is clipped to. Only a
   * FORMAT-free string on the lenient READ shape (an old/imported row never throws);
   * the "must be a resolvable IANA zone" + "interval > 1 stays UTC-only" rules are
   * WRITE concerns below.
   */
  timeZone: z.string().optional(),
});
export type Recurrence = z.infer<typeof RecurrenceSchema>;

/** Which `schedule` sub-fields each frequency HONOURS. A field outside this set is
 * meaningless for that frequency (e.g. `weekDays` on a daily recurrence) and is
 * REFUSED at write time rather than silently dropped. `minute` honours none — a
 * per-minute recurrence fires every minute. */
const HONOURED_FIELDS: Record<RecurrenceFrequency, ReadonlyArray<keyof RecurrenceSchedule>> = {
  minute: [],
  hour: ['minutes'],
  day: ['minutes', 'hours'],
  week: ['minutes', 'hours', 'weekDays'],
  month: ['minutes', 'hours', 'monthDays'],
};

/** Fields a frequency REQUIRES: without them the recurrence is not a well-defined
 * cron pattern. `week` needs `weekDays` (a "week" with no day would compile to a
 * daily `* * *`); `month` needs `monthDays` (same, monthly). */
const REQUIRED_FIELDS: Partial<Record<RecurrenceFrequency, keyof RecurrenceSchedule>> = {
  week: 'weekDays',
  month: 'monthDays',
};

const ALL_SCHEDULE_FIELDS: ReadonlyArray<keyof RecurrenceSchedule> = [
  'minutes',
  'hours',
  'weekDays',
  'monthDays',
];

/**
 * WRITE-boundary shape — the stored shape PLUS the rules that keep a recurrence
 * faithfully cron-compilable. A FIELD-level `ZodEffects` (like
 * `TriggerParamsWriteSchema` / `ConcurrencyWriteSchema`) so `NewTriggerSchema`
 * stays a `ZodObject` and `.omit()`/`.partial()` on the trigger routes keep
 * working (a TOP-level `.superRefine` on `NewTriggerSchema` would break them).
 * Shared so a client pre-validates identically to the server.
 */
export const RecurrenceWriteSchema = RecurrenceSchema.superRefine((r, ctx) => {
  // #550 — "every N periods" stepping. `interval > 1` is NOT faithfully
  // cron-expressible (day/week stepping has no cron form; minute/hour/month
  // cron-step syntax is period-GRID-anchored, not `startTime`-anchored as the
  // recurrence semantics require), so the server computes it with a stepping
  // calculator (`nextOccurrence`'s `step`). Two write-boundary rules keep it
  // well-defined:
  //   1. It must be `startTime`-ANCHORED — "every 2 weeks" is meaningless without
  //      knowing which period is period 0. So `interval > 1` REQUIRES `startTime`.
  //   2. It is capped at `MAX_RECURRENCE_INTERVAL` — an unbounded interval would
  //      let the calculator probe unboundedly far for the next qualifying period.
  if (r.interval > MAX_RECURRENCE_INTERVAL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['interval'],
      message: `interval must be at most ${MAX_RECURRENCE_INTERVAL} — a larger "every N periods" is not supported (#550)`,
    });
  }
  if (r.interval > 1 && r.startTime === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['startTime'],
      message:
        'interval > 1 ("every N periods") requires a startTime anchor — it defines which ' +
        'period is period 0 (#550). Set startTime, or use interval: 1.',
    });
  }

  // #552 — a `timeZone` must be an IANA zone the runtime (and thus croner) can
  // resolve; an unresolvable zone would otherwise throw deep in the firing chain.
  if (r.timeZone !== undefined && !isValidTimeZone(r.timeZone)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['timeZone'],
      message: `timeZone must be a valid IANA zone (e.g. 'America/New_York', 'UTC') — '${r.timeZone}' is not resolvable`,
    });
  }
  // #552 — "every N periods" (interval > 1) stays UTC-only for now. The stepping
  // calculator's period grid is UTC calendar arithmetic; a zone-aware period model
  // (local-calendar day/week/month boundaries + the DST-inverse local-midnight→
  // instant conversion) is a genuine expansion deferred to #623. Refuse a non-UTC
  // zone here rather than ship subtly-wrong DST stepping (interval === 1 gets full
  // non-UTC support — croner handles it natively). Absent or 'UTC' ⇒ permitted.
  if (r.interval > 1 && r.timeZone !== undefined && r.timeZone !== 'UTC') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['timeZone'],
      message:
        'interval > 1 ("every N periods") is UTC-only for now — a non-UTC timeZone with ' +
        'stepping is deferred to #623. Use interval: 1 with this timeZone, or omit the timeZone.',
    });
  }

  const honoured = HONOURED_FIELDS[r.frequency];
  for (const field of ALL_SCHEDULE_FIELDS) {
    if (r.schedule?.[field] !== undefined && !honoured.includes(field)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schedule', field],
        message: `\`${field}\` is not meaningful for a '${r.frequency}' recurrence (honoured: ${
          honoured.length ? honoured.join(', ') : 'none'
        })`,
      });
    }
  }

  const required = REQUIRED_FIELDS[r.frequency];
  if (required && r.schedule?.[required] === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['schedule', required],
      message: `a '${r.frequency}' recurrence requires \`${required}\` — it selects which ${
        r.frequency === 'week' ? 'day(s) of the week' : 'day(s) of the month'
      } to fire on`,
    });
  }

  // #5 S5b-2 (#549) — the window must be non-empty. Half-open `[start, end)`, so
  // `end <= start` is empty (nothing ever fires); refuse it at write rather than
  // silently persisting a schedule that can never fire. A lone bound is fine (the
  // other side stays open). Both fields are already format-validated by
  // `z.string().datetime()`, so `Date.parse` is total here.
  if (r.startTime !== undefined && r.endTime !== undefined) {
    if (Date.parse(r.endTime) <= Date.parse(r.startTime)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endTime'],
        message: 'endTime must be after startTime — the recurrence window is empty otherwise',
      });
    }
  }
});

/** A cron field: sorted, de-duplicated, comma-joined — or a fallback when the
 * `schedule` omits it. Sorting makes the compiled string CANONICAL so two equal
 * recurrences derive the same cron (no needless churn of the freshness compare). */
function cronField(values: readonly number[] | undefined, fallback: string): string {
  if (values === undefined || values.length === 0) return fallback;
  return [...new Set(values)].sort((a, b) => a - b).join(',');
}

/**
 * Compile a recurrence to a 5-field cron string (`min hour dom month dow`), UTC.
 * TOTAL over every write-valid recurrence (proven by a test); a caller holding a
 * write-validated recurrence never needs to catch. Pure string-building — imports
 * NO croner (croner is a server-only dep; the server's `nextOccurrence` is the
 * one place a cron string meets croner).
 */
export function recurrenceToCron(recurrence: Recurrence): string {
  const s = recurrence.schedule;
  // A per-minute recurrence fires every minute; otherwise minutes default to :00.
  const min = recurrence.frequency === 'minute' ? '*' : cronField(s?.minutes, '0');
  // Minute/hour frequencies span every hour; day+ default to hour 0 (midnight).
  const hour =
    recurrence.frequency === 'minute' || recurrence.frequency === 'hour'
      ? '*'
      : cronField(s?.hours, '0');
  const dom = cronField(s?.monthDays, '*');
  const dow = cronField(s?.weekDays, '*');
  return `${min} ${hour} ${dom} * ${dow}`;
}
