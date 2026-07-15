import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  CATALOG_VERSION,
  type EngineEvent,
  type NewPipelineVersion,
  type Node,
  type RunEvent,
} from '@autonomy-studio/shared';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun } from '../../repo/runs.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import {
  armWakeup,
  getWakeup,
  listPendingWakeups,
  settleWakeup,
} from '../../repo/scheduled-wakeups.js';
import type { Db } from '../../repo/types.js';
import { createRunEventBus } from '../../run/event-bus.js';
import { appendEngineEvent, loadEngineEvents } from '../../run/events.js';
import { createAlarmClock, type WakeupHandler } from '../alarms.js';

/**
 * #5 S1 — the alarm clock. Real DB, real transactions, real `appendEngineEvent`,
 * real event bus. The atomicity + no-phantom-publish tests are only meaningful
 * against the real append path, so nothing here is mocked except the clock
 * (`now`), which is a seam the production code already exposes.
 */

const RETRY_REF = { runId: 'run_1', nodeId: 'a' };
const RetryRefSchema = z.object({ runId: z.string(), nodeId: z.string() });

function seedRun(db: Db): string {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const nodes: Node[] = [{ id: 'a', type: 'agent_task', config: {}, position: { x: 0, y: 0 } }];
  const input: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes,
    edges: [],
    catalogVersion: CATALOG_VERSION,
  };
  const pv = createPipelineVersion(db, input);
  return createRun(db, {
    ownerId: 'local',
    pipelineVersionId: pv.id,
    triggerId: null,
    parentRunId: null,
    params: {},
  }).id;
}

/**
 * A handler that counts its invocations. A custom `fire` is WRAPPED, not
 * substituted, so `calls` stays truthful whichever body runs — spreading the
 * override over the counting `fire` (the obvious spelling) silently zeroes the
 * count and makes every `calls` assertion vacuous.
 */
function spyHandler(overrides: Partial<WakeupHandler> = {}): WakeupHandler & { calls: number } {
  const { fire: customFire, ...rest } = overrides;
  const handler: WakeupHandler & { calls: number } = {
    kind: 'retry',
    refSchema: RetryRefSchema,
    calls: 0,
    ...rest,
    fire(row, delivery, db) {
      handler.calls += 1;
      return customFire ? customFire(row, delivery, db) : { status: 'fired' as const };
    },
  };
  return handler;
}

describe('#5 S1 — the alarm clock fires due alarms', () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb().db;
  });

  it('fires a due alarm and settles the row `fired`', () => {
    const handler = spyHandler();
    const clock = createAlarmClock({ db, handlers: [handler], now: () => 5_000 });
    const armed = clock.arm({ kind: 'retry', ref: RETRY_REF, dueAt: 1_000, discriminator: 'a-1' });

    clock.tick();

    expect(handler.calls).toBe(1);
    expect(getWakeup(db, armed.id)?.status).toBe('fired');
    expect(getWakeup(db, armed.id)?.firedAt).toBe(5_000);
  });

  it('does not fire an alarm that is not yet due', () => {
    const handler = spyHandler();
    const clock = createAlarmClock({ db, handlers: [handler], now: () => 999 });
    clock.arm({ kind: 'retry', ref: RETRY_REF, dueAt: 1_000, discriminator: 'a-1' });

    clock.tick();

    expect(handler.calls).toBe(0);
    expect(listPendingWakeups(db)).toHaveLength(1);
  });

  it('passes the late-alarm delivery context (scheduledFor / firedAt / latenessMs)', () => {
    // Spec #5: "Late-alarm observability: every due event carries
    // `scheduledFor`, `firedAt`, `latenessMs`." The clock supplies the numbers;
    // each handler decides what its event records.
    const seen: unknown[] = [];
    const handler = spyHandler({
      fire: (_row, delivery) => {
        seen.push(delivery);
        return { status: 'fired' };
      },
    });
    const clock = createAlarmClock({ db, handlers: [handler], now: () => 5_500 });
    clock.arm({ kind: 'retry', ref: RETRY_REF, dueAt: 1_000, discriminator: 'a-1' });

    clock.tick();

    expect(seen).toEqual([{ scheduledFor: 1_000, firedAt: 5_500, latenessMs: 4_500 }]);
  });

  it('fires overdue alarms on a fresh clock — "overdue fires on boot"', () => {
    // Spec #5's catch-up policy for retry/wait/webhook/lease. It needs no
    // special code path: an alarm whose `dueAt` passed during downtime is
    // simply due, and the boot's first tick claims it.
    armWakeup(db, { kind: 'retry', ref: RETRY_REF, dueAt: 100, discriminator: 'a-1' });
    const handler = spyHandler();
    const clock = createAlarmClock({ db, handlers: [handler], now: () => 999_999 });

    clock.tick();

    expect(handler.calls).toBe(1);
  });

  it('fires the oldest alarm first', () => {
    const order: number[] = [];
    const handler = spyHandler({
      fire: (row) => {
        order.push(row.dueAt);
        return { status: 'fired' };
      },
    });
    const clock = createAlarmClock({ db, handlers: [handler], now: () => 9_000 });
    clock.arm({ kind: 'retry', ref: RETRY_REF, dueAt: 300, discriminator: 'c' });
    clock.arm({ kind: 'retry', ref: RETRY_REF, dueAt: 100, discriminator: 'a' });
    clock.arm({ kind: 'retry', ref: RETRY_REF, dueAt: 200, discriminator: 'b' });

    clock.tick();

    expect(order).toEqual([100, 200, 300]);
  });

  it('never claims a kind it has no handler for', () => {
    armWakeup(db, { kind: 'from_the_future', ref: RETRY_REF, dueAt: 100, discriminator: 'x' });
    const clock = createAlarmClock({ db, handlers: [spyHandler()], now: () => 9_000 });

    clock.tick();

    expect(listPendingWakeups(db)).toHaveLength(1);
  });
});

