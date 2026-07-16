import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createConnection, getConnection, getSecretByRef, listSecrets } from '../../repo/index.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';

describe('connections routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('full CRUD round-trip, owner-scoped', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/connections',
      payload: { name: 'My Claude key', kind: 'anthropic_api', config: { model: 'claude-sonnet' } },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.name).toBe('My Claude key');
    expect(created.ownerId).toBe('local');
    expect(created).not.toHaveProperty('secretRef');

    const getRes = await app.inject({ method: 'GET', url: `/api/connections/${created.id}` });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json()).toEqual(created);

    const listRes = await app.inject({ method: 'GET', url: '/api/connections' });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().items.map((c: { id: string }) => c.id)).toContain(created.id);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/connections/${created.id}`,
      payload: { name: 'Renamed key' },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().name).toBe('Renamed key');

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/connections/${created.id}`,
    });
    expect(deleteRes.statusCode).toBe(204);

    const missingRes = await app.inject({ method: 'GET', url: `/api/connections/${created.id}` });
    expect(missingRes.statusCode).toBe(404);
  });

  it('POST with a plaintext secret never returns it, and stores an encrypted row', async () => {
    const plaintext = 'sk-super-secret-plaintext';
    const res = await app.inject({
      method: 'POST',
      url: '/api/connections',
      payload: { name: 'Keyed connection', kind: 'anthropic_api', config: {}, secret: plaintext },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).not.toHaveProperty('secret');
    expect(body).not.toHaveProperty('secretRef');
    expect(JSON.stringify(body)).not.toContain(plaintext);

    const getRes = await app.inject({ method: 'GET', url: `/api/connections/${body.id}` });
    expect(JSON.stringify(getRes.json())).not.toContain(plaintext);
    expect(getRes.json()).not.toHaveProperty('secretRef');

    // Reach into the DB directly (test-only, via `app.db`) to prove a
    // `secrets` row really exists with ciphertext that is NOT the plaintext.
    const internal = getConnection(app.db, body.id);
    expect(internal?.secretRef).toBeTruthy();
    const secretRow = getSecretByRef(app.db, internal!.secretRef!);
    expect(secretRow).not.toBeNull();
    expect(secretRow!.ciphertext).not.toBe(plaintext);
    expect(listSecrets(app.db).some((s) => s.ciphertext === plaintext)).toBe(false);
  });

  it('rotating a connection secret keeps the same secretRef (in-place ciphertext rotation)', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/connections',
      payload: { name: 'Rotating', kind: 'anthropic_api', config: {}, secret: 'first-secret' },
    });
    const created = createRes.json();
    const before = getConnection(app.db, created.id);
    expect(before?.secretRef).toBeTruthy();

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/connections/${created.id}`,
      payload: { secret: 'second-secret' },
    });
    expect(patchRes.statusCode).toBe(200);

    const after = getConnection(app.db, created.id);
    expect(after?.secretRef).toBe(before?.secretRef);
    const secretRow = getSecretByRef(app.db, after!.secretRef!);
    expect(secretRow?.ciphertext).not.toBe('second-secret');
    expect(secretRow?.ciphertext).not.toBe('first-secret');
  });

  it('deleting a connection deletes its secret too (no orphan, RESTRICT respected)', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/connections',
      payload: { name: 'ToDelete', kind: 'anthropic_api', config: {}, secret: 'delete-me' },
    });
    const created = createRes.json();
    const internal = getConnection(app.db, created.id);
    const ref = internal!.secretRef!;
    expect(getSecretByRef(app.db, ref)).not.toBeNull();

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/connections/${created.id}`,
    });
    expect(deleteRes.statusCode).toBe(204);

    expect(getSecretByRef(app.db, ref)).toBeNull();
  });

  it('owner scoping: a row belonging to a different owner is filtered from list and 404s on get', async () => {
    const other = createConnection(app.db, {
      ownerId: 'someone-else',
      name: 'Not mine',
      kind: 'http',
      config: {},
      secretRef: null,
    });

    const listRes = await app.inject({ method: 'GET', url: '/api/connections' });
    expect(listRes.json().items.map((c: { id: string }) => c.id)).not.toContain(other.id);

    const getRes = await app.inject({ method: 'GET', url: `/api/connections/${other.id}` });
    expect(getRes.statusCode).toBe(404);
  });

  it('validation: a bad body returns 400 with a structured error, no stack trace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/connections',
      payload: { name: '', kind: 'not_a_real_kind', config: {} },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('validation_error');
    expect(Array.isArray(body.issues)).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/\.ts:\d+/);
  });

  it('404 for a missing connection', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/connections/conn_does_not_exist',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });
});
