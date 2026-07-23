import { z } from 'zod';
import {
  isWithinRunWindows,
  SubstituteError,
  type ScheduledWakeup,
  type Trigger,
} from '@autonomy-studio/shared';
import { getParsedTrigger } from '../repo/triggers.js';
import { armWakeup } from '../repo/scheduled-wakeups.js';
import type { Db } from '../repo/types.js';
import {
  ArchivedPipelineError,
  UnboundTriggerError,
  type FireContext,
  type FireResult,
} from '../run/launcher.js';
import type { WakeupFireResult, WakeupHandler } from './alarms.js';
import {
  InvalidScheduleError,
  nextOccurrence,
  type OccurrenceBounds,
  type OccurrenceStep,
} from './recurrence.js';
// The log seam is byte-identical to the cron reconciler's and lives beside it —
// imported (type-only, erased at runtime) rather than re-declared, exactly as
// `alarms.ts` imports it, and so it does NOT form a runtime cycle with the value
// imports `scheduler.ts` takes from THIS module (`isSchedulable`/the kind/ref).
import type { SchedulerLog } from './scheduler.js';

/**
 * #5 S5 — the `schedule_tick` alarm handler: the consumer that moves schedule
 * triggers off the old in-memory `Cron` (a firing source a restart silently
 * lost) and onto the durable S1 outbox. It is `alarms.ts`'s worked example #2,
 * after retry.
 *
 * The chain, per trigger: `scheduler.ts` SEEDS the first occurrence as a durable
 * `scheduled_wakeups` row; the alarm clock delivers it at `dueAt`; THIS handler,
 * inside the clock's transaction, arms the NEXT occurrence (croner as a
 * calculator, `recurrence.ts`) and — post-commit — fires the run through the
 * launcher. One pending row per trigger at any time, so:
 *
 *   - **≤1 late fire / no backfill** is STRUCTURAL: during downtime exactly one
 *     row goes overdue; boot fires it once and `nextOccurrence(firedAt)` returns
 *     the next FUTURE slot, skipping the missed backlog. No per-kind catch-up
 *     policy field is needed here (that is #463's concern for tumbling backfill,
 *     S10, where multiple overdue rows genuinely need fire/coalesce/skip).
 *
 * ## Why the launcher fire is `afterCommit`, never in-tx
 *
 * `launcher.fire()` writes the `runs` row, appends `run.started` and publishes to
 * the bus before it suspends (`run/launcher.ts`). Inside the clock's transaction
 * a rollback would erase a run a detached drive kept appending to, after live WS
 * subscribers saw its `run.started`. The alarm-clock contract (`alarms.ts`
 * header) mandates `afterCommit` for exactly this; spec #5 names S5 as a case.
 *
 * ## Why re-arm is IN-tx (atomic with the settle), not in `afterCommit`
 *
 * The next occurrence is armed together with settling this row, so a crash
 * between commit and the launcher fire still leaves the schedule durably armed —
 * the whole point of leaving in-memory crons. `armWakeup`'s own transaction nests
 * as a SAVEPOINT (spec #5's spike block proved this against the real append path).
 *
 * ## Freshness (spec #5: "every due event re-checks currency before it fires")
 *
 * The row captures only the trigger id + the schedule it was armed for; the
 * handler RE-READS the trigger and suppresses against its CURRENT state:
 *   - not schedulable (deleted / disabled / mode changed / schedule cleared) →
 *     terminal, do NOT re-arm.
 *   - unbound (`pipelineVersionId === null`) → terminal, do NOT re-arm (belt to
 *     the launcher's own `UnboundTriggerError`).
 *   - schedule OR bounds edited since arm (`!isRefFresh` — the compiled cron or
 *     the recurrence's start/end window changed) → terminal for THIS chain
 *     (reason `ref_stale`); `scheduler.sync()` seeds the new spec's chain.
 *   - invalid cron the schema let through → terminal, do NOT re-arm and do NOT
 *     throw (a throw rolls back in-tx and re-delivers this row every tick forever).
 *   - outside a run window → skip THIS occurrence but re-arm the next (the
 *     schedule stays alive across a closed window).
 * A suppression settles the row (its persisted `status` + `firedAt` is the
 * durable trace — lateness is derivable against the row's `dueAt`); no
 * `trigger.fireSuppressed` domain event is emitted in v1 —
 * there is no trigger-scoped event log yet (deferred to S6/observability; see the
 * S5a amendment in the spec).
 */