describe('#5 S1 — freshness: a stale alarm is SUPPRESSED, not fired', () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb().db;
  });

  it('settles `suppressed` and still appends the handler`s durable event', () => {
    // Spec #5: "every due event re-checks currency before it fires, so stale
    // retries / expired leases / disabled triggers can't emit valid-looking
    // events" — and "no status-only DB mutation": suppression is itself a
    // durable fact the handler may record, appended in the SAME transaction as
    // the settle.
    const runId = seedRun(db);
    const handler = spyHandler({
      fire: (_row, _delivery, tx) => {
        const ev: EngineEvent = { type: 'run.interrupted', runId, reason: 'trigger disabled' };
        return {
          status: 'suppressed',
          reason: 'trigger disabled',
          events: [appendEngineEvent(tx, ev)],
        };
      },
    });
    const clock = createAlarmClock({ db, handlers: [handler], now: () => 5_000 });
    const armed = clock.arm({ kind: 'retry', ref: RETRY_REF, dueAt: 1_000, discriminator: 'a-1' });

    clock.tick();

    expect(getWakeup(db, armed.id)?.status).toBe('suppressed');
    expect(loadEngineEvents(db, runId).map((e) => e.type)).toEqual(['run.interrupted']);
  });
});

describe('#5 S1 — the fire is ONE transaction (the spike`s core claim)', () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb().db;
  });

  it('a REALISTIC retry-shaped handler appends through the real appendEngineEvent', () => {
    // The seam has no production consumer yet (retry is #1 D4), so it is
    // pressure-tested against the closest real shape: a handler appending a
    // genuine EngineEvent to a genuine run via the real `appendEngineEvent`.
    // This is what proves the spike's savepoint-nesting claim — the clock's
    // outer `db.transaction()` wrapping `appendRunEvent`'s OWN inner
    // `db.transaction()` (`repo/run-events.ts:27`), which drops to a SAVEPOINT
    // and commits together.
    const runId = seedRun(db);
    const handler = spyHandler({
      fire: (row, delivery, tx) => {
        const ev: EngineEvent = {
          type: 'node.retryRequested',
          runId: row.ref.runId!,
          nodeId: row.ref.nodeId!,
          previousAttemptId: 'att_1',
          reason: `alarm fired ${String(delivery.latenessMs)}ms late`,
        };
        return { status: 'fired', events: [appendEngineEvent(tx, ev)] };
      },
    });
    const clock = createAlarmClock({ db, handlers: [handler], now: () => 5_000 });
    const armed = clock.arm({
      kind: 'retry',
      ref: { runId, nodeId: 'a' },
      dueAt: 1_000,
      discriminator: 'attempt-1',
    });

    clock.tick();

    const log = loadEngineEvents(db, runId);
    expect(log.map((e) => e.type)).toEqual(['node.retryRequested']);
    expect(getWakeup(db, armed.id)?.status).toBe('fired');
  });

  it('ATOMICITY: a handler that throws after appending rolls BOTH back — no event, row still pending', () => {
    // The at-least-once contract's foundation. If the append committed but the
    // settle did not, the alarm would re-fire and double-append; if the settle
    // committed but the append did not, the alarm would be silently lost. One
    // transaction means neither is possible: the row stays claimable and the
    // next tick re-delivers it.
    const runId = seedRun(db);
    const handler = spyHandler({
      fire: (_row, _delivery, tx) => {
        appendEngineEvent(tx, { type: 'run.interrupted', runId, reason: 'partial' });
        throw new Error('handler blew up after appending');
      },
    });
    const clock = createAlarmClock({ db, handlers: [handler], now: () => 5_000, log: silentLog() });
    const armed = clock.arm({ kind: 'retry', ref: RETRY_REF, dueAt: 1_000, discriminator: 'a-1' });

    clock.tick();

    expect(loadEngineEvents(db, runId)).toHaveLength(0);
    expect(getWakeup(db, armed.id)?.status).toBe('pending');
  });

  it('AT-LEAST-ONCE: a row that failed to fire is re-delivered on the next tick', () => {
    const runId = seedRun(db);
    let attempts = 0;
    const handler = spyHandler({
      fire: (_row, _delivery, tx) => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient');
        return {
          status: 'fired',
          events: [appendEngineEvent(tx, { type: 'run.interrupted', runId, reason: 'ok' })],
        };
      },
    });
    const clock = createAlarmClock({ db, handlers: [handler], now: () => 5_000, log: silentLog() });
    const armed = clock.arm({ kind: 'retry', ref: RETRY_REF, dueAt: 1_000, discriminator: 'a-1' });

    clock.tick();
    clock.tick();

    expect(attempts).toBe(2);
    expect(getWakeup(db, armed.id)?.status).toBe('fired');
    expect(loadEngineEvents(db, runId)).toHaveLength(1);
  });

  it('a failing alarm does not block a healthy one in the same tick', () => {
    const good = spyHandler({ kind: 'good' });
    const bad = spyHandler({
      kind: 'bad',
      fire: () => {
        throw new Error('boom');
      },
    });
    const clock = createAlarmClock({
      db,
      handlers: [bad, good],
      now: () => 9_000,
      log: silentLog(),
    });
    clock.arm({ kind: 'bad', ref: RETRY_REF, dueAt: 100, discriminator: 'x' });
    clock.arm({ kind: 'good', ref: RETRY_REF, dueAt: 200, discriminator: 'y' });

    clock.tick();

    expect(good.calls).toBe(1);
  });
});

