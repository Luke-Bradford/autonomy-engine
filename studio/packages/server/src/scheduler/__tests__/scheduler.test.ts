import { describe, expect, it, vi } from 'vitest';
import {
  CATALOG_VERSION,
  type NewPipelineVersion,
  type Node,
  type RunWindow,
  type Trigger,
  type TriggerMode,
} from '@autonomy-studio/shared';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion } from '../../repo/pipeline-versions.js';
import { createTrigger, deleteTrigger, updateTrigger } from '../../repo/triggers.js';
import { triggers } from '../../db/schema.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { UnboundTriggerError, type FireResult } from '../../run/launcher.js';
import { createScheduler, type SchedulerDeps } from '../scheduler.js';
import { silentLog } from './testLog.js';

type Db = ReturnType<typeof freshDb>['db'];

function seedVersion(db: Db): string {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const node: Node = { id: 'a', type: 'agent_task', config: {}, position: { x: 0, y: 0 } };
  const input: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes: [node],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  };
  return createPipelineVersion(db, input).id;
}

function seedTrigger(
  db: Db,
  opts: {
    pipelineVersionId: string | null;
    mode?: TriggerMode;
    schedule?: string | null;
    enabled?: boolean;
    runWindows?: RunWindow[] | null;
  },
): Trigger {
  return createTrigger(db, {
    ownerId: 'local',
    name: 'T',
    pipelineVersionId: opts.pipelineVersionId,
    params: {},
    mode: opts.mode ?? 'schedule',
    schedule: opts.schedule === undefined ? '* * * * *' : opts.schedule,
    webhook: null,
    concurrency: { policy: 'skip_if_running' },
    runWindows: opts.runWindows ?? null,
    enabled: opts.enabled ?? true,
  });
}

/** A launcher test double that records every fire. */
function fakeLauncher() {
  const fires: Trigger[] = [];
  return {
    fires,
    fire: vi.fn((t: Trigger): FireResult => {
      fires.push(t);
      return { outcome: 'started', runId: `run-${t.id}` };
    }),
  };
}

const NOON = () => new Date('2026-07-15T12:00:00.000Z');

describe('Scheduler — sync() builds the cron set', () => {
  it('requires a `log` dependency — it is a required key of SchedulerDeps, not optional (#470)', () => {
    // #470: `log` was `log?:`, so a caller could omit it and every failure path
    // (`deps.log?.error(...)` — a dispatch fault, invalid cron, corrupt trigger
    // row, list-on-sync error) passed silently. This asserts the PROPERTY
    // directly — `log` is required — instead of a bare `@ts-expect-error` on a
    // construct site, which cannot pin an error code and would keep "passing" if
    // an unrelated future error landed on that line. If `log` reverts to
    // optional, `SchedulerDeps['log']` widens to `SchedulerLog | undefined`,
    // `undefined extends …` is true, `LogRequired` collapses to `never`, and
    // `const _: never = true` fails to compile — a precise tripwire.
    type LogRequired = undefined extends SchedulerDeps['log'] ? never : true;
    const logIsRequired: LogRequired = true;
    expect(logIsRequired).toBe(true);
  });

  it('schedules only enabled, schedule-mode, scheduled triggers', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const wanted = seedTrigger(db, { pipelineVersionId: pv });
    seedTrigger(db, { pipelineVersionId: pv, enabled: false }); // disabled
    seedTrigger(db, { pipelineVersionId: pv, mode: 'manual', schedule: null }); // manual
    seedTrigger(db, { pipelineVersionId: pv, mode: 'webhook', schedule: null }); // webhook

    const scheduler = createScheduler({
      db,
      launcher: fakeLauncher(),
      now: NOON,
      log: silentLog(),
    });
    scheduler.sync();

    expect(scheduler.scheduledTriggerIds()).toEqual([wanted.id]);
    scheduler.stop();
  });

  it('prunes a trigger that became disabled and re-schedules one whose expression changed', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const a = seedTrigger(db, { pipelineVersionId: pv, schedule: '0 * * * *' });
    const b = seedTrigger(db, { pipelineVersionId: pv, schedule: '*/5 * * * *' });
    const scheduler = createScheduler({
      db,
      launcher: fakeLauncher(),
      now: NOON,
      log: silentLog(),
    });
    scheduler.sync();
    expect(scheduler.scheduledTriggerIds().sort()).toEqual([a.id, b.id].sort());

    updateTrigger(db, a.id, { enabled: false });
    updateTrigger(db, b.id, { schedule: '0 0 * * *' });
    scheduler.sync();

    expect(scheduler.scheduledTriggerIds()).toEqual([b.id]);
    scheduler.stop();
  });

  it('skips an invalid cron expression without throwing and leaves it unscheduled', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const good = seedTrigger(db, { pipelineVersionId: pv, schedule: '0 * * * *' });
    seedTrigger(db, { pipelineVersionId: pv, schedule: 'not-a-cron' });
    const warn = vi.fn();
    const scheduler = createScheduler({
      db,
      launcher: fakeLauncher(),
      now: NOON,
      log: { error: vi.fn(), warn, debug: vi.fn() },
    });

    expect(() => scheduler.sync()).not.toThrow();
    expect(scheduler.scheduledTriggerIds()).toEqual([good.id]);
    expect(warn).toHaveBeenCalledOnce();
    scheduler.stop();
  });

  it('a single corrupt trigger row does not dark-out scheduling of the others', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const good = seedTrigger(db, { pipelineVersionId: pv, schedule: '0 * * * *' });
    // A corrupt row (out-of-enum concurrency policy) that TriggerSchema rejects.
    db.insert(triggers)
      .values({
        id: 'trig_poison',
        ownerId: 'local',
        name: 'poison',
        pipelineVersionId: pv,
        params: {},
        mode: 'schedule',
        schedule: '*/5 * * * *',
        webhook: null,
        concurrency: { policy: 'nope' } as unknown as { policy: 'queue' },
        runWindows: null,
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    const warn = vi.fn();
    const scheduler = createScheduler({
      db,
      launcher: fakeLauncher(),
      now: NOON,
      log: { error: vi.fn(), warn, debug: vi.fn() },
    });

    expect(() => scheduler.sync()).not.toThrow();
    // The good trigger is still scheduled despite the poison row.
    expect(scheduler.scheduledTriggerIds()).toEqual([good.id]);
    expect(warn).toHaveBeenCalled();
    scheduler.stop();
  });

  it('is a no-op after stop()', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    seedTrigger(db, { pipelineVersionId: pv });
    const scheduler = createScheduler({
      db,
      launcher: fakeLauncher(),
      now: NOON,
      log: silentLog(),
    });
    scheduler.stop();
    scheduler.sync();
    expect(scheduler.scheduledTriggerIds()).toEqual([]);
  });
});

