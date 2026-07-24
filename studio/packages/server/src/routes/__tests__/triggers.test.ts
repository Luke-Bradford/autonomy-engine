import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION, type NewTrigger } from '@autonomy-studio/shared';
import {
  archivePipelineRow,
  createPipeline,
  createPipelineVersion,
  createTrigger,
  createWorkspaceGit,
} from '../../repo/index.js';
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

    it('#3 G5a — refuses to manually fire a trigger bound to an ARCHIVED pipeline: 409 conflict', async () => {
      // Own pipeline + version + trigger, then archive the pipeline row (trigger
      // stays enabled) so the manual fire hits the launcher's dispatch guard.
      const ownPipeline = createPipeline(app.db, { ownerId: 'local', name: 'ArchivedForFire' });
      const ownVersion = createPipelineVersion(app.db, {
        pipelineId: ownPipeline.id,
        params: [],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: CATALOG_VERSION,
      });
      const created = (
        await app.inject({
          method: 'POST',
          url: '/api/triggers',
          payload: triggerBody(ownVersion.id),
        })
      ).json();
      archivePipelineRow(app.db, ownPipeline.id);

      const fireRes = await app.inject({ method: 'POST', url: `/api/triggers/${created.id}/fire` });
      expect(fireRes.statusCode).toBe(409);
      expect(fireRes.json().error).toBe('conflict');
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

  describe('#5 S8 — event-config cross-field rules (effective state)', () => {
    function eventBody(overrides: Record<string, unknown> = {}) {
      return {
        ...triggerBody(pipelineVersionId),
        mode: 'event' as const,
        schedule: null,
        event: { name: 'order.created' },
        ...overrides,
      };
    }

    it('creates an event trigger with a subscription', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/triggers', payload: eventBody() });
      expect(res.statusCode).toBe(201);
      expect(res.json().event).toEqual({ name: 'order.created' });
    });

    it('rejects an event config on a non-event trigger (400)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: { ...triggerBody(pipelineVersionId), event: { name: 'order.created' } },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects ENABLING an event trigger with no subscription (unsubscribable-but-enabled)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: eventBody({ event: null, enabled: true }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('accepts a DISABLED event trigger with no subscription (a draft / pre-S8 row shape)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: eventBody({ event: null, enabled: false }),
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().event).toBeNull();
    });

    it('PATCH guards the EFFECTIVE state: clearing the subscription on an enabled event trigger is refused', async () => {
      const created = (
        await app.inject({ method: 'POST', url: '/api/triggers', payload: eventBody() })
      ).json();
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/triggers/${created.id}`,
        payload: { event: null },
      });
      expect(res.statusCode).toBe(400);
      // Disable + clear together is fine.
      const ok = await app.inject({
        method: 'PATCH',
        url: `/api/triggers/${created.id}`,
        payload: { event: null, enabled: false },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().event).toBeNull();
    });

    it('PATCH guards the EFFECTIVE state: switching mode away from event keeps a live subscription refused', async () => {
      const created = (
        await app.inject({ method: 'POST', url: '/api/triggers', payload: eventBody() })
      ).json();
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/triggers/${created.id}`,
        payload: { mode: 'manual' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('an unrelated PATCH leaves an existing subscription untouched (no .partial() clobber)', async () => {
      const created = (
        await app.inject({ method: 'POST', url: '/api/triggers', payload: eventBody() })
      ).json();
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/triggers/${created.id}`,
        payload: { name: 'Renamed' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().event).toEqual({ name: 'order.created' });
    });
  });

  describe('#5 S9 — window-config cross-field rules (effective state)', () => {
    const window = {
      frequency: 'minute' as const,
      interval: 15,
      startTime: '2026-07-01T00:00:00.000Z',
    };
    function tumblingBody(overrides: Record<string, unknown> = {}) {
      return {
        ...triggerBody(pipelineVersionId),
        mode: 'tumbling' as const,
        schedule: null,
        window,
        concurrency: { policy: 'queue' as const },
        ...overrides,
      };
    }

    it('creates a tumbling trigger with a window config', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: tumblingBody(),
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().window).toEqual(window);
      expect(res.json().mode).toBe('tumbling');
    });

    it('rejects a window config on a non-tumbling trigger (400)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: { ...triggerBody(pipelineVersionId), window },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects ENABLING a tumbling trigger with no window (windowless-but-enabled)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: tumblingBody({ window: null, enabled: true }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('accepts a DISABLED tumbling trigger with no window (a draft)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: tumblingBody({ window: null, enabled: false }),
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().window).toBeNull();
    });

    it('accepts `maxConcurrentWindows` and round-trips it; a PATCH cap-raise lands (#5 S11a)', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: tumblingBody({ window: { ...window, maxConcurrentWindows: 2 } }),
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().window.maxConcurrentWindows).toBe(2);

      // The cap-raise edit path: the route re-validates the merged window and
      // its trailing `scheduler.sync()` is what kicks the freed capacity (the
      // materialize kick itself is pinned in scheduler/__tests__/tumbling.ts).
      const raised = await app.inject({
        method: 'PATCH',
        url: `/api/triggers/${created.json().id}`,
        payload: { window: { ...window, maxConcurrentWindows: 5 } },
      });
      expect(raised.statusCode).toBe(200);
      expect(raised.json().window.maxConcurrentWindows).toBe(5);
    });

    it('rejects `maxConcurrentWindows` above the write cap of 50 (#5 S11a)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: tumblingBody({ window: { ...window, maxConcurrentWindows: 51 } }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a non-'queue' concurrency policy on a tumbling trigger (v1 — skip would strand a window)", async () => {
      const skip = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: tumblingBody({ concurrency: { policy: 'skip_if_running' } }),
      });
      expect(skip.statusCode).toBe(400);
      const parallel = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: tumblingBody({ concurrency: { policy: 'parallel', max: 3 } }),
      });
      expect(parallel.statusCode).toBe(400);
    });

    it('rejects a window whose endTime is not after startTime (shared write rule)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: tumblingBody({ window: { ...window, endTime: '2026-06-01T00:00:00.000Z' } }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('PATCH guards the EFFECTIVE state: clearing the window on an enabled tumbling trigger is refused', async () => {
      const created = (
        await app.inject({ method: 'POST', url: '/api/triggers', payload: tumblingBody() })
      ).json();
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/triggers/${created.id}`,
        payload: { window: null },
      });
      expect(res.statusCode).toBe(400);
      const ok = await app.inject({
        method: 'PATCH',
        url: `/api/triggers/${created.id}`,
        payload: { window: null, enabled: false },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().window).toBeNull();
    });

    it('PATCH guards the EFFECTIVE state: a policy edit away from queue on a tumbling trigger is refused', async () => {
      const created = (
        await app.inject({ method: 'POST', url: '/api/triggers', payload: tumblingBody() })
      ).json();
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/triggers/${created.id}`,
        payload: { concurrency: { policy: 'skip_if_running' } },
      });
      expect(res.statusCode).toBe(400);
    });

    it('an unrelated PATCH leaves an existing window untouched (no .partial() clobber)', async () => {
      const created = (
        await app.inject({ method: 'POST', url: '/api/triggers', payload: tumblingBody() })
      ).json();
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/triggers/${created.id}`,
        payload: { name: 'Renamed' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().window).toEqual(window);
    });

    // #5 S11b — `${trigger.windowStart/End}` bindings are MODE-scoped
    // (cross-field, effective state): legal only on a tumbling trigger.
    describe('#5 S11b — window-field bindings (mode-scoped, effective state)', () => {
      const windowBindings = {
        ws: '${trigger.windowStart}',
        we: '${trigger.windowEnd}',
      };

      it('accepts window-field bindings on a tumbling trigger', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/triggers',
          payload: tumblingBody({ params: windowBindings }),
        });
        expect(res.statusCode).toBe(201);
        expect(res.json().params).toEqual(windowBindings);
      });

      it('rejects window-field bindings on a schedule trigger (400, mode-scoped)', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/triggers',
          payload: {
            ...triggerBody(pipelineVersionId),
            mode: 'schedule' as const,
            schedule: '*/5 * * * *',
            params: { ws: '${trigger.windowStart}' },
          },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toMatch(/tumbling/);
      });

      it('PATCH guards the EFFECTIVE state: a mode switch away from tumbling with window bindings is refused', async () => {
        const created = (
          await app.inject({
            method: 'POST',
            url: '/api/triggers',
            payload: tumblingBody({ params: windowBindings, enabled: false }),
          })
        ).json();
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/triggers/${created.id}`,
          payload: { mode: 'manual', window: null },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toMatch(/tumbling/);
      });

      it('PATCH can leave tumbling by ALSO dropping the window bindings', async () => {
        const created = (
          await app.inject({
            method: 'POST',
            url: '/api/triggers',
            payload: tumblingBody({ params: windowBindings, enabled: false }),
          })
        ).json();
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/triggers/${created.id}`,
          payload: { mode: 'manual', window: null, params: {} },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().mode).toBe('manual');
      });
    });
  });
});