describe('#5 S1 — post-commit effects never leak out of a rolled-back fire', () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb().db;
  });

  it('publishes the handler`s events to the bus AFTER the transaction commits', () => {
    const runId = seedRun(db);
    const bus = createRunEventBus();
    const seen: RunEvent[] = [];
    bus.subscribe(runId, (ev) => seen.push(ev));

    const handler = spyHandler({
      fire: (_row, _delivery, tx) => ({
        status: 'fired',
        events: [appendEngineEvent(tx, { type: 'run.interrupted', runId, reason: 'ok' })],
      }),
    });
    const clock = createAlarmClock({ db, handlers: [handler], now: () => 5_000, bus });
    clock.arm({ kind: 'retry', ref: RETRY_REF, dueAt: 1_000, discriminator: 'a-1' });

    clock.tick();

    expect(seen.map((e) => e.type)).toEqual(['run.interrupted']);
  });

  it('NO PHANTOM PUBLISH: a rolled-back fire publishes nothing', () => {
    // Why handlers must not pass the bus to `appendEngineEvent` themselves:
    // that call publishes immediately after its append (`run/events.ts:36`), so
    // inside a transaction that later rolls back it would emit an event to live
    // WS subscribers that does not exist in the log. The clock takes the
    // envelopes back from the handler and publishes them only after commit.
    const runId = seedRun(db);
    const bus = createRunEventBus();
    const seen: RunEvent[] = [];
    bus.subscribe(runId, (ev) => seen.push(ev));

    const handler = spyHandler({
      fire: (_row, _delivery, tx) => {
        appendEngineEvent(tx, { type: 'run.interrupted', runId, reason: 'partial' });
        throw new Error('rollback');
      },
    });
    const clock = createAlarmClock({
      db,
      handlers: [handler],
      now: () => 5_000,
      bus,
      log: silentLog(),
    });
    clock.arm({ kind: 'retry', ref: RETRY_REF, dueAt: 1_000, discriminator: 'a-1' });

    clock.tick();

    expect(seen).toEqual([]);
    expect(loadEngineEvents(db, runId)).toHaveLength(0);
  });

  it('runs `afterCommit` only after the fire commits', () => {
    // The seam for anything that SPAWNS work — the launcher, a worker pool.
    // `launcher.fire()` returns synchronously but runs `createRun` +
    // `run.started` + a bus publish in its synchronous prefix (see
    // `run/launcher.ts:210-218`), so calling it inside the fire transaction
    // would write a run row that a rollback erases while a detached async drive
    // keeps appending against it.
    // Prove the ordering against a DURABLE fact rather than a second spy: at
    // the moment `afterCommit` runs, this row's settle must already be visible
    // to a fresh read. If `afterCommit` ran inside the transaction it would
    // observe `pending` (or its own uncommitted write), not `fired`.
    let statusSeenByAfterCommit: string | undefined;
    let armedId = '';
    const handler = spyHandler({
      fire: () => ({
        status: 'fired',
        afterCommit: () => {
          statusSeenByAfterCommit = getWakeup(db, armedId)?.status;
        },
      }),
    });
    const clock = createAlarmClock({ db, handlers: [handler], now: () => 5_000 });
    armedId = clock.arm({ kind: 'retry', ref: RETRY_REF, dueAt: 1_000, discriminator: 'a-1' }).id;

    clock.tick();

    expect(statusSeenByAfterCommit).toBe('fired');
  });

  it('does NOT run `afterCommit` when the fire rolls back', () => {
    // The handler must RETURN an afterCommit — a handler that throws outright
    // never produces one, which would make this test vacuous. So the handler
    // succeeds and the SETTLE is what fails: it settles its own row first, so
    // the clock's `WHERE status = 'pending'` update matches nothing and the
    // whole fire rolls back. Work that was going to be SPAWNED must not happen
    // for a fire that did not commit.
    let ran = false;
    let armedId = '';
    const handler = spyHandler({
      fire: () => {
        settleWakeup(db, armedId, { status: 'fired', firedAt: 1 });
        return { status: 'fired', afterCommit: () => (ran = true) };
      },
    });
    const clock = createAlarmClock({ db, handlers: [handler], now: () => 5_000, log: silentLog() });
    armedId = clock.arm({ kind: 'retry', ref: RETRY_REF, dueAt: 1_000, discriminator: 'a-1' }).id;

    clock.tick();

    expect(ran).toBe(false);
  });

  it('an afterCommit that throws does not lose the fire (already committed) nor crash the tick', () => {
    const handler = spyHandler({
      fire: () => ({
        status: 'fired',
        afterCommit: () => {
          throw new Error('spawn failed');
        },
      }),
    });
    const clock = createAlarmClock({ db, handlers: [handler], now: () => 5_000, log: silentLog() });
    const armed = clock.arm({ kind: 'retry', ref: RETRY_REF, dueAt: 1_000, discriminator: 'a-1' });

    expect(() => clock.tick()).not.toThrow();
    // The fire is committed and MUST stay committed: re-delivering it would
    // double-append the handler's event.
    expect(getWakeup(db, armed.id)?.status).toBe('fired');
  });
});

