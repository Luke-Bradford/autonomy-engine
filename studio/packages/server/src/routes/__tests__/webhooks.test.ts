import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION } from '@autonomy-studio/shared';
import { createPipeline, createPipelineVersion, listRuns } from '../../repo/index.js';
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
