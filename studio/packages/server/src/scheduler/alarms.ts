import type { z } from 'zod';
import type { ArmWakeupInput, RunEvent, ScheduledWakeup, WakeupRef } from '@autonomy-studio/shared';
import { armWakeup, getWakeup, listDueWakeups, settleWakeup } from '../repo/scheduled-wakeups.js';
import type { Db } from '../repo/types.js';
import type { RunEventBus } from '../run/event-bus.js';
// The log seam this module needs is byte-identical to the cron scheduler's, and
// lives in the same directory — so it is imported rather than re-declared.
import type { SchedulerLog } from './scheduler.js';

/**
 * #5 S1 — the ALARM CLOCK: the driver-owned half of the durable-alarm outbox,
 * and the SSOT for "it is time, do the thing".
 *
 * One clock, one persistence, one boot re-arm — NOT a per-feature timer. Every
 * time-based firing in the system is meant to consume this: retry (#1 D4),
 * `wait` + `webhook` expiry (#4), schedule ticks + tumbling windows (#5 S5/S9),
 * lease-expiry reclaim (#5 S7). Each registers a HANDLER for its `kind`; the
 * clock owns the scan, the transaction, the settle, and the ordering rules that
 * every one of them would otherwise re-implement (and re-get-wrong).
 *
 * The reducer stays pure and clock-free: it emits "schedule an alarm" commands,
 * and wall-time lives here.
 *
 * WIRED INTO `buildApp` by its first consumer, #1 D4's node retry (F2c): that is
 * where the clock is constructed with its handler registry and its tick interval,
 * per the plan that this ticket (the build order's item 5) would ship the
 * primitive and the consumer that landed first would wire the lifecycle — rather
 * than an inert boot path with an empty registry. `scheduler/retry-alarm.ts` is
 * that consumer and the worked example for the next one.
 *
 * ## The contract handlers must respect
 *
 * A handler's `fire` runs INSIDE the clock's transaction and may therefore ONLY
 * touch the `db` handle it is passed. Anything that SPAWNS work goes in
 * `afterCommit`. This is not a style rule — the most obvious first consumer
 * (fire a run through the launcher) breaks without it: `launcher.fire()` returns
 * synchronously but its synchronous prefix already writes the `runs` row,
 * appends `run.started` and publishes to the bus before it suspends (see the
 * comment at `run/launcher.ts:210-218`). Inside this transaction, a rollback
 * would erase that run row while the detached async drive kept appending
 * against it, and live WS subscribers would have already seen a `run.started`
 * for a run that no longer exists.
 *
 * Handlers must also be safe to invoke TWICE for the same row. Exactly-once is
 * fiction; the contract is **at-least-once + a stale-delivery check**. The UNIQUE
 * (kind, dedupeKey) index dedupes ARMING; dedupe of DELIVERY is the consumer's
 * job, via staleness. The retry handler is the worked example: a re-delivered
 * `node_retry` alarm whose node has moved on (its retry already dispatched, or a
 * loop round reset it) is SUPPRESSED — it returns `{status:'suppressed'}` and
 * appends nothing at all, rather than appending an event it expects the reducer
 * to no-op. Suppression is the cheaper and more honest layer: an event that folds
 * to nothing is still a durable line claiming something happened.
 *
 * A handler MAY instead rely on an idempotent fold where its kind has no way to
 * check currency up front — but it must have one of the two. `node.retryDue` also
 * has the reducer's own `retry_pending` guard behind the suppression, and both are
 * load-bearing.
 */

/**
 * Late-alarm observability (spec #5): the clock supplies the numbers, each
 * handler decides what its own event records. `latenessMs` is how long past
 * `dueAt` the alarm actually fired — the honest measure of scheduler health,
 * and the only way downtime shows up in the log at all.
 */
export interface WakeupDelivery {
  /** The alarm's `dueAt` — when it was SUPPOSED to fire. */
  scheduledFor: number;
  /** When it actually fired. */
  firedAt: number;
  /** `firedAt - scheduledFor`; 0 or more. */
  latenessMs: number;
}

/**
 * What a handler did with a due alarm.
 *
 * `suppressed` is not an error — it is the freshness verdict (spec #5: "every
 * due event re-checks currency before it fires, so stale retries / expired
 * leases / disabled triggers can't emit valid-looking events"). It carries
 * `events` for the same reason `fired` does: suppression is a durable fact
 * ("this trigger was disabled when its tick came due"), and spec #5 forbids a
 * status-only mutation for a lifecycle transition. The handler decides whether
 * its kind has such an event; the clock just commits it atomically.
 */
