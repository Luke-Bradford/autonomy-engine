import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION } from '@autonomy-studio/shared';
import {
  createPipeline,
  createPipelineVersion,
  createTrigger,
  listRuns,
} from '../../repo/index.js';
import { getWebhookDelivery } from '../../repo/webhook-deliveries.js';
import { loadEngineEvents } from '../../run/events.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';

/**
 * #5 S8 — the named-event ingestion channel end-to-end: `POST /api/events
 * {name, payload?}` fans out to every OWNER-matching `event`-mode trigger
 * subscribed to that name, each firing through the shared launcher with the
 * payload seeding `${trigger.body}`.
 */
describe('POST /api/events', () => {
  let app: FastifyInstance;
  let pipelineVersionId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'For events' });
    const version = createPipelineVersion(app.db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [], // empty pipeline drives straight to success
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
    pipelineVersionId = version.id;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app.runLauncher.whenIdle();
  });

  // Each test uses its OWN channel name — the app (and its triggers) is shared
  // across tests, so a common name would leak earlier tests' subscribers into
  // later fan-outs.
  function eventTriggerInput(channel: string, overrides: Record<string, unknown> = {}) {
    return {
      ownerId: 'local',
      name: `Subscriber of ${channel}`,
      pipelineVersionId,
      params: {},
      mode: 'event' as const,
      schedule: null,
      webhook: null,
      event: { name: channel },
      concurrency: { policy: 'parallel' as const, max: 5 },
      runWindows: null,
      enabled: true,
      ...overrides,
    };
  }

  function publish(payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/api/events', payload });
  }

  it('fires every enabled subscriber of the name, and only those', async () => {
    const a = createTrigger(app.db, eventTriggerInput('t1.created'));
    const b = createTrigger(app.db, eventTriggerInput('t1.created', { name: 'Second subscriber' }));
    const other = createTrigger(app.db, eventTriggerInput('t1.deleted'));

    const res = await publish({ name: 't1.created' });
    expect(res.statusCode).toBe(202);
    const results = res.json().results as Array<{ triggerId: string; outcome: string }>;
    expect(new Set(results.map((r) => r.triggerId))).toEqual(new Set([a.id, b.id]));
    expect(results.every((r) => r.outcome === 'started')).toBe(true);

    await app.runLauncher.whenIdle();
    expect(listRuns(app.db, { triggerId: a.id })).toHaveLength(1);
    expect(listRuns(app.db, { triggerId: b.id })).toHaveLength(1);
    expect(listRuns(app.db, { triggerId: other.id })).toHaveLength(0);
  });

  it('the payload seeds run.triggerContext.body and resolves ${trigger.body.x} param bindings', async () => {
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'With param' });
    const version = createPipelineVersion(app.db, {
      pipelineId: pipeline.id,
      params: [{ name: 'who', type: 'string', required: false, default: 'nobody' }],
      outputs: [],
      nodes: [],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
    const trig = createTrigger(
      app.db,
      eventTriggerInput('t2.created', {
        pipelineVersionId: version.id,
        params: { who: '${trigger.body.user}' },
      }),
    );

    const res = await publish({ name: 't2.created', payload: { user: 'ada' } });
    const [result] = res.json().results as Array<{ triggerId: string; runId?: string }>;
    if (result === undefined) throw new Error('no fan-out result');
    expect(result.triggerId).toBe(trig.id);
    await app.runLauncher.whenIdle();

    const events = loadEngineEvents(app.db, result.runId!);
    const seed = events.find((e) => e.type === 'run.triggerContext');
    if (seed?.type !== 'run.triggerContext') throw new Error('no trigger seed');
    expect(seed.body).toEqual({ user: 'ada' });
    const started = events.find((e) => e.type === 'run.started');
    if (started?.type !== 'run.started') throw new Error('no run.started');
    expect(started.params.who).toBe('ada');
  });

  it('NEVER fires another owner’s subscriber to the same name (owner-scoped fan-out)', async () => {
    const foreign = createTrigger(
      app.db,
      eventTriggerInput('t3.created', { ownerId: 'someone-else', name: 'Not yours' }),
    );

    const res = await publish({ name: 't3.created' });
    const results = res.json().results as Array<{ triggerId: string }>;
    expect(results.map((r) => r.triggerId)).not.toContain(foreign.id);
    await app.runLauncher.whenIdle();
    expect(listRuns(app.db, { triggerId: foreign.id })).toHaveLength(0);
  });

  it('a disabled subscriber is reported skipped (matched by name, gated like a webhook fire)', async () => {
    const trig = createTrigger(app.db, eventTriggerInput('t4.created', { enabled: false }));
    const res = await publish({ name: 't4.created' });
    const result = (res.json().results as Array<{ triggerId: string; outcome: string }>).find(
      (r) => r.triggerId === trig.id,
    );
    expect(result?.outcome).toBe('skipped');
    expect(listRuns(app.db, { triggerId: trig.id })).toHaveLength(0);
  });

  it('an out-of-window subscriber skips (automatic firing is window-gated)', async () => {
    // A zero-width window that can never contain "now".
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mm = String(now.getUTCMinutes()).padStart(2, '0');
    const point = `${hh}:${mm}`;
    const trig = createTrigger(
      app.db,
      eventTriggerInput('t5.created', { runWindows: [{ start: point, end: point }] }),
    );
    const res = await publish({ name: 't5.created' });
    const result = (res.json().results as Array<{ triggerId: string; outcome: string }>).find(
      (r) => r.triggerId === trig.id,
    );
    expect(result?.outcome).toBe('skipped');
    expect(listRuns(app.db, { triggerId: trig.id })).toHaveLength(0);
  });

  it('202 with empty results when nothing subscribes to the name', async () => {
    const res = await publish({ name: 'nobody.listens' });
    expect(res.statusCode).toBe(202);
    expect(res.json().results).toEqual([]);
  });

  it('an idempotencyKey dedupes per subscriber: the replay is served duplicate, fired once', async () => {
    const trig = createTrigger(app.db, eventTriggerInput('t7.created'));
    const first = await publish({ name: 't7.created', idempotencyKey: 'evt-1' });
    expect(first.json().results[0].outcome).toBe('started');
    await app.runLauncher.whenIdle();

    const replay = await publish({ name: 't7.created', idempotencyKey: 'evt-1' });
    expect(replay.json().results[0].outcome).toBe('duplicate');
    await app.runLauncher.whenIdle();
    expect(listRuns(app.db, { triggerId: trig.id })).toHaveLength(1);
  });

  it('WITHOUT an idempotencyKey each publish fires (documented: no dedup for first-party callers)', async () => {
    const trig = createTrigger(app.db, eventTriggerInput('t8.created'));
    await publish({ name: 't8.created' });
    await publish({ name: 't8.created' });
    await app.runLauncher.whenIdle();
    expect(listRuns(app.db, { triggerId: trig.id })).toHaveLength(2);
  });

  it('an unresolvable binding is RECORDED skipped under the key (no retry storm), siblings still fire', async () => {
    const bad = createTrigger(
      app.db,
      eventTriggerInput('t9.created', { params: { x: '${trigger.body.missing.deep}' } }),
    );
    const good = createTrigger(
      app.db,
      eventTriggerInput('t9.created', { name: 'Healthy sibling' }),
    );

    const res = await publish({ name: 't9.created', idempotencyKey: 'evt-mixed' });
    const results = res.json().results as Array<{ triggerId: string; outcome: string }>;
    expect(results.find((r) => r.triggerId === bad.id)?.outcome).toBe('skipped');
    expect(results.find((r) => r.triggerId === good.id)?.outcome).toBe('started');
    await app.runLauncher.whenIdle();
    expect(listRuns(app.db, { triggerId: bad.id })).toHaveLength(0);

    // The bad subscriber's delivery WAS recorded — the verbatim replay dedupes.
    const replay = await publish({ name: 't9.created', idempotencyKey: 'evt-mixed' });
    const replayResults = replay.json().results as Array<{ triggerId: string; outcome: string }>;
    expect(replayResults.find((r) => r.triggerId === bad.id)?.outcome).toBe('duplicate');
    expect(replayResults.find((r) => r.triggerId === good.id)?.outcome).toBe('duplicate');
  });

  it('400s a non-finite number in the payload up front (#547 — first-party callers get the real error)', async () => {
    createTrigger(app.db, eventTriggerInput('t10.created'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: '{"name":"t10.created","payload":{"x":1e999}}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    await app.runLauncher.whenIdle();
  });

  it('400s a malformed publish (missing name)', async () => {
    const res = await publish({ payload: { x: 1 } });
    expect(res.statusCode).toBe(400);
  });

  it('a keyed GATE skip records nothing — the SAME key fires once the trigger is enabled', async () => {
    const trig = createTrigger(app.db, eventTriggerInput('t11.created', { enabled: false }));
    const skipped = await publish({ name: 't11.created', idempotencyKey: 'evt-gate' });
    expect(
      (skipped.json().results as Array<{ triggerId: string; outcome: string }>).find(
        (r) => r.triggerId === trig.id,
      )?.outcome,
    ).toBe('skipped');
    expect(getWebhookDelivery(app.db, trig.id, 'evt-gate')).toBeNull();

    await app.inject({
      method: 'PATCH',
      url: `/api/triggers/${trig.id}`,
      payload: { enabled: true },
    });
    const fired = await publish({ name: 't11.created', idempotencyKey: 'evt-gate' });
    expect(
      (fired.json().results as Array<{ triggerId: string; outcome: string }>).find(
        (r) => r.triggerId === trig.id,
      )?.outcome,
    ).toBe('started');
    await app.runLauncher.whenIdle();
  });

  it('an unbound subscriber RELEASES its claim (skipped, defense-in-depth) — the key fires after rebinding', async () => {
    // Only creatable by bypassing the route guard (repo direct) — the write API
    // refuses enabled+unbound. The fan-out must honour "unbound never fires"
    // regardless, and must not burn the sender's key on it.
    const trig = createTrigger(
      app.db,
      eventTriggerInput('t12.created', { pipelineVersionId: null }),
    );
    const res = await publish({ name: 't12.created', idempotencyKey: 'evt-unbound' });
    const result = (
      res.json().results as Array<{ triggerId: string; outcome: string; reason?: string }>
    ).find((r) => r.triggerId === trig.id);
    expect(result?.outcome).toBe('skipped');
    expect(result?.reason).toMatch(/no bound pipeline version/);
    expect(getWebhookDelivery(app.db, trig.id, 'evt-unbound')).toBeNull();

    await app.inject({
      method: 'PATCH',
      url: `/api/triggers/${trig.id}`,
      payload: { pipelineVersionId },
    });
    const fired = await publish({ name: 't12.created', idempotencyKey: 'evt-unbound' });
    expect(
      (fired.json().results as Array<{ triggerId: string; outcome: string }>).find(
        (r) => r.triggerId === trig.id,
      )?.outcome,
    ).toBe('started');
    await app.runLauncher.whenIdle();
  });

  it("an unexpected launcher fault reports outcome:'error', releases the claim, and never aborts siblings", async () => {
    const bad = createTrigger(app.db, eventTriggerInput('t13.created'));
    const good = createTrigger(
      app.db,
      eventTriggerInput('t13.created', { name: 'Unaffected sibling' }),
    );

    // Inject a one-shot fault at the launcher seam for the bad trigger only —
    // the route, ledger, and sibling firing under test are all real.
    const realFire = app.runLauncher.fire.bind(app.runLauncher);
    const spy = vi.spyOn(app.runLauncher, 'fire').mockImplementation((trigger, ctx) => {
      if (trigger.id === bad.id) throw new Error('injected launcher fault');
      return realFire(trigger, ctx);
    });
    try {
      const res = await publish({ name: 't13.created', idempotencyKey: 'evt-fault' });
      expect(res.statusCode).toBe(202);
      const results = res.json().results as Array<{ triggerId: string; outcome: string }>;
      expect(results.find((r) => r.triggerId === bad.id)?.outcome).toBe('error');
      expect(results.find((r) => r.triggerId === good.id)?.outcome).toBe('started');
      // The claim was RELEASED — a corrected retry of the same key is not deduped.
      expect(getWebhookDelivery(app.db, bad.id, 'evt-fault')).toBeNull();
    } finally {
      spy.mockRestore();
    }
    // After the fault clears, the same key fires (release verified end-to-end).
    const retry = await publish({ name: 't13.created', idempotencyKey: 'evt-fault' });
    expect(
      (retry.json().results as Array<{ triggerId: string; outcome: string }>).find(
        (r) => r.triggerId === bad.id,
      )?.outcome,
    ).toBe('started');
    await app.runLauncher.whenIdle();
  });

  it('a keyed publish during launcher shutdown RELEASES the claim (transient — never a durable skip)', async () => {
    // Dedicated app: stopping the shared launcher would poison later tests.
    const local = await buildTestApp();
    try {
      const pipeline = createPipeline(local.db, { ownerId: 'local', name: 'Shutdown' });
      const version = createPipelineVersion(local.db, {
        pipelineId: pipeline.id,
        params: [],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: CATALOG_VERSION,
      });
      const trig = createTrigger(local.db, {
        ...eventTriggerInput('t14.created'),
        pipelineVersionId: version.id,
      });

      local.runLauncher.stop();
      const res = await local.inject({
        method: 'POST',
        url: '/api/events',
        payload: { name: 't14.created', idempotencyKey: 'evt-shutdown' },
      });
      const result = (
        res.json().results as Array<{ triggerId: string; outcome: string; reason?: string }>
      ).find((r) => r.triggerId === trig.id);
      expect(result?.outcome).toBe('skipped');
      expect(result?.reason).toMatch(/shutting down/);
      // NOT finalized — the post-restart retry of the same key must fire.
      expect(getWebhookDelivery(local.db, trig.id, 'evt-shutdown')).toBeNull();
    } finally {
      await local.close();
    }
  });
});