export const SCHEDULE_TICK_KIND = 'schedule_tick';

/**
 * S1's "typed `ref` per kind", validated at ARM time. `schedule` is carried (a
 * superset of the spec's "cron ref = the trigger") so a schedule EDIT is
 * detectable at fire time without a second read — the `isRefFresh` check — and so
 * the reconciler can tell a stale-schedule row from a current one. The
 * `tick-<dueEpoch>` discriminator (not in the ref) is what makes successive
 * occurrences distinct rows and keeps arming idempotent.
 *
 * #5 S5b-2 (#549): the recurrence bounds `startTime`/`endTime` ride here too — a
 * bounds-only edit leaves the compiled cron (`schedule`) IDENTICAL, so it is
 * invisible to a schedule-string compare; carrying the bounds makes such an edit
 * detectable by the same freshness path. OPTIONAL so a row armed before S5b-2 (no
 * bounds keys) still `safeParse`s — absent = unbounded = today's behaviour — and
 * a bounds-free trigger's ref is byte-identical to the pre-S5b-2 shape.
 * All ref values are strings (`WakeupRefSchema` = record of strings), so the
 * bounds are the same UTC-`Z` ISO strings the recurrence stores, not epochs.
 */
export const ScheduleTickRefSchema = z.object({
  triggerId: z.string().min(1),
  schedule: z.string().min(1),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  /**
   * #5 S5b (#550) — the recurrence `interval` when > 1, as a decimal string
   * (`WakeupRefSchema` is a record of strings). Carried because an interval edit
   * leaves the compiled cron (`schedule`) IDENTICAL — `recurrenceToCron` ignores
   * interval (it is a firing-time GATE, not part of the pattern) — so a bare
   * schedule + bounds compare would miss it and keep firing on the old cadence.
   * OMITTED for `interval === 1` (the common case), so a row armed before #550 is
   * byte-identical to today's ref and stays fresh on deploy — the same
   * optional-for-back-compat discipline the S5b-2 bounds keys use. `frequency` is
   * NOT carried: it always changes the compiled cron, so a frequency edit is
   * already caught by the `schedule` compare.
   */
  interval: z.string().regex(/^\d+$/).optional(),
  /**
   * #5 S5b-timeZone (#552) — the recurrence `timeZone` when non-UTC. Carried because
   * a timeZone edit leaves the compiled cron (`schedule`) IDENTICAL — the zone is a
   * croner interpretation option, not part of the pattern — so a bare schedule +
   * bounds + interval compare would miss it and keep firing in the old zone. OMITTED
   * for absent/UTC (unzoned ⇒ UTC), so a row armed before #552, or for a UTC/unzoned
   * recurrence, is byte-identical to today's ref and stays fresh on deploy — the same
   * carry-only-when-it-changes-firing discipline the `interval` key uses.
   */
  timeZone: z.string().min(1).optional(),
});
export type ScheduleTickRef = z.infer<typeof ScheduleTickRefSchema>;

/**
 * Build the canonical `schedule_tick` ref from a trigger's CURRENT state — the
 * SINGLE constructor both the reconciler (seed) and this handler (re-arm) use, so
 * the two can never disagree about a row's identity. Bounds come from the
 * `recurrence` (a raw-cron escape-hatch trigger has no `recurrence` → unbounded,
 * exactly today's behaviour). Absent bounds are OMITTED (never set to `undefined`):
 * `WakeupRefSchema` is a record of strings and `serializeRef` keys off
 * `Object.keys`, so an `undefined`-valued key would both fail validation and
 * corrupt the dedupe key — and omission is what keeps a bounds-free ref
 * byte-identical to a pre-S5b-2 row (so old pending rows stay fresh on deploy).
 *
 * Precondition: `trigger` is schedulable (`isSchedulable` ⇒ `schedule` non-null);
 * both call sites guarantee it. Enforced by a real guard (not a cast) so a future
 * caller that violates it fails LOUDLY here rather than arming a `null`-schedule
 * row that later blows up in croner.
 */