export type WakeupFireResult =
  | {
      status: 'fired';
      /** Envelopes the handler appended; the clock publishes them after commit. */
      events?: RunEvent[];
      /**
       * Work to SPAWN once the fire is durable. See the contract above.
       *
       * `Promise<void>` is in the type ON PURPOSE. TypeScript's void-return
       * rule makes an `async () => {...}` assignable to a bare `() => void`, so
       * declaring it sync would not KEEP handlers sync — it would only stop the
       * clock from awaiting the promise, and the rejection of the async work
       * this seam exists to spawn would float away as an unhandled rejection.
       * Admitting the async case is what lets the clock settle it.
       */
      afterCommit?: () => void | Promise<void>;
    }
  | { status: 'suppressed'; reason: string; events?: RunEvent[] };

/**
 * One kind's registration. The registry — not the `kind` column, which is an
 * open string — is the runtime authority for which alarms are live.
 */
export interface WakeupHandler {
  /** The `kind` this serves; unique across a clock's handlers. */
  kind: string;
  /**
   * The shape of this kind's `ref` (spec #5's "typed `ref` per kind"), checked
   * when an alarm is ARMED so a malformed ref fails at the call site that wrote
   * it — not hours later, in a background tick, with nobody to tell.
   */
  refSchema: z.ZodType<WakeupRef>;
  /**
   * Handle one due alarm. Runs inside the clock's transaction: use `db` for
   * durable writes, return `afterCommit` for anything else. MUST be safe to
   * call twice for the same row. Throwing rolls the whole fire back and leaves
   * the alarm pending for the next tick.
   */
  fire(row: ScheduledWakeup, delivery: WakeupDelivery, db: Db): WakeupFireResult;
}

export interface AlarmClockDeps {
  db: Db;
  handlers: readonly WakeupHandler[];
  /** Clock seam (epoch ms); defaults to the wall clock, as `createScheduler`'s does. */
  now?: () => number;
  /** When present, events a handler appended are published AFTER commit. */
  bus?: RunEventBus;
  log?: SchedulerLog;
}

export interface AlarmClock {
  /**
   * Arm a durable alarm. Idempotent by `(kind, dedupeKey)` — re-arming on
   * replay returns the existing row rather than a second alarm. Throws if the
   * kind has no handler or the `ref` does not match its schema: both would
   * otherwise persist a row that can never fire.
   */
  arm(input: ArmWakeupInput): ScheduledWakeup;
  /** Fire every alarm now due. Never throws. */
  tick(): void;
  /**
   * Stop FIRING. Idempotent.
   *
   * Arming deliberately still works after this. A stopped clock is a shutting-down
   * one, and a run still settling during shutdown can fail transiently and arm a
   * retry like any other — refusing it would convert an ordinary transient failure
   * into a DEAD run (nothing else would ever re-dispatch that node). The row is
   * DURABLE and swept by the next boot's tick, so an arm accepted here is served,
   * just later. Refusing writes to protect a process that is going away anyway
   * loses work; accepting them costs nothing.
   */
  stop(): void;
}

