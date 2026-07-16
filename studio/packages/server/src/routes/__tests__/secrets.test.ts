import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../../__tests__/build-test-app.js';

describe('secrets routes (item 7 / S1 — the standalone secret SOURCE)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST creates a standalone secret; the response is the public projection — no plaintext, ciphertext, or ref', async () => {
    const plaintext = 'sk-super-secret-plaintext';
    const res = await app.inject({
      method: 'POST',
      url: '/api/secrets',
      payload: { name: 'stripe-key', secret: plaintext },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe('stripe-key');
    expect(body.ownerId).toBe('local');
    expect(body.id).toMatch(/^sec_/);
    expect(body).not.toHaveProperty('secret');
    expect(body).not.toHaveProperty('ciphertext');
    expect(body).not.toHaveProperty('ref');
    expect(JSON.stringify(body)).not.toContain(plaintext);
  });

  it('GET lists the owner’s standalone secrets as public projections only', async () => {
    const app2 = await buildTestApp();
    try {
      await app2.inject({
        method: 'POST',
        url: '/api/secrets',
        payload: { name: 'one', secret: 'p1' },
      });
      await app2.inject({
        method: 'POST',
        url: '/api/secrets',
        payload: { name: 'two', secret: 'p2' },
      });
      const listRes = await app2.inject({ method: 'GET', url: '/api/secrets' });
      expect(listRes.statusCode).toBe(200);
      const list = listRes.json();
      expect(list.map((s: { name: string }) => s.name).sort()).toEqual(['one', 'two']);
      for (const s of list) {
        expect(s).not.toHaveProperty('ciphertext');
        expect(s).not.toHaveProperty('ref');
      }
    } finally {
      await app2.close();
    }
  });

  it('a connection-owned secret never appears in GET /api/secrets', async () => {
    const app2 = await buildTestApp();
    try {
      // Minting a connection with a plaintext secret creates a connection-owned
      // (name/owner null) `secrets` row — it must stay invisible to this API.
      const connRes = await app2.inject({
        method: 'POST',
        url: '/api/connections',
        payload: { name: 'keyed', kind: 'anthropic_api', config: {}, secret: 'conn-plaintext' },
      });
      expect(connRes.statusCode).toBe(201);
      const listRes = await app2.inject({ method: 'GET', url: '/api/secrets' });
      expect(listRes.json()).toEqual([]);
    } finally {
      await app2.close();
    }
  });

  it('a duplicate (owner, name) is a 409 conflict', async () => {
    const app2 = await buildTestApp();
    try {
      const first = await app2.inject({
        method: 'POST',
        url: '/api/secrets',
        payload: { name: 'dup', secret: 'p1' },
      });
      expect(first.statusCode).toBe(201);
      const second = await app2.inject({
        method: 'POST',
        url: '/api/secrets',
        payload: { name: 'dup', secret: 'p2' },
      });
      expect(second.statusCode).toBe(409);
    } finally {
      await app2.close();
    }
  });

  it('an empty name / missing secret is a 400 at the boundary', async () => {
    const app2 = await buildTestApp();
    try {
      const emptyName = await app2.inject({
        method: 'POST',
        url: '/api/secrets',
        payload: { name: '', secret: 'p' },
      });
      expect(emptyName.statusCode).toBe(400);
      const noSecret = await app2.inject({
        method: 'POST',
        url: '/api/secrets',
        payload: { name: 'x' },
      });
      expect(noSecret.statusCode).toBe(400);
    } finally {
      await app2.close();
    }
  });

  it('DELETE removes a standalone secret; a second GET no longer lists it', async () => {
    const app2 = await buildTestApp();
    try {
      const created = (
        await app2.inject({
          method: 'POST',
          url: '/api/secrets',
          payload: { name: 'to-delete', secret: 'p' },
        })
      ).json();
      const delRes = await app2.inject({ method: 'DELETE', url: `/api/secrets/${created.id}` });
      expect(delRes.statusCode).toBe(204);
      const listRes = await app2.inject({ method: 'GET', url: '/api/secrets' });
      expect(listRes.json()).toEqual([]);
      // Deleting again is a 404 (gone == not-owned, indistinguishable).
      const delAgain = await app2.inject({ method: 'DELETE', url: `/api/secrets/${created.id}` });
      expect(delAgain.statusCode).toBe(404);
    } finally {
      await app2.close();
    }
  });

  it('DELETE of an unknown id is a 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/secrets/sec_missing' });
    expect(res.statusCode).toBe(404);
  });
});