export function buildScheduleTickRef(trigger: Trigger): ScheduleTickRef {
  const { schedule } = trigger;
  if (schedule === null) {
    throw new Error(
      `buildScheduleTickRef: trigger ${trigger.id} has no schedule — call only for isSchedulable triggers`,
    );
  }
  const ref: ScheduleTickRef = { triggerId: trigger.id, schedule };
  const r = trigger.recurrence;
  if (r?.startTime !== undefined) ref.startTime = r.startTime;
  if (r?.endTime !== undefined) ref.endTime = r.endTime;
  // #550 — carry `interval` ONLY when it changes firing (> 1); interval 1 omits it
  // to stay byte-identical to a pre-#550 ref (so old pending rows stay fresh).
  if (r !== null && r.interval > 1) ref.interval = String(r.interval);
  // #552 — carry `timeZone` ONLY when it changes firing (non-UTC); absent/UTC omits
  // it (unzoned ⇒ UTC) to stay byte-identical to a pre-#552 ref.
  if (r?.timeZone !== undefined && r.timeZone !== 'UTC') ref.timeZone = r.timeZone;
  return ref;
}

/**
 * Is a stored ref still current for `trigger`? True iff the ref the trigger would
 * produce NOW equals the armed one — so a schedule-string edit OR a bounds-only
 * edit both read as stale. The single freshness predicate the reconciler and the
 * fire path share (they must agree, or one would fire a row the other would drop).
 * Precondition as `buildScheduleTickRef`.
 */
export function isRefFresh(trigger: Trigger, ref: ScheduleTickRef): boolean {
  const current = buildScheduleTickRef(trigger);
  return (
    current.schedule === ref.schedule &&
    current.startTime === ref.startTime &&
    current.endTime === ref.endTime &&
    current.interval === ref.interval &&
    current.timeZone === ref.timeZone
  );
}

/**
 * The trigger's firing-window bounds as epoch ms, for `nextOccurrence`. Derived
 * from `recurrence` (raw-cron triggers have none → unbounded). The datetimes are
 * `z.string().datetime()`-validated on the recurrence schema, so `Date.parse` is
 * total here. Shared with the reconciler so seed + re-arm bound occurrences
 * identically.
 */
export function scheduleBounds(trigger: Trigger): OccurrenceBounds {
  const r = trigger.recurrence;
  const bounds: OccurrenceBounds = {};
  if (r?.startTime !== undefined) bounds.startAt = Date.parse(r.startTime);
  if (r?.endTime !== undefined) bounds.stopAt = Date.parse(r.endTime);
  return bounds;
}

/**
 * #5 S5b (#550) — the "every N periods" stepping descriptor for `nextOccurrence`,
 * or `undefined` when the recurrence fires every period (`interval <= 1`, or a
 * raw-cron trigger with no recurrence — the pre-#550 base case). The anchor is the
 * recurrence's `startTime` (the write schema REQUIRES it for `interval > 1`, so a
 * write-valid recurrence always resolves a finite anchor); a corrupt/imported row
 * lacking it yields `NaN`, which `nextOccurrence` fails closed on. Shared with the
 * reconciler so seed + re-arm step identically. `Date.parse` is total on the
 * `z.string().datetime()`-validated `startTime`.
 */
export function recurrenceStep(trigger: Trigger): OccurrenceStep | undefined {
  const r = trigger.recurrence;
  if (r === null || r.interval <= 1) return undefined;
  return {
    frequency: r.frequency,
    interval: r.interval,
    anchorEpochMs: r.startTime !== undefined ? Date.parse(r.startTime) : Number.NaN,
  };
}

/**
 * #5 S5b-timeZone (#552) — the IANA zone `nextOccurrence` interprets the cron in,
 * or `'UTC'` when the recurrence names none (unzoned ⇒ UTC, the run-window contract
 * — and a raw-cron trigger with no recurrence). Shared with the reconciler so seed +
 * re-arm interpret the schedule in the SAME zone. A stored non-UTC zone that fails
 * to resolve at fire time is caught by `nextOccurrence`'s `InvalidScheduleError` guard
 * (settle, no re-arm), never a raw croner throw.
 */
export function recurrenceTimeZone(trigger: Trigger): string {
  return trigger.recurrence?.timeZone ?? 'UTC';
}