export function createAlarmClock(deps: AlarmClockDeps): AlarmClock {
  const { db, bus, log } = deps;
  const now = deps.now ?? (() => Date.now());

  const handlers = new Map<string, WakeupHandler>();
  for (const handler of deps.handlers) {
    if (handlers.has(handler.kind)) {
      // Last-wins would silently disable one consumer's alarms — the kind of
      // fault that only shows up as "the retries stopped happening".
      throw new Error(`alarm clock: duplicate handler for kind '${handler.kind}'`);
    }
    handlers.set(handler.kind, handler);
  }

  let stopped = false;
  /** Re-entrancy guard: in-memory, not a persisted `claimed` status. The fire
   * is one synchronous transaction, so there is no suspension point to protect
   * across — only the degenerate case of a handler calling `tick()` itself. */
  let ticking = false;

  function arm(input: ArmWakeupInput): ScheduledWakeup {
    // Intentionally NOT gated on `stopped` — see `AlarmClock.stop`.
    const handler = handlers.get(input.kind);
    if (handler === undefined) {
      throw new Error(
        `alarm clock: cannot arm kind '${input.kind}' — no handler is registered for it, so the ` +
          `alarm could never fire`,
      );
    }
    handler.refSchema.parse(input.ref);
    return armWakeup(db, input);
  }

  /**
   * Fire ONE alarm. The transaction wraps the handler AND the settle, so the
   * two are inseparable: an append that committed without its settle would
   * re-fire and double-append; a settle that committed without its append would
   * lose the alarm silently. Returns the work to run once the fire is durable;
   * THROWS if it did not commit (there is no "failed quietly" return — a fire
   * either committed or it rolled back and the alarm is still pending).
   */
  function fireOne(
    row: ScheduledWakeup,
    handler: WakeupHandler,
    firedAt: number,
  ): { events: RunEvent[]; afterCommit?: () => void } {
    const delivery: WakeupDelivery = {
      scheduledFor: row.dueAt,
      firedAt,
      latenessMs: Math.max(0, firedAt - row.dueAt),
    };

    return db.transaction((tx) => {
      // The scan is a snapshot, so re-read inside the transaction before doing
      // any work: a row it returned may have been settled since (an earlier
      // alarm's handler cancelling a superseded sibling, say). Cheaper than
      // invoking the handler and rolling it back, and it keeps "a spent alarm's
      // handler is never called" true rather than merely harmless.
      const current = getWakeup(tx, row.id);
      if (current === null || current.status !== 'pending') throw new StaleWakeupError(row.id);

      const result = handler.fire(current, delivery, tx);
      const settled = settleWakeup(tx, row.id, { status: result.status, firedAt });
      if (settled === null) {
        // The handler settled its own row. The re-read above cannot catch this
        // one, so the settle's `WHERE status = 'pending'` remains the atomic
        // backstop: roll back — including whatever the handler just wrote —
        // rather than double-firing a spent alarm.
        throw new StaleWakeupError(row.id);
      }
      if (result.status === 'suppressed') {
        log?.debug(
          { wakeupId: row.id, kind: row.kind, reason: result.reason },
          'alarm clock: suppressed a stale alarm',
        );
        return { events: result.events ?? [] };
      }
      return { events: result.events ?? [], afterCommit: result.afterCommit };
    });
  }

  function tick(): void {
    if (stopped || ticking) return;
    ticking = true;
    try {
      // ONE structural try/catch around the whole scan — a DB read fault must
      // not crash a headless server's timer (the rule `scheduler.ts:96-131`
      // already sets for cron ticks).
      const at = now();
      const due = listDueWakeups(db, { kinds: [...handlers.keys()], now: at });

      for (const row of due) {
        const handler = handlers.get(row.kind);
        // Unreachable — the scan filters by registered kind — but a missing
        // handler must never throw past this loop.
        if (handler === undefined) continue;

        let committed: { events: RunEvent[]; afterCommit?: () => void };
        try {
          committed = fireOne(row, handler, at);
        } catch (err) {
          if (err instanceof StaleWakeupError) {
            log?.debug({ wakeupId: row.id }, 'alarm clock: skip — settled since the scan');
          } else {
            // The fire rolled back: the row is still pending, so the next tick
            // re-delivers it. That IS the at-least-once contract, so this is a
            // log, not a failure — and one bad alarm must not stop the others.
            log?.error(
              { err, wakeupId: row.id, kind: row.kind },
              'alarm clock: fire failed — alarm stays pending for the next tick',
            );
          }
          continue;
        }

        // POST-COMMIT ONLY, and never inside the transaction above.
        //
        // Publishing: `appendEngineEvent(db, ev, bus)` publishes immediately
        // after its append, so a handler passing the bus itself would emit an
        // event to live subscribers that a rollback then erases. The handler
        // hands the envelopes back instead and the clock publishes them here,
        // once they are durable.
        //
        // Spawning: see the `afterCommit` contract in this module's header.
        //
        // Both are guarded: the fire is already committed and MUST stay
        // committed, so a throw here can neither un-fire it nor re-deliver it
        // (that would double-append the handler's event). Log and move on.
        try {
          for (const event of committed.events) bus?.publish(event);
        } catch (err) {
          log?.error({ err, wakeupId: row.id }, 'alarm clock: publishing a fired alarm failed');
        }
        // `Promise.resolve(...)` normalises both cases: a sync throw is caught
        // by the try, an async rejection by the `.catch`. Without the latter, a
        // rejected `afterCommit` would escape as an unhandled rejection —
        // exactly the fault `scheduler.ts:100-103` documents for croner and
        // defends against twice. Deliberately NOT awaited: the fire is already
        // committed and spawned work must not hold up the remaining alarms.
        try {
          void Promise.resolve(committed.afterCommit?.()).catch((err: unknown) => {
            log?.error({ err, wakeupId: row.id }, 'alarm clock: afterCommit failed');
          });
        } catch (err) {
          log?.error({ err, wakeupId: row.id }, 'alarm clock: afterCommit failed');
        }
      }
    } catch (err) {
      log?.error({ err }, 'alarm clock: tick failed');
    } finally {
      ticking = false;
    }
  }

  function stop(): void {
    stopped = true;
  }

  return { arm, tick, stop };
}

/** A due row that was settled between the scan and its fire — skip, never re-fire. */
class StaleWakeupError extends Error {
  constructor(wakeupId: string) {
    super(`wakeup '${wakeupId}' is no longer pending`);
    this.name = 'StaleWakeupError';
  }
}
