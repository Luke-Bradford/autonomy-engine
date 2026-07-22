import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION } from '@autonomy-studio/shared';
import { createPipeline, createPipelineVersion, listRuns } from '../../repo/index.js';
import { loadEngineEvents } from '../../run/events.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';
import { signWebhook } from '../../webhooks/verify.js';

/**
 * P4c — the webhook firing endpoint end-to-end (real app, real HMAC, real
 * launcher). Each test provisions a REAL secret through the provisioning route
 * (so the whole chain — mint → encrypt → store → resolve → verify — is
 * exercised) and signs requests exactly as an external caller would.
 */
describe('webhook routes', () => {
  let app: FastifyInstance;
  let pipelineVersionId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'For webhooks' });
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

  function webhookTriggerBody(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Hooked',
      pipelineVersionId,
      params: {},
      mode: 'webhook' as const,
      schedule: null,
      webhook: null,
      concurrency: { policy: 'parallel' as const, max: 5 },
      runWindows: null,
      enabled: true,
      ...overrides,
    };
  }

  /** Create a webhook trigger and provision its secret; returns id + secret. */
  async function makeWebhookTrigger(
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; secret: string }> {
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: webhookTriggerBody(overrides),
      })
    ).json();
    const secretRes = await app.inject({
      method: 'POST',
      url: `/api/triggers/${created.id}/webhook-secret`,
    });
    expect(secretRes.statusCode).toBe(200);
    return { id: created.id, secret: secretRes.json().secret as string };
  }

  function signedRequest(
    id: string,
    secret: string,
    opts: { body?: string; tsSec?: number; idempotencyKey?: string } = {},
  ) {
    const body = opts.body ?? JSON.stringify({ event: 'ping' });
    const tsSec = opts.tsSec ?? Math.floor(Date.now() / 1000);
    const signature = signWebhook(secret, String(tsSec), Buffer.from(body, 'utf8'));
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-webhook-timestamp': String(tsSec),
      'x-webhook-signature': signature,
    };
    if (opts.idempotencyKey) headers['x-webhook-idempotency-key'] = opts.idempotencyKey;
    return { method: 'POST' as const, url: `/api/webhooks/${id}`, headers, payload: body };
  }

  it('provisioning returns a one-time secret + delivery URL', async () => {
    const created = (
      await app.inject({ method: 'POST', url: '/api/triggers', payload: webhookTriggerBody() })
    ).json();
    const res = await app.inject({
      method: 'POST',
      url: `/api/triggers/${created.id}/webhook-secret`,
    });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().secret).toBe('string');
    expect(res.json().secret.length).toBeGreaterThan(20);
    expect(res.json().deliveryUrl).toBe(`/api/webhooks/${created.id}`);
    // The trigger projection NEVER reveals the secretRef.
    const view = (await app.inject({ method: 'GET', url: `/api/triggers/${created.id}` })).json();
    expect(view.webhook).not.toHaveProperty('secretRef');
  });

  it('provisioning is refused on a non-webhook trigger (400)', async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: { ...webhookTriggerBody(), mode: 'schedule', schedule: '0 2 * * *' },
      })
    ).json();
    const res = await app.inject({
      method: 'POST',
      url: `/api/triggers/${created.id}/webhook-secret`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('a correctly-signed delivery fires a run end-to-end', async () => {
    const { id, secret } = await makeWebhookTrigger();
    const res = await app.inject(signedRequest(id, secret));
    expect(res.statusCode).toBe(202);
    expect(res.json().outcome).toBe('started');
    const runId = res.json().runId;
    expect(runId).toBeDefined();

    await app.runLauncher.whenIdle();
    const run = (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json();
    expect(run.status).toBe('success');
    expect(run.triggerId).toBe(id);
  });

  // #5 S8 — the webhook body is the FIRST production feeder of
  // `run.triggerContext.body` (S12a plumbed the seam; pre-S8 fires carried null).
  describe('#5 S8 — the delivery body seeds ${trigger.body}', () => {
    function triggerContextOf(runId: string) {
      const seed = loadEngineEvents(app.db, runId).find((e) => e.type === 'run.triggerContext');
      if (seed?.type !== 'run.triggerContext') throw new Error(`no trigger seed for ${runId}`);
      return seed;
    }

    it('a JSON delivery body lands parsed in run.triggerContext.body and resolves ${trigger.body.x} bindings', async () => {
      // A version that DECLARES the param the binding feeds (an undeclared
      // override is refused by resolveRunParams).
      const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'With param' });
      const version = createPipelineVersion(app.db, {
        pipelineId: pipeline.id,
        params: [{ name: 'who', type: 'string', required: false, default: 'nobody' }],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: CATALOG_VERSION,
      });
      const { id, secret } = await makeWebhookTrigger({
        pipelineVersionId: version.id,
        params: { who: '${trigger.body.user}' },
      });
      const res = await app.inject(
        signedRequest(id, secret, { body: JSON.stringify({ user: 'ada', n: 2 }) }),
      );
      expect(res.json().outcome).toBe('started');
      const runId = res.json().runId as string;
      await app.runLauncher.whenIdle();

      expect(triggerContextOf(runId).body).toEqual({ user: 'ada', n: 2 });
      const started = loadEngineEvents(app.db, runId).find((e) => e.type === 'run.started');
      if (started?.type !== 'run.started') throw new Error('no run.started');
      expect(started.params.who).toBe('ada');
    });

    it('an unparseable (non-JSON) body seeds the raw string — honest, and deep-addresses fail safe', async () => {
      const { id, secret } = await makeWebhookTrigger();
      const res = await app.inject(signedRequest(id, secret, { body: 'plain text, not json' }));
      expect(res.json().outcome).toBe('started');
      await app.runLauncher.whenIdle();
      expect(triggerContextOf(res.json().runId as string).body).toBe('plain text, not json');
    });

    it('an empty body seeds nothing (the durable event omits `body`; it folds to null on read)', async () => {
      const { id, secret } = await makeWebhookTrigger();
      const res = await app.inject(signedRequest(id, secret, { body: '' }));
      expect(res.json().outcome).toBe('started');
      await app.runLauncher.whenIdle();
      // The seed event's omitted-when-null contract (driver.ts): no manufactured
      // value lands in the log; `RunState.triggerContext.body` folds to null.
      expect('body' in triggerContextOf(res.json().runId as string)).toBe(false);
    });

    it('a non-finite JSON number (1e999 → Infinity) is refused as a recorded skip, never persisted (#547)', async () => {
      const { id, secret } = await makeWebhookTrigger();
      const key = 'evt-nonfinite';
      const res = await app.inject(
        signedRequest(id, secret, { body: '{"x":1e999}', idempotencyKey: key }),
      );
      expect(res.statusCode).toBe(202);
      expect(res.json().outcome).toBe('skipped');
      expect(listRuns(app.db, { triggerId: id })).toHaveLength(0);
      // Recorded — the verbatim retry dedupes rather than re-throwing in a storm.
      const retry = await app.inject(
        signedRequest(id, secret, { body: '{"x":1e999}', idempotencyKey: key }),
      );
      expect(retry.json().outcome).toBe('duplicate');
    });
  });

  it('rejects a bad signature (401) and does NOT fire', async () => {
    const { id } = await makeWebhookTrigger();
    const res = await app.inject(signedRequest(id, 'not-the-real-secret'));
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('webhook signature verification failed');
    expect(listRuns(app.db, { triggerId: id })).toHaveLength(0);
  });

  it('rejects a tampered body (signature computed over different bytes)', async () => {
    const { id, secret } = await makeWebhookTrigger();
    const req = signedRequest(id, secret, { body: JSON.stringify({ event: 'ping' }) });
    req.payload = JSON.stringify({ event: 'TAMPERED' });
    const res = await app.inject(req);
    expect(res.statusCode).toBe(401);
    expect(listRuns(app.db, { triggerId: id })).toHaveLength(0);
  });

  it('rejects a stale timestamp (401 — replay window)', async () => {
    const { id, secret } = await makeWebhookTrigger();
    const staleSec = Math.floor(Date.now() / 1000) - 3600;
    const res = await app.inject(signedRequest(id, secret, { tsSec: staleSec }));
    expect(res.statusCode).toBe(401);
    expect(listRuns(app.db, { triggerId: id })).toHaveLength(0);
  });

  it('rejects when signature/timestamp headers are missing (401)', async () => {
    const { id } = await makeWebhookTrigger();
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/${id}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ event: 'ping' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a webhook trigger that has no secret provisioned yet (401)', async () => {
    const created = (
      await app.inject({ method: 'POST', url: '/api/triggers', payload: webhookTriggerBody() })
    ).json();
    // No /webhook-secret call — webhook is still null.
    const res = await app.inject(signedRequest(created.id, 'anything'));
    expect(res.statusCode).toBe(401);
  });

  it('404 for an unknown trigger id', async () => {
    const res = await app.inject(signedRequest('trig_missing', 'x'));
    expect(res.statusCode).toBe(404);
  });

  it('404 for a non-webhook-mode trigger (endpoint does not exist for it)', async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: { ...webhookTriggerBody(), mode: 'schedule', schedule: '0 2 * * *' },
      })
    ).json();
    const res = await app.inject(signedRequest(created.id, 'x'));
    expect(res.statusCode).toBe(404);
  });

  it('idempotency: a replayed identical delivery is served as duplicate, fired once', async () => {
    const { id, secret } = await makeWebhookTrigger();
    const tsSec = Math.floor(Date.now() / 1000);
    const req = signedRequest(id, secret, { tsSec });

    const first = await app.inject(req);
    expect(first.json().outcome).toBe('started');
    const second = await app.inject(req); // byte-identical replay
    expect(second.statusCode).toBe(202);
    expect(second.json().outcome).toBe('duplicate');

    await app.runLauncher.whenIdle();
    expect(listRuns(app.db, { triggerId: id })).toHaveLength(1);
  });

  it('idempotency: a caller-supplied key dedupes even across distinct payloads', async () => {
    const { id, secret } = await makeWebhookTrigger();
    const key = 'order-42';
    const a = await app.inject(
      signedRequest(id, secret, { body: JSON.stringify({ n: 1 }), idempotencyKey: key }),
    );
    expect(a.json().outcome).toBe('started');
    const b = await app.inject(
      signedRequest(id, secret, { body: JSON.stringify({ n: 2 }), idempotencyKey: key }),
    );
    expect(b.json().outcome).toBe('duplicate');
    await app.runLauncher.whenIdle();
    expect(listRuns(app.db, { triggerId: id })).toHaveLength(1);
  });

  it('a disabled trigger skips (no delivery recorded) — a later enable + retry fires', async () => {
    const { id, secret } = await makeWebhookTrigger({ enabled: false });
    const key = 'evt-1';
    const skipped = await app.inject(signedRequest(id, secret, { idempotencyKey: key }));
    expect(skipped.statusCode).toBe(202);
    expect(skipped.json().outcome).toBe('skipped');
    expect(skipped.json().reason).toBe('trigger disabled');
    expect(listRuns(app.db, { triggerId: id })).toHaveLength(0);

    // Enable, then retry the SAME idempotency key: the skip recorded nothing, so
    // it must fire now.
    await app.inject({ method: 'PATCH', url: `/api/triggers/${id}`, payload: { enabled: true } });
    const fired = await app.inject(signedRequest(id, secret, { idempotencyKey: key }));
    expect(fired.json().outcome).toBe('started');
    await app.runLauncher.whenIdle();
    expect(listRuns(app.db, { triggerId: id })).toHaveLength(1);
  });

  it('outside a run window: skips (automatic firing is window-gated)', async () => {
    // A window that never contains "now": a 1-minute window on a day offset.
    const { id, secret } = await makeWebhookTrigger({
      runWindows: [{ start: '00:00', end: '00:01', days: [] }],
    });
    const res = await app.inject(signedRequest(id, secret));
    expect(res.statusCode).toBe(202);
    expect(res.json().outcome).toBe('skipped');
    expect(res.json().reason).toBe('outside run window');
    expect(listRuns(app.db, { triggerId: id })).toHaveLength(0);
  });

  // #5 S12b — a trigger param binding that cannot resolve at fire time is a
  // PERMANENT config defect. It must be RECORDED as a skip (not released), so a
  // verbatim retry of the same key dedupes rather than re-firing in a storm.
  it('records a skip (no run, no retry storm) when a param binding cannot resolve', async () => {
    // `${trigger.body.k}` is save-VALID but deep-addresses a key the delivered
    // body (`{event:'ping'}`) does not carry — unresolvable for THIS fire.
    const { id, secret } = await makeWebhookTrigger({ params: { x: '${trigger.body.k}' } });
    const key = 'evt-bad-binding';

    const res = await app.inject(signedRequest(id, secret, { idempotencyKey: key }));
    expect(res.statusCode).toBe(202);
    expect(res.json().outcome).toBe('skipped');
    expect(res.json().reason).toMatch(/binding/);
    expect(listRuns(app.db, { triggerId: id })).toHaveLength(0);

    // The delivery WAS recorded — a byte-identical retry dedupes, never re-fires.
    const retry = await app.inject(signedRequest(id, secret, { idempotencyKey: key }));
    expect(retry.json().outcome).toBe('duplicate');
    expect(listRuns(app.db, { triggerId: id })).toHaveLength(0);
  });

  it('rotating the secret invalidates the old one', async () => {
    const { id, secret: oldSecret } = await makeWebhookTrigger();
    // Rotate.
    const rotated = await app.inject({
      method: 'POST',
      url: `/api/triggers/${id}/webhook-secret`,
    });
    const newSecret = rotated.json().secret as string;
    expect(newSecret).not.toBe(oldSecret);

    // Old secret no longer verifies.
    expect((await app.inject(signedRequest(id, oldSecret))).statusCode).toBe(401);
    // New secret does.
    expect((await app.inject(signedRequest(id, newSecret))).json().outcome).toBe('started');
    await app.runLauncher.whenIdle();
  });
});