/** A schedulable trigger — one `isSchedulable` has proven carries a non-null
 * `schedule`. Narrowing to this (rather than casting `schedule as string` at each
 * use) lets the reconciler + handler read `trigger.schedule` as a plain string. */
export type SchedulableTrigger = Trigger & { schedule: string };

/** A trigger is eligible for scheduling iff enabled, in `schedule` mode, and it
 * carries a (syntactically present) cron expression. Binding is deliberately NOT
 * checked here — eligibility is about scheduling; FIRING re-checks binding. The
 * single owner of this predicate (used by the reconciler and this handler). A TYPE
 * GUARD, so a caller that passes the check reads `trigger.schedule` as `string`
 * without a cast. */
export function isSchedulable(t: Trigger): t is SchedulableTrigger {
  return t.enabled && t.mode === 'schedule' && t.schedule !== null;
}

/** The run-spawning seam the handler reaches only via `afterCommit`. A lazy
 * closure over the app's `runLauncher` (the launcher is constructed after the
 * clock; the closure resolves it at fire time). Only `fire` is used; the return
 * is `FireResult` (not `unknown`) so a mis-shaped injected launcher is a
 * compile-time error — the shape guarantee the old `Pick<RunLauncher,'fire'>`
 * gave, kept without importing the whole launcher interface. */
export interface ScheduleTickLauncher {
  fire(trigger: Trigger, fireContext?: FireContext): FireResult;
}

export interface ScheduleTickDeps {
  launcher: ScheduleTickLauncher;
  log: SchedulerLog;
}

