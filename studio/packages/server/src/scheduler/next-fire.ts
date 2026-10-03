import type { Trigger, TriggerNextFire } from '@autonomy-studio/shared';
import { listParsedDueWakeups } from '../repo/scheduled-wakeups.js';
import type { Db } from '../repo/types.js';
import { isRefFresh, isSchedulable, SCHEDULE_TICK_KIND, ScheduleTickRefSchema } from './schedule-tick.js';
import { isTumblable, isWindowRefFresh, WINDOW_DUE_KIND, WindowDueRefSchema } from './tumbling.js';

/**
 * #1476 — each trigger's next due time, read from the alarm the scheduler has
 * actually ARMED rather than recomputed from the trigger's config, so the
 * editor shows what the scheduler will do, not what a second copy of the
 * recurrence maths thinks it should.
 *
 * An armed row counts only if the fire path would act on it: the same
 * eligibility, binding and freshness predicates the `schedule_tick` and
 * `window_due` handlers apply before firing (`schedule-tick.ts`, `tumbling.ts`).
 * `sync()` already drops rows those predicates refuse on every trigger write,
 * so this is a safety net for the window between a write and its sync, not a
 * second policy.
 *
 * `window_retry` is left out on purpose: it re-runs a window that has already
 * closed, and the column's `window` time is labelled as the next window's
 * close, which a retry is not.
 *
 * Read through the clock's own LENIENT scan with an unbounded `now` — one
 * corrupt alarm row is skipped, never allowed to fail the whole read.
 */
export function listTriggerNextFires(db: Db, triggers: readonly Trigger[]): TriggerNextFire[] {
  const byId = new Map(triggers.map((t) => [t.id, t]));
  const rows = listParsedDueWakeups(db, {
    kinds: [SCHEDULE_TICK_KIND, WINDOW_DUE_KIND],
    now: Number.MAX_SAFE_INTEGER,
  });
  const out = new Map<string, TriggerNextFire>();
  // Oldest first, so the first row kept per trigger is its earliest.
  for (const row of rows) {
    if (row.status !== 'found') continue;
    const { wakeup } = row;
    if (wakeup.kind === SCHEDULE_TICK_KIND) {
      const ref = ScheduleTickRefSchema.safeParse(wakeup.ref);
      if (!ref.success) continue;
      const t = byId.get(ref.data.triggerId);
      if (t === undefined || out.has(t.id)) continue;
      if (!isSchedulable(t) || t.pipelineVersionId === null || !isRefFresh(t, ref.data)) continue;
      out.set(t.id, { triggerId: t.id, at: wakeup.dueAt, source: 'schedule' });
    } else {
      const ref = WindowDueRefSchema.safeParse(wakeup.ref);
      if (!ref.success) continue;
      const t = byId.get(ref.data.triggerId);
      if (t === undefined || out.has(t.id)) continue;
      if (!isTumblable(t) || t.pipelineVersionId === null || !isWindowRefFresh(t, ref.data)) {
        continue;
      }
      out.set(t.id, { triggerId: t.id, at: wakeup.dueAt, source: 'window' });
    }
  }
  return [...out.values()];
}
