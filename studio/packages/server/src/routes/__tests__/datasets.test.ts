import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDataset, getDataset } from '../../repo/index.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';

const body = {
  name: 'Customers CSV',
  connectionId: 'conn_store',
  kind: 'delimited',
  config: { path: 'customers.csv', header: true },
  columns: [{ name: 'id', type: 'integer', nullable: false }],
};

describe('datasets routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('full CRUD round-trip, owner-scoped', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/datasets', payload: body });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.id).toMatch(/^ds_/);
    expect(created.resourceId).toMatch(/^res_/);
    expect(created.parameters).toEqual([]);

    const getRes = await app.inject({ method: 'GET', url: `/api/datasets/${created.id}` });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json()).toEqual(created);

    const listRes = await app.inject({ method: 'GET', url: '/api/datasets' });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().items.map((d: { id: string }) => d.id)).toContain(created.id);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/datasets/${created.id}`,
      payload: { name: 'Renamed' },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().name).toBe('Renamed');

    const deleteRes = await app.inject({ method: 'DELETE', url: `/api/datasets/${created.id}` });
    expect(deleteRes.statusCode).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: `/api/datasets/${created.id}` })).statusCode,
    ).toBe(404);
  });

  // The #473 / §2.2 contract at the HTTP boundary: a create with no `columns`
  // must be REFUSED, never silently accepted as an empty declared schema.
  it('refuses a create with no columns', async () => {
    const { columns, ...noColumns } = body;
    void columns;
    const res = await app.inject({ method: 'POST', url: '/api/datasets', payload: noColumns });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a column with no nullable', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/datasets',
      payload: { ...body, columns: [{ name: 'id', type: 'integer' }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses an unknown kind', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/datasets',
      payload: { ...body, kind: 'parquet' },
    });
    expect(res.statusCode).toBe(400);
  });

  // #2 L13b — the recorded Zod gotcha: `.default([])` applies even through
  // `.partial()`, so a PATCH that omits `parameters` must NOT reset the stored
  // allowlist. This is the failure that would permanently break every pipeline
  // bound to those parameters, and it is silent.
  it('a PATCH that omits parameters preserves the stored allowlist', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/datasets',
      payload: { ...body, parameters: ['path'] },
    });
    const created = createRes.json();
    expect(created.parameters).toEqual(['path']);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/datasets/${created.id}`,
      payload: { name: 'Just a rename' },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().parameters).toEqual(['path']);
    expect(getDataset(app.db, created.id)?.parameters).toEqual(['path']);
  });

  it('a client cannot stamp its own ownerId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/datasets',
      payload: { ...body, ownerId: 'someone_else' },
    });
    expect(res.statusCode).toBe(201);
    expect(getDataset(app.db, res.json().id)?.ownerId).not.toBe('someone_else');
  });

  it('owner scoping: another owner’s row is filtered from list and 404s on get', async () => {
    const other = createDataset(app.db, {
      ownerId: 'someone_else',
      name: 'Theirs',
      connectionId: 'conn_theirs',
      kind: 'table',
      config: { schema: 'public', table: 'x' },
      columns: [{ name: 'id', type: 'integer', nullable: false }],
    });

    const listRes = await app.inject({ method: 'GET', url: '/api/datasets' });
    expect(listRes.json().items.map((d: { id: string }) => d.id)).not.toContain(other.id);

    expect((await app.inject({ method: 'GET', url: `/api/datasets/${other.id}` })).statusCode).toBe(
      404,
    );
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/datasets/${other.id}`,
          payload: { name: 'x' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/datasets/${other.id}` })).statusCode,
    ).toBe(404);
    // ...and it is still there.
    expect(getDataset(app.db, other.id)).not.toBeNull();
  });

  it('404s for a missing dataset', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/datasets/ds_nope' });
    expect(res.statusCode).toBe(404);
  });
});