describe('#5 S1 — arm validates the ref against the kind`s schema', () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb().db;
  });

  it('refuses a ref that does not match the handler`s refSchema, at ARM time', () => {
    // Spec #5: "Typed `ref` + freshness predicate per kind". Validating when
    // the alarm is armed fails at the call site that wrote the bad ref, rather
    // than hours later in a background tick with nobody to tell.
    const clock = createAlarmClock({ db, handlers: [spyHandler()], now: () => 0 });
    expect(() =>
      clock.arm({ kind: 'retry', ref: { runId: 'run_1' }, dueAt: 1, discriminator: 'a-1' }),
    ).toThrow();
    expect(listPendingWakeups(db)).toHaveLength(0);
  });

  it('refuses to arm a kind with no registered handler', () => {
    // Otherwise the row would sit pending forever, never claimed — an alarm
    // that looks armed but can never fire.
    const clock = createAlarmClock({ db, handlers: [spyHandler()], now: () => 0 });
    expect(() =>
      clock.arm({ kind: 'nope', ref: RETRY_REF, dueAt: 1, discriminator: 'a-1' }),
    ).toThrow(/no handler/i);
  });

  it('refuses duplicate handler kinds at construction', () => {
    expect(() =>
      createAlarmClock({ db, handlers: [spyHandler(), spyHandler()], now: () => 0 }),
    ).toThrow(/duplicate/i);
  });
});

