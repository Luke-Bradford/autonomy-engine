import type { ScheduledWakeup } from '@autonomy-studio/shared';
import { listPendingWakeups } from '../../repo/scheduled-wakeups.js';
import type { Db } from '../../repo/types.js';
import { SCHEDULE_TICK_KIND } from '../schedule-tick.js';

/**
 * The pending `schedule_tick` rows — optionally only one trigger's. ONE copy for
 * the suite: `schedule-tick`, `scheduler` and `routes/triggers` each carried
 * their own, and #1388's app-level test would have been the fourth.
 */
export function pendingTicks(db: Db, triggerId?: string): ScheduledWakeup[] {
  return listPendingWakeups(db).filter(
    (w) =>
      w.kind === SCHEDULE_TICK_KIND &&
      (triggerId === undefined || (w.ref as { triggerId?: string }).triggerId === triggerId),
  );
}
