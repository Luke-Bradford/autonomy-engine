import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION, type NewTrigger } from '@autonomy-studio/shared';
import { createPipeline, createPipelineVersion, createTrigger } from '../../repo/index.js';
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
});
