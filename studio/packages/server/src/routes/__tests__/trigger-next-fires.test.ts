import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION, type TriggerNextFire } from '@autonomy-studio/shared';
import {
  armWakeup,
  createPipeline,
  createPipelineVersion,
  createTrigger,
} from '../../repo/index.js';
import { SCHEDULE_TICK_KIND } from '../../scheduler/schedule-tick.js';
import { pendingTicks } from '../../scheduler/__tests__/pending-ticks.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';

/** #1476 — `GET /api/triggers/next-fires`: when each trigger is next due. */
describe('GET /api/triggers/next-fires', () => {
  let app: FastifyInstance;
  let pipelineVersionId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'For next fires' });
    pipelineVersionId = createPipelineVersion(app.db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    }).id;
  });

  afterAll(async () => {
    await app.close();
  });

  function body(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Nightly',
      pipelineVersionId,
      params: {},
      mode: 'schedule' as const,
      schedule: '0 2 * * *',
      webhook: null,
      concurrency: { policy: 'skip_if_running' as const },
      runWindows: null,
      enabled: true,
      ...overrides,
    };
  }

  async function create(overrides: Record<string, unknown> = {}): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      payload: body(overrides),
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  }

  async function nextFires(): Promise<TriggerNextFire[]> {
    const res = await app.inject({ method: 'GET', url: '/api/triggers/next-fires' });
    expect(res.statusCode).toBe(200);
    return res.json() as TriggerNextFire[];
  }

  it('an enabled schedule trigger is due at its armed tick', async () => {
    const id = await create();
    const [tick] = pendingTicks(app.db, id);
    expect(tick).toBeDefined();
    expect((await nextFires()).find((f) => f.triggerId === id)).toEqual({
      triggerId: id,
      at: tick!.dueAt,
      source: 'schedule',
    });
  });

  it('a disabled or manual trigger has no next fire', async () => {
    const disabled = await create({ enabled: false });
    const manual = await create({ mode: 'manual', schedule: null });
    const ids = (await nextFires()).map((f) => f.triggerId);
    expect(ids).not.toContain(disabled);
    expect(ids).not.toContain(manual);
  });

  it('a tumbling trigger is due when its next window closes', async () => {
    const id = await create({
      mode: 'tumbling',
      schedule: null,
      concurrency: { policy: 'queue' },
      window: { frequency: 'minute', interval: 15, startTime: '2030-01-01T00:00:00.000Z' },
    });
    expect((await nextFires()).find((f) => f.triggerId === id)).toEqual({
      triggerId: id,
      at: Date.parse('2030-01-01T00:15:00.000Z'),
      source: 'window',
    });
  });

  it('another owner’s trigger is never returned, though its tick is armed', async () => {
    const other = createTrigger(app.db, { ownerId: 'someone-else', ...body() });
    app.scheduler.sync();
    expect(pendingTicks(app.db, other.id)).toHaveLength(1);
    expect((await nextFires()).map((f) => f.triggerId)).not.toContain(other.id);
  });

  it('a stale tick (armed for an older schedule) is not the next fire, even when it is sooner', async () => {
    const id = await create();
    const fresh = pendingTicks(app.db, id)[0]!;
    armWakeup(app.db, {
      kind: SCHEDULE_TICK_KIND,
      ref: { triggerId: id, schedule: '5 5 5 5 *' },
      dueAt: fresh.dueAt - 60_000,
      discriminator: 'tick-stale',
    });
    expect((await nextFires()).find((f) => f.triggerId === id)?.at).toBe(fresh.dueAt);
  });

  it('a tick armed for an unbound trigger is not a next fire (it would never fire)', async () => {
    const unbound = createTrigger(app.db, {
      ownerId: 'local',
      ...body({ pipelineVersionId: null }),
    });
    armWakeup(app.db, {
      kind: SCHEDULE_TICK_KIND,
      ref: { triggerId: unbound.id, schedule: '0 2 * * *' },
      dueAt: Date.now() + 60_000,
      discriminator: 'tick-unbound',
    });
    expect((await nextFires()).map((f) => f.triggerId)).not.toContain(unbound.id);
  });

  it('a tick left armed for a since-disabled trigger is not a next fire (the handler would suppress it)', async () => {
    const disabled = createTrigger(app.db, { ownerId: 'local', ...body({ enabled: false }) });
    armWakeup(app.db, {
      kind: SCHEDULE_TICK_KIND,
      ref: { triggerId: disabled.id, schedule: '0 2 * * *' },
      dueAt: Date.now() + 60_000,
      discriminator: 'tick-disabled',
    });
    expect((await nextFires()).map((f) => f.triggerId)).not.toContain(disabled.id);
  });

  it('the earliest of two armed ticks is the next fire', async () => {
    const id = await create();
    const first = pendingTicks(app.db, id)[0]!;
    armWakeup(app.db, {
      kind: SCHEDULE_TICK_KIND,
      ref: { triggerId: id, schedule: '0 2 * * *' },
      dueAt: first.dueAt + 86_400_000,
      discriminator: 'tick-later',
    });
    expect((await nextFires()).find((f) => f.triggerId === id)?.at).toBe(first.dueAt);
  });

  it('one corrupt alarm row is skipped, never fails the read', async () => {
    const healthy = await create();
    const broken = await create();
    const bad = pendingTicks(app.db, broken)[0]!;
    app.db.run(sql`UPDATE scheduled_wakeups SET ref = ${'not json'} WHERE id = ${bad.id}`);
    const ids = (await nextFires()).map((f) => f.triggerId);
    expect(ids).toContain(healthy);
    expect(ids).not.toContain(broken);
  });
});