export function createScheduleTickHandler(deps: ScheduleTickDeps): WakeupHandler {
  const { launcher, log } = deps;
  return {
    kind: SCHEDULE_TICK_KIND,
    refSchema: ScheduleTickRefSchema,
    fire(row: ScheduledWakeup, delivery, tx: Db): WakeupFireResult {
      const ref = ScheduleTickRefSchema.parse(row.ref);
      const read = getParsedTrigger(tx, ref.triggerId);

      // #637 — a CORRUPT trigger row must settle the chain, not throw: a throw
      // rolls back the fire tx, so the pending row would re-fire + error-log on
      // every tick, forever. Settle + warn; `sync()` re-seeds if the row is
      // later repaired (the `invalid_schedule` discipline).
      if (read.status === 'unparseable') {
        log.warn(
          { triggerId: ref.triggerId, err: read.error },
          'schedule tick: trigger row unparseable — settling the chain (sync() re-seeds after repair)',
        );
        return { status: 'suppressed', reason: 'trigger_unparseable' };
      }
      const trigger = read.status === 'found' ? read.trigger : null;

      // Terminal suppressions — the schedule this row served no longer exists;
      // settle and stop the chain. `scheduler.sync()` re-seeds if a NEW chain is
      // warranted (e.g. after an edit), so re-arming here would double it.
      if (trigger === null || !isSchedulable(trigger)) {
        return { status: 'suppressed', reason: 'trigger_not_schedulable' };
      }
      if (trigger.pipelineVersionId === null) {
        return { status: 'suppressed', reason: 'trigger_unbound' };
      }
      // Freshness gates FIRING, not just re-arm: a stale row (schedule string OR
      // recurrence bounds edited since arm) must NOT fire — e.g. a moved `endTime`
      // could otherwise fire a row past the new window before `sync()` drops it.
      if (!isRefFresh(trigger, ref)) {
        return { status: 'suppressed', reason: 'ref_stale' };
      }

      // `isSchedulable` (checked above) is a type guard, so `trigger.schedule` is
      // narrowed to `string` here — no cast. Compute the next occurrence (within
      // the recurrence's bounds) up front so an invalid cron is caught before
      // anything durable.
      const schedule = trigger.schedule;
      const bounds = scheduleBounds(trigger);
      const step = recurrenceStep(trigger);
      const timeZone = recurrenceTimeZone(trigger);
      let next: number | null;
      try {
        next = nextOccurrence(schedule, delivery.firedAt, bounds, step, timeZone);
      } catch (err) {
        if (err instanceof InvalidScheduleError) {
          // Settle + stop. Never re-arm (there is no valid next time) and never
          // re-throw — a throw here rolls back inside the clock's transaction, so
          // the row stays pending and re-delivers forever.
          return { status: 'suppressed', reason: 'invalid_schedule' };
        }
        throw err;
      }

      // Continue the chain BEFORE the fire-vs-window decision: an out-of-window
      // occurrence still advances the schedule. Armed in-tx (atomic with the
      // settle); `armWakeup` nests as a SAVEPOINT. A finite schedule with no
      // further occurrence (`next === null`) simply ends the chain.
      if (next !== null) {
        armWakeup(tx, {
          kind: SCHEDULE_TICK_KIND,
          ref: buildScheduleTickRef(trigger),
          dueAt: next,
          discriminator: `tick-${next}`,
        });
      }

      // Automatic-fire gate: a run window blocks a NEW start (a manual "run now"
      // is an explicit override, exempt — only automatic firing is gated). Skip
      // this occurrence; the next is already armed above.
      //
      // #552 TWO-ZONE SEAM: `isWithinRunWindows` evaluates the FIRE INSTANT in UTC
      // (its documented contract), whereas a recurrence's `timeZone` interprets the
      // cron in a non-UTC zone. So a `America/New_York` recurrence gated by a UTC
      // run window is coherent but two-zoned — the window matches the UTC instant,
      // not the NY wall-clock. This is deliberate (run windows stay UTC for all
      // trigger modes, not just recurrence); a zoned run window is a separate future
      // expansion, not this ticket. The seam is documented on `RecurrenceSchema`.
      if (!isWithinRunWindows(trigger.runWindows, new Date(delivery.firedAt))) {
        return { status: 'suppressed', reason: 'outside_run_window' };
      }

      // FIRE — post-commit only (see the header). The trigger snapshot is passed
      // to the launcher exactly as the old scheduler did; a rebind between here
      // and the fire is the same race the launcher's `UnboundTriggerError`
      // backstops. A lost occurrence is logged, never fatal — the chain is armed.
      return {
        status: 'fired',
        afterCommit: () => {
          try {
            // #5 S12 — seed `${trigger.scheduledTime}` with the INTENDED
            // occurrence (`delivery.scheduledFor` = the row's `dueAt`), NOT the
            // possibly-late actual `firedAt`, so a schedule expression reads the
            // slot it was armed for and is identical on a boot-recovered late fire.
            launcher.fire(trigger, {
              scheduledTime: new Date(delivery.scheduledFor).toISOString(),
            });
          } catch (err) {
            if (err instanceof UnboundTriggerError) {
              log.debug({ triggerId: trigger.id }, 'schedule tick: skip — trigger became unbound');
              return;
            }
            // #3 G5a — the bound pipeline is archived. Unlike the unbound race
            // above (a transient rebind that `sync()` self-heals), an enabled
            // schedule trigger bound to a PERMANENTLY-archived pipeline (the
            // re-enable edge case: archive disables dependent triggers, but a
            // user can re-enable one) re-arms and re-hits this every occurrence
            // with no run to look at — so it needs an operator-visible signal,
            // matching the `SubstituteError` severity below (persistent
            // misconfiguration, not a self-healing race). The chain is already
            // armed, so this only drops the one occurrence.
            if (err instanceof ArchivedPipelineError) {
              log.warn({ triggerId: trigger.id }, 'schedule tick: skip — pipeline archived');
              return;
            }
            // #5 S12b — a trigger param binding that cannot resolve for THIS
            // occurrence (e.g. a `${trigger.body.x}` deep-address on a schedule
            // fire's null body — save-valid, since `body` is a known field, but
            // fed no payload until S8; or a PRE-GATE row whose literal param now
            // parses as an expression). Skip-and-log rather than rethrow: a
            // misconfigured binding must not wedge the clock. The chain is
            // already armed (above), so this only drops the one occurrence.
            //
            // `warn`, not `debug` (unlike the unbound skip above — a benign
            // rebind race sync self-heals): a binding that never resolves means
            // the schedule stops firing with no run to look at, so it needs an
            // operator-visible signal. Matches the webhook path's severity for
            // this same defect class (`routes/webhooks.ts`).
            if (err instanceof SubstituteError) {
              log.warn(
                { triggerId: trigger.id, err },
                'schedule tick: skip — trigger param binding could not be resolved',
              );
              return;
            }
            throw err; // the clock's afterCommit guard logs it.
          }
        },
      };
    },
  };
}
