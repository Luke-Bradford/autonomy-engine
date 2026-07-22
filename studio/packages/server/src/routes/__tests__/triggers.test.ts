import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION, type NewTrigger } from '@autonomy-studio/shared';
import { createPipeline, createPipelineVersion, createTrigger } from '../../repo/index.js';
import { getRun } from '../../repo/runs.js';
import { listPendingWakeups } from '../../repo/scheduled-wakeups.js';
import { SCHEDULE_TICK_KIND } from '../../scheduler/schedule-tick.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';

function triggerBody(pipelineVersionId: string) {
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
  };
}

function newTriggerInput(pipelineVersionId: string, ownerId: string): NewTrigger {
  return { ownerId, ...triggerBody(pipelineVersionId) };
}

describe('triggers routes', () => {
  let app: FastifyInstance;
  let pipelineVersionId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'For triggers' });
    const version = createPipelineVersion(app.db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
    pipelineVersionId = version.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('full CRUD round-trip, owner-scoped', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      payload: triggerBody(pipelineVersionId),
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.ownerId).toBe('local');
    expect(created.mode).toBe('schedule');

    const getRes = await app.inject({ method: 'GET', url: `/api/triggers/${created.id}` });
    expect(getRes.json()).toEqual(created);

    const listRes = await app.inject({ method: 'GET', url: '/api/triggers' });
    expect(listRes.json().map((t: { id: string }) => t.id)).toContain(created.id);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/triggers/${created.id}`,
      payload: { enabled: false },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().enabled).toBe(false);

    const deleteRes = await app.inject({ method: 'DELETE', url: `/api/triggers/${created.id}` });
    expect(deleteRes.statusCode).toBe(204);

    const missing = await app.inject({ method: 'GET', url: `/api/triggers/${created.id}` });
    expect(missing.statusCode).toBe(404);
  });

  it('owner scoping: a trigger belonging to a different owner is not visible', async () => {
    const other = createTrigger(app.db, newTriggerInput(pipelineVersionId, 'someone-else'));

    const listRes = await app.inject({ method: 'GET', url: '/api/triggers' });
    expect(listRes.json().map((t: { id: string }) => t.id)).not.toContain(other.id);

    const getRes = await app.inject({ method: 'GET', url: `/api/triggers/${other.id}` });
    expect(getRes.statusCode).toBe(404);
  });

  it('validation: bad body -> 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      payload: { name: 'Bad', pipelineVersionId, mode: 'not_a_real_mode' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('creating a trigger for a nonexistent pipeline version is a 404 (same shape as a missing resource, not a DB-constraint 409)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      payload: triggerBody('pv_does_not_exist'),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  it('404 for a missing trigger', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/triggers/trig_missing' });
    expect(res.statusCode).toBe(404);
  });

  it('unbound-trigger guard: cannot CREATE an enabled trigger with a null pipelineVersionId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      payload: { ...triggerBody(pipelineVersionId), pipelineVersionId: null, enabled: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_request');
  });

  it('unbound-trigger guard: a DISABLED unbound trigger IS allowed (draft/import shape)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      payload: { ...triggerBody(pipelineVersionId), pipelineVersionId: null, enabled: false },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().pipelineVersionId).toBe(null);
    expect(res.json().enabled).toBe(false);
  });

  it('unbound-trigger guard: PATCH cannot enable an unbound trigger, nor unbind an enabled one', async () => {
    const draft = (
      await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: { ...triggerBody(pipelineVersionId), pipelineVersionId: null, enabled: false },
      })
    ).json();
    const enableUnbound = await app.inject({
      method: 'PATCH',
      url: `/api/triggers/${draft.id}`,
      payload: { enabled: true },
    });
    expect(enableUnbound.statusCode).toBe(400);

    const bound = (
      await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: triggerBody(pipelineVersionId),
      })
    ).json();
    const unbindEnabled = await app.inject({
      method: 'PATCH',
      url: `/api/triggers/${bound.id}`,
      payload: { pipelineVersionId: null },
    });
    expect(unbindEnabled.statusCode).toBe(400);
  });

  describe('pipelineVersionId cross-owner reference seam', () => {
    let otherOwnerVersionId: string;

    beforeAll(() => {
      const pipeline = createPipeline(app.db, { ownerId: 'someone-else', name: 'Not mine' });
      const version = createPipelineVersion(app.db, {
        pipelineId: pipeline.id,
        params: [],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: CATALOG_VERSION,
      });
      otherOwnerVersionId = version.id;
    });

    it('POST: binding a pipelineVersionId owned by a different owner is 404, indistinguishable from a missing one', async () => {
      const missingRes = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: triggerBody('pv_does_not_exist'),
      });
      const crossOwnerRes = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: triggerBody(otherOwnerVersionId),
      });
      // Same status code and error shape either way — the client-visible id
      // in the message is the id it already supplied itself (not a leak);
      // what must never differ is 404-missing vs 404-unowned vs a 201/409
      // split that would let a caller distinguish "doesn't exist" from
      // "exists but isn't yours".
      expect(crossOwnerRes.statusCode).toBe(404);
      expect(crossOwnerRes.statusCode).toBe(missingRes.statusCode);
      expect(crossOwnerRes.json().error).toBe('not_found');
      expect(crossOwnerRes.json().error).toBe(missingRes.json().error);
    });

    it('POST: binding an owned pipelineVersionId still works', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: triggerBody(pipelineVersionId),
      });
      expect(res.statusCode).toBe(201);
    });

    it('PATCH: rebinding pipelineVersionId to one owned by a different owner is 404', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: triggerBody(pipelineVersionId),
      });
      const trigger = created.json();

      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/triggers/${trigger.id}`,
        payload: { pipelineVersionId: otherOwnerVersionId },
      });
      expect(patchRes.statusCode).toBe(404);

      // The trigger's binding is untouched by the rejected patch.
      const getRes = await app.inject({ method: 'GET', url: `/api/triggers/${trigger.id}` });
      expect(getRes.json().pipelineVersionId).toBe(pipelineVersionId);
    });

    it('PATCH: rebinding pipelineVersionId to another owned version still works', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: triggerBody(pipelineVersionId),
      });
      const trigger = created.json();

      const anotherOwnedPipeline = createPipeline(app.db, { ownerId: 'local', name: 'Also mine' });
      const anotherOwnedVersion = createPipelineVersion(app.db, {
        pipelineId: anotherOwnedPipeline.id,
        params: [],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: CATALOG_VERSION,
      });

      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/triggers/${trigger.id}`,
        payload: { pipelineVersionId: anotherOwnedVersion.id },
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json().pipelineVersionId).toBe(anotherOwnedVersion.id);
    });
  });

  describe('POST /api/triggers/:id/fire — manual fire', () => {
    it('fires a bound trigger: 202 started, and the run drives to success end-to-end', async () => {
      const created = (
        await app.inject({
          method: 'POST',
          url: '/api/triggers',
          payload: triggerBody(pipelineVersionId),
        })
      ).json();

      const fireRes = await app.inject({ method: 'POST', url: `/api/triggers/${created.id}/fire` });
      expect(fireRes.statusCode).toBe(202);
      const result = fireRes.json();
      expect(result.outcome).toBe('started');
      expect(result.runId).toBeDefined();

      // The run drives in the background — wait for it, then confirm success
      // + provenance through the public run API (the "fire → it runs" bar).
      await app.runLauncher.whenIdle();
      const runRes = await app.inject({ method: 'GET', url: `/api/runs/${result.runId}` });
      expect(runRes.statusCode).toBe(200);
      expect(runRes.json().status).toBe('success');
      expect(runRes.json().triggerId).toBe(created.id);
    });

    it('fires a DISABLED (but bound) trigger: manual fire is independent of `enabled`', async () => {
      const created = (
        await app.inject({
          method: 'POST',
          url: '/api/triggers',
          payload: { ...triggerBody(pipelineVersionId), enabled: false },
        })
      ).json();

      const fireRes = await app.inject({ method: 'POST', url: `/api/triggers/${created.id}/fire` });
      expect(fireRes.statusCode).toBe(202);
      expect(fireRes.json().outcome).toBe('started');
      await app.runLauncher.whenIdle();
    });

    it('refuses to fire an unbound trigger: 400 bad_request ("unbound never fires")', async () => {
      const draft = (
        await app.inject({
          method: 'POST',
          url: '/api/triggers',
          payload: { ...triggerBody(pipelineVersionId), pipelineVersionId: null, enabled: false },
        })
      ).json();

      const fireRes = await app.inject({ method: 'POST', url: `/api/triggers/${draft.id}/fire` });
      expect(fireRes.statusCode).toBe(400);
      expect(fireRes.json().error).toBe('bad_request');
    });

    it('404 for a missing trigger', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/triggers/trig_missing/fire' });
      expect(res.statusCode).toBe(404);
    });

    it('404 (not 403) for another owner’s trigger — same opacity as every other route', async () => {
      const other = createTrigger(app.db, newTriggerInput(pipelineVersionId, 'someone-else'));
      const res = await app.inject({ method: 'POST', url: `/api/triggers/${other.id}/fire` });
      expect(res.statusCode).toBe(404);
    });

    // #5 S12b — run-now param override + fire-time binding resolution.
    it('threads the run-now `{ params }` override into the run, winning over a binding', async () => {
      const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'runnow' });
      const version = createPipelineVersion(app.db, {
        pipelineId: pipeline.id,
        params: [{ name: 'c', type: 'string', required: false, default: 'dc' }],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: CATALOG_VERSION,
      });
      const created = (
        await app.inject({
          method: 'POST',
          url: '/api/triggers',
          // A literal trigger binding for `c` that the run-now override must beat.
          payload: { ...triggerBody(version.id), params: { c: 'binding-c' } },
        })
      ).json();

      const fireRes = await app.inject({
        method: 'POST',
        url: `/api/triggers/${created.id}/fire`,
        payload: { params: { c: 'runnow-c' } },
      });
      expect(fireRes.statusCode).toBe(202);
      expect(fireRes.json().outcome).toBe('started');
      await app.runLauncher.whenIdle();

      // The run's stored override layer = trigger binding merged UNDER run-now.
      expect(getRun(app.db, fireRes.json().runId)?.params).toEqual({ c: 'runnow-c' });
    });

    it('400 when a trigger param binding cannot resolve for this fire (deep-address of a null body)', async () => {
      const created = (
        await app.inject({
          method: 'POST',
          url: '/api/triggers',
          // Save-VALID (body is a known field) but throws at fire time: a manual
          // fire carries a null body, so `${trigger.body.k}` deep-addresses null.
          payload: { ...triggerBody(pipelineVersionId), params: { x: '${trigger.body.k}' } },
        })
      ).json();

      const fireRes = await app.inject({ method: 'POST', url: `/api/triggers/${created.id}/fire` });
      expect(fireRes.statusCode).toBe(400);
      expect(fireRes.json().error).toBe('bad_request');
    });

    // #547 boundary 2 — a non-finite run-now override is refused at the fire
    // write boundary (FireRequestSchema → ZodError → 400), BEFORE any run row is
    // created, so it can never reach run.params / the run.started event.
    it('400 for a non-finite run-now override param (#547)', async () => {
      const created = (
        await app.inject({
          method: 'POST',
          url: '/api/triggers',
          payload: triggerBody(pipelineVersionId),
        })
      ).json();

      const fireRes = await app.inject({
        method: 'POST',
        url: `/api/triggers/${created.id}/fire`,
        // JSON.parse of the request body yields Infinity for 1e999.
        payload: '{"params":{"x":1e999}}',
        headers: { 'content-type': 'application/json' },
      });
      expect(fireRes.statusCode).toBe(400);
      // FireRequestSchema.parse throws a ZodError (the run-now body is parsed
      // before the launcher's try/catch), mapped by the global handler.
      expect(fireRes.json().error).toBe('validation_error');
      expect(JSON.stringify(fireRes.json())).toMatch(/non-finite number refused/);
    });

    it('an undeclared run-now override surfaces as an INTERRUPTED run, not a 400', async () => {
      const created = (
        await app.inject({
          method: 'POST',
          url: '/api/triggers',
          payload: triggerBody(pipelineVersionId), // pv declares NO params
        })
      ).json();

      const fireRes = await app.inject({
        method: 'POST',
        url: `/api/triggers/${created.id}/fire`,
        payload: { params: { undeclared: 1 } },
      });
      // Admitted synchronously (202) — the bad override is caught at run start by
      // `resolveRunParams` (background), consistent with a bad trigger-authored param.
      expect(fireRes.statusCode).toBe(202);
      expect(fireRes.json().outcome).toBe('started');
      await app.runLauncher.whenIdle();
      expect(getRun(app.db, fireRes.json().runId)?.status).toBe('interrupted');
    });
  });

  describe('TriggerPublic projection', () => {
    it('strips webhook.secretRef from create/get/list/update responses', async () => {
      const webhookBody = {
        ...triggerBody(pipelineVersionId),
        mode: 'webhook' as const,
        schedule: null,
        webhook: { secretRef: 'secret_should_never_leak', idempotencyWindowSeconds: 300 },
      };

      const createRes = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: webhookBody,
      });
      expect(createRes.statusCode).toBe(201);
      const created = createRes.json();
      expect(created.webhook).toEqual({ idempotencyWindowSeconds: 300 });
      expect(JSON.stringify(created)).not.toContain('secret_should_never_leak');

      const getRes = await app.inject({ method: 'GET', url: `/api/triggers/${created.id}` });
      expect(JSON.stringify(getRes.json())).not.toContain('secret_should_never_leak');

      const listRes = await app.inject({ method: 'GET', url: '/api/triggers' });
      expect(JSON.stringify(listRes.json())).not.toContain('secret_should_never_leak');

      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/triggers/${created.id}`,
        payload: { enabled: false },
      });
      expect(JSON.stringify(patchRes.json())).not.toContain('secret_should_never_leak');
    });
  });

  describe('#5 S5b-1 — recurrence authoring', () => {
    function scheduleTicksFor(app: FastifyInstance, triggerId: string) {
      return listPendingWakeups(app.db).filter(
        (w) =>
          w.kind === SCHEDULE_TICK_KIND &&
          (w.ref as { triggerId?: string }).triggerId === triggerId,
      );
    }

    it('creates a schedule trigger from a recurrence, derives the cron, and SEEDS a durable tick', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: {
          ...triggerBody(pipelineVersionId),
          schedule: null,
          recurrence: { frequency: 'day', schedule: { hours: [9], minutes: [30] } },
        },
      });
      expect(res.statusCode).toBe(201);
      const created = res.json();
      // The derived cron is the firing chain's `schedule`, and the authored
      // recurrence round-trips (interval defaulted).
      expect(created.schedule).toBe('30 9 * * *');
      expect(created.recurrence).toEqual({
        frequency: 'day',
        interval: 1,
        schedule: { hours: [9], minutes: [30] },
      });
      // THE LIVE-PRODUCER PROOF: the POST's `scheduler.sync()` armed a durable
      // schedule_tick against the DERIVED cron — a recurrence trigger fires on
      // schedule through the exact S5a chain, no new firing path.
      const ticks = scheduleTicksFor(app, created.id);
      expect(ticks).toHaveLength(1);
      expect((ticks[0]!.ref as { schedule: string }).schedule).toBe('30 9 * * *');
    });

    it('re-derives the cron and re-seeds the tick when the recurrence is patched', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: {
          ...triggerBody(pipelineVersionId),
          schedule: null,
          recurrence: { frequency: 'day', schedule: { hours: [9] } },
        },
      });
      const id = create.json().id;

      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/triggers/${id}`,
        payload: { recurrence: { frequency: 'week', schedule: { weekDays: [1], hours: [8] } } },
      });
      expect(patch.statusCode).toBe(200);
      expect(patch.json().schedule).toBe('0 8 * * 1');

      const ticks = scheduleTicksFor(app, id);
      expect(ticks).toHaveLength(1);
      expect((ticks[0]!.ref as { schedule: string }).schedule).toBe('0 8 * * 1');
    });

    it('rejects a recurrence on a non-schedule trigger (400)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: {
          ...triggerBody(pipelineVersionId),
          mode: 'manual',
          schedule: null,
          recurrence: { frequency: 'day' },
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects authoring both a recurrence AND a raw cron schedule (400)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: {
          ...triggerBody(pipelineVersionId),
          schedule: '0 0 * * *',
          recurrence: { frequency: 'day' },
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('PATCH rejects adding a recurrence to a non-schedule (manual) trigger (400, effective mode)', async () => {
      // The consistency guard is REUSED on PATCH against the EFFECTIVE mode — a
      // manual trigger patched with only a recurrence (mode untouched) is refused.
      const create = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: { ...triggerBody(pipelineVersionId), mode: 'manual', schedule: null },
      });
      const id = create.json().id;
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/triggers/${id}`,
        payload: { recurrence: { frequency: 'day' } },
      });
      expect(res.statusCode).toBe(400);
    });

    it('PATCH rejects a raw cron schedule on an existing recurrence trigger (400, effective recurrence)', async () => {
      // Existing recurrence trigger; a PATCH that adds a raw cron `schedule`
      // (recurrence untouched, still live) is refused — `schedule` is derived.
      const create = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: {
          ...triggerBody(pipelineVersionId),
          schedule: null,
          recurrence: { frequency: 'day', schedule: { hours: [9] } },
        },
      });
      const id = create.json().id;
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/triggers/${id}`,
        payload: { schedule: '0 0 * * *' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('PATCH rejects supplying BOTH a new recurrence AND a raw cron in one request (400)', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: { ...triggerBody(pipelineVersionId), schedule: '0 2 * * *' },
      });
      const id = create.json().id;
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/triggers/${id}`,
        payload: { schedule: '0 0 * * *', recurrence: { frequency: 'day' } },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects interval > 1 WITHOUT a startTime anchor (#550) with a helpful message', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: {
          ...triggerBody(pipelineVersionId),
          schedule: null,
          recurrence: { frequency: 'day', interval: 2 },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json())).toContain('#550');
    });

    it('accepts interval > 1 WITH a startTime anchor (#550 every-N-period) and derives the base cron', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: {
          ...triggerBody(pipelineVersionId),
          schedule: null,
          recurrence: {
            frequency: 'day',
            interval: 2,
            schedule: { hours: [9] },
            startTime: '2026-08-01T00:00:00Z',
          },
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      // The derived cron carries only the within-period pattern; interval gates fires.
      expect(body.schedule).toBe('0 9 * * *');
      expect(body.recurrence.interval).toBe(2);
    });

    // #5 S5b-2 (#549) — bounds authoring.
    it('creates a bounded recurrence: bounds round-trip and the seeded tick carries them', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: {
          ...triggerBody(pipelineVersionId),
          schedule: null,
          recurrence: {
            frequency: 'day',
            schedule: { hours: [9] },
            startTime: '2026-08-01T00:00:00Z',
            endTime: '2026-08-31T00:00:00Z',
          },
        },
      });
      expect(res.statusCode).toBe(201);
      const created = res.json();
      expect(created.schedule).toBe('0 9 * * *');
      expect(created.recurrence).toEqual({
        frequency: 'day',
        interval: 1,
        schedule: { hours: [9] },
        startTime: '2026-08-01T00:00:00Z',
        endTime: '2026-08-31T00:00:00Z',
      });
      // The seeded tick carries the bounds in its ref (so a later bounds edit is
      // detectable) and is armed for the first in-window slot (Aug 1 09:00).
      const ticks = scheduleTicksFor(app, created.id);
      expect(ticks).toHaveLength(1);
      expect(ticks[0]!.ref).toMatchObject({
        schedule: '0 9 * * *',
        startTime: '2026-08-01T00:00:00Z',
        endTime: '2026-08-31T00:00:00Z',
      });
      expect(ticks[0]!.dueAt).toBe(Date.parse('2026-08-01T09:00:00.000Z'));
    });

    it('rejects an inverted/empty window (endTime <= startTime) with 400 (#549)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: {
          ...triggerBody(pipelineVersionId),
          schedule: null,
          recurrence: {
            frequency: 'day',
            startTime: '2026-08-31T00:00:00Z',
            endTime: '2026-08-01T00:00:00Z',
          },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json())).toContain('endTime');
    });

    it('rejects a non-UTC (offset) bound datetime with 400 (#549)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: {
          ...triggerBody(pipelineVersionId),
          schedule: null,
          recurrence: { frequency: 'day', startTime: '2026-08-01T00:00:00+02:00' },
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