/**
 * #3 G6c-2 — resolve-once "bind to active" on trigger CREATION. A trigger always
 * stores a CONCRETE `pipelineVersionId` (#1 immutability; "unbound never fires"),
 * so "bind to active" is a creation-time convenience that resolves ONCE and
 * stores the resolved id — never a live-follow binding. Resolution: git-mode
 * (a repo connected) → the `active` published version (the G6c-1 projection);
 * DB-only (the default, git-optional) → the LATEST immutable version. PATCH is
 * unchanged (concrete-only). Non-goals here: fire-time `follow_active`, G7
 * readiness-reconcile, any archived-pipeline create-time guard (fire-time
 * `ArchivedPipelineError` owns that, as it does for a concrete bind).
 */
describe('triggers routes — bind-to-active (#3 G6c-2)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  /** Put the owner in git mode (a connected repo) — see pipelines-publish.test. */
  function connectRepo() {
    return createWorkspaceGit(app.db, {
      ownerId: 'local',
      repoUrl: 'https://example.com/repo.git',
      collabBranch: 'main',
      observedCollabHead: 'deadbeef',
      lastFetchAt: Date.now(),
      lastFetchError: null,
    });
  }

  function plainVersion(pipelineId: string) {
    return createPipelineVersion(app.db, {
      pipelineId,
      params: [],
      outputs: [],
      nodes: [],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
  }

  /** A version WITH git provenance — the only kind CAS Publish accepts. */
  function gitVersion(pipelineId: string, commit: string, blob: string) {
    return createPipelineVersion(
      app.db,
      {
        pipelineId,
        params: [],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: CATALOG_VERSION,
      },
      {
        sourceCommit: commit,
        sourceBranch: 'main',
        sourceFilePath: 'pipelines/p.json',
        sourceBlobSha: blob,
      },
    );
  }

  /** A trigger create body with NO binding field (neither concrete nor bind). */
  function bodyWithoutBinding(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Nightly',
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

  /** A create body that binds-to-active instead of a concrete version. */
  function bindBody(pipelineId: string, overrides: Record<string, unknown> = {}) {
    return { ...bodyWithoutBinding(overrides), bindToActive: { pipelineId } };
  }

  const create = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/triggers', payload });

  const publish = (pipelineId: string, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/pipelines/${pipelineId}/publish`, payload: body });

  it('DB-only: resolves to the LATEST version and stores it concretely', async () => {
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    const v1 = plainVersion(pipeline.id);

    const res = await create(bindBody(pipeline.id));
    expect(res.statusCode).toBe(201);
    expect(res.json().pipelineVersionId).toBe(v1.id);
  });

  it('DB-only: resolve-once — a new trigger binds the newer latest; the earlier trigger keeps its pin', async () => {
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    const v1 = plainVersion(pipeline.id);

    const first = (await create(bindBody(pipeline.id))).json();
    expect(first.pipelineVersionId).toBe(v1.id);

    const v2 = plainVersion(pipeline.id);
    const second = (await create(bindBody(pipeline.id, { name: 'Later' }))).json();
    expect(second.pipelineVersionId).toBe(v2.id);

    // Resolve-once: the earlier trigger's immutable pin is untouched.
    const stillFirst = await app.inject({ method: 'GET', url: `/api/triggers/${first.id}` });
    expect(stillFirst.json().pipelineVersionId).toBe(v1.id);
  });

  it('git-mode: resolves to the ACTIVE published version, NOT the latest', async () => {
    connectRepo();
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    const v1 = gitVersion(pipeline.id, 'commit1', 'blob1');
    // Publish v1 → active pointer = v1.
    const pub = await publish(pipeline.id, { toVersionId: v1.id, expectedActiveVersionId: null });
    expect(pub.statusCode).toBe(200);
    // Mint a NEWER version — latest is now v2, but active is still v1.
    const v2 = gitVersion(pipeline.id, 'commit2', 'blob2');

    const res = await create(bindBody(pipeline.id));
    expect(res.statusCode).toBe(201);
    expect(res.json().pipelineVersionId).toBe(v1.id);
    expect(res.json().pipelineVersionId).not.toBe(v2.id);
  });

  it('git-mode with NO active published version: refuses (400)', async () => {
    connectRepo();
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    gitVersion(pipeline.id, 'commit1', 'blob1'); // exists but never published

    const res = await create(bindBody(pipeline.id));
    expect(res.statusCode).toBe(400);
  });

  it('DB-only with a versionless pipeline: refuses (400)', async () => {
    // `createPipeline` mints NO initial version — a pipeline can exist with zero
    // versions, so "bind to latest" has nothing to resolve. Fail closed (400),
    // never silently birth an unbound trigger.
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'P' });

    const res = await create(bindBody(pipeline.id));
    expect(res.statusCode).toBe(400);
  });

  it('rejects supplying BOTH bindToActive and pipelineVersionId (400)', async () => {
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    const v1 = plainVersion(pipeline.id);

    const res = await create({ ...bindBody(pipeline.id), pipelineVersionId: v1.id });
    expect(res.statusCode).toBe(400);
  });

  it('rejects supplying NEITHER bindToActive nor pipelineVersionId (400)', async () => {
    const res = await create(bodyWithoutBinding());
    expect(res.statusCode).toBe(400);
  });

  it('still accepts an explicit pipelineVersionId:null unbound create (presence, not truthiness)', async () => {
    const res = await create(bodyWithoutBinding({ pipelineVersionId: null, enabled: false }));
    expect(res.statusCode).toBe(201);
    expect(res.json().pipelineVersionId).toBeNull();
  });

  it('a missing / foreign-owned pipeline surfaces as 404, never a bind', async () => {
    const missing = await create(bindBody('pipe_does_not_exist'));
    expect(missing.statusCode).toBe(404);

    const foreign = createPipeline(app.db, { ownerId: 'someone-else', name: 'Theirs' });
    plainVersion(foreign.id);
    const res = await create(bindBody(foreign.id));
    expect(res.statusCode).toBe(404);
  });

  it('a resolved concrete binding lets the trigger be created enabled', async () => {
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    plainVersion(pipeline.id);

    const res = await create(bindBody(pipeline.id, { enabled: true }));
    expect(res.statusCode).toBe(201);
    expect(res.json().enabled).toBe(true);
  });
});