describe('Scheduler — dispatch() fire gating', () => {
  it('fires a bound, enabled, in-window trigger through the launcher', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const t = seedTrigger(db, { pipelineVersionId: pv });
    const launcher = fakeLauncher();
    const scheduler = createScheduler({ db, launcher, now: NOON, log: silentLog() });

    scheduler.dispatch(t.id);

    expect(launcher.fire).toHaveBeenCalledOnce();
    expect(launcher.fires[0]!.id).toBe(t.id);
    scheduler.stop();
  });

  it('DEFERRED REQ: refuses to fire an unbound (null-bound) trigger', () => {
    const { db } = freshDb();
    // Enabled + unbound is normally blocked by the write API, but is seedable
    // directly via the repo to prove the scheduler's own defense.
    const t = seedTrigger(db, { pipelineVersionId: null });
    const launcher = fakeLauncher();
    const scheduler = createScheduler({ db, launcher, now: NOON, log: silentLog() });

    scheduler.dispatch(t.id);

    expect(launcher.fire).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('skips a disabled / deleted / wrong-mode trigger', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const disabled = seedTrigger(db, { pipelineVersionId: pv, enabled: false });
    const manual = seedTrigger(db, { pipelineVersionId: pv, mode: 'manual', schedule: null });
    const gone = seedTrigger(db, { pipelineVersionId: pv });
    deleteTrigger(db, gone.id);
    const launcher = fakeLauncher();
    const scheduler = createScheduler({ db, launcher, now: NOON, log: silentLog() });

    scheduler.dispatch(disabled.id);
    scheduler.dispatch(manual.id);
    scheduler.dispatch(gone.id);

    expect(launcher.fire).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('gates on run windows: fires inside, skips outside (UTC)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const t = seedTrigger(db, {
      pipelineVersionId: pv,
      runWindows: [{ start: '09:00', end: '17:00' }],
    });
    const launcher = fakeLauncher();

    // 12:00 UTC — inside.
    createScheduler({ db, launcher, now: NOON, log: silentLog() }).dispatch(t.id);
    expect(launcher.fire).toHaveBeenCalledTimes(1);

    // 20:00 UTC — outside; no additional fire.
    createScheduler({
      db,
      launcher,
      now: () => new Date('2026-07-15T20:00:00.000Z'),
      log: silentLog(),
    }).dispatch(t.id);
    expect(launcher.fire).toHaveBeenCalledTimes(1);
  });

  it('swallows an UnboundTriggerError raced from the launcher (does not throw)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const t = seedTrigger(db, { pipelineVersionId: pv });
    const launcher = {
      fire: vi.fn(() => {
        throw new UnboundTriggerError(t.id);
      }),
    };
    const scheduler = createScheduler({ db, launcher, now: NOON, log: silentLog() });

    expect(() => scheduler.dispatch(t.id)).not.toThrow();
    scheduler.stop();
  });

  it('does not let an unexpected launcher fault crash the tick', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const t = seedTrigger(db, { pipelineVersionId: pv });
    const error = vi.fn();
    const launcher = {
      fire: vi.fn(() => {
        throw new Error('boom');
      }),
    };
    const scheduler = createScheduler({
      db,
      launcher,
      now: NOON,
      log: { error, warn: vi.fn(), debug: vi.fn() },
    });

    expect(() => scheduler.dispatch(t.id)).not.toThrow();
    expect(error).toHaveBeenCalledOnce();
    scheduler.stop();
  });
});