describe('#5 S1 — the tick is safe to run in a headless server', () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb().db;
  });

  it('never throws, even when a handler is buggy', () => {
    const handler = spyHandler({
      fire: () => {
        throw new Error('boom');
      },
    });
    const clock = createAlarmClock({ db, handlers: [handler], now: () => 9_000, log: silentLog() });
    clock.arm({ kind: 'retry', ref: RETRY_REF, dueAt: 1, discriminator: 'a-1' });
    expect(() => clock.tick()).not.toThrow();
  });

  it('never throws when the DB read itself fails', () => {
    const clock = createAlarmClock({
      db: brokenDb(),
      handlers: [spyHandler()],
      now: () => 9_000,
      log: silentLog(),
    });
    expect(() => clock.tick()).not.toThrow();
  });

  it('is not re-entrant: a tick started from inside a tick is a no-op', () => {
    const handler = spyHandler({
      fire: () => {
        clock.tick(); // a handler that (absurdly) re-enters must not recurse
        return { status: 'fired' };
      },
    });
    const clock = createAlarmClock({ db, handlers: [handler], now: () => 9_000, log: silentLog() });
    clock.arm({ kind: 'retry', ref: RETRY_REF, dueAt: 1, discriminator: 'a-1' });

    clock.tick();

    expect(handler.calls).toBe(1);
  });

  it('a stopped clock does not fire and refuses to arm', () => {
    const handler = spyHandler();
    const clock = createAlarmClock({ db, handlers: [handler], now: () => 9_000 });
    clock.arm({ kind: 'retry', ref: RETRY_REF, dueAt: 1, discriminator: 'a-1' });

    clock.stop();
    clock.tick();

    expect(handler.calls).toBe(0);
    expect(() =>
      clock.arm({ kind: 'retry', ref: RETRY_REF, dueAt: 1, discriminator: 'a-2' }),
    ).toThrow(/stopped/i);
  });

  it('skips a row that was settled AFTER the scan snapshot', () => {
    // The scan is a snapshot: a row it returned can be settled before the clock
    // reaches it — here by an earlier alarm's handler settling a sibling (a
    // real shape: a retry handler cancelling a superseded alarm). The settle's
    // `WHERE status = 'pending'` is what makes the clock skip it instead of
    // firing a spent alarm a second time.
    const armedIds: string[] = [];
    const handler = spyHandler({
      fire: (row) => {
        if (row.dueAt === 100) settleWakeup(db, armedIds[1]!, { status: 'fired', firedAt: 1 });
        return { status: 'fired' };
      },
    });
    const clock = createAlarmClock({ db, handlers: [handler], now: () => 9_000, log: silentLog() });
    armedIds.push(clock.arm({ kind: 'retry', ref: RETRY_REF, dueAt: 100, discriminator: 'a' }).id);
    armedIds.push(clock.arm({ kind: 'retry', ref: RETRY_REF, dueAt: 200, discriminator: 'b' }).id);

    expect(() => clock.tick()).not.toThrow();
    // The second row was settled out from under the scan: the clock must have
    // left it alone rather than firing it a second time.
    expect(handler.calls).toBe(1);
  });
});

function silentLog() {
  return { error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

/** A Db whose every read throws — proves the tick's structural try/catch. */
function brokenDb(): Db {
  return {
    select: () => {
      throw new Error('db is down');
    },
  } as unknown as Db;
}
