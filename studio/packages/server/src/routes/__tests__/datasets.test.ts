import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createConnection,
  createDataset,
  createPipeline,
  createPipelineVersion,
  getDataset,
} from '../../repo/index.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CATALOG_VERSION,
  DatasetReferencesResponseSchema,
  DatasetSheetsResultSchema,
} from '@autonomy-studio/shared';
import { buildXlsx } from '../../connectors/__tests__/xlsx-fixtures.js';
import { cleanupTempRoots, tempRoot } from '../../connectors/__tests__/temp-roots.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';

/** The store every fixture dataset lives in — a REAL owned connection, because
 * a write now has to prove the caller may bind to it. */
let store: string;

const bodyFor = (connectionId: string) => ({
  name: 'Customers CSV',
  connectionId,
  kind: 'delimited',
  config: { path: 'customers.csv', header: true },
  columns: [{ name: 'id', type: 'integer', nullable: false }],
});

describe('datasets routes', () => {
  let app: FastifyInstance;
  let body: ReturnType<typeof bodyFor>;

  beforeAll(async () => {
    app = await buildTestApp();
    store = createConnection(app.db, {
      ownerId: 'local',
      name: 'Warehouse',
      kind: 'fs',
      config: { roots: ['/data'] },
      secretRef: null,
    }).id;
    body = bodyFor(store);
  });

  afterAll(async () => {
    await app.close();
    cleanupTempRoots();
  });

  describe('GET /:id/references (#996 M9)', () => {
    it('returns the pipelines whose copy nodes bind the dataset, flagged when they no longer agree', async () => {
      const ds = createDataset(app.db, {
        ownerId: 'local',
        name: 'M9 target',
        kind: 'table',
        connectionId: store,
        config: { table: 'target' },
        columns: [{ name: 'id', type: 'string', nullable: false }],
      });
      const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'M9 pipeline' });
      createPipelineVersion(app.db, {
        pipelineId: pipeline.id,
        params: [],
        outputs: [],
        nodes: [
          {
            id: 'copy1',
            type: 'copy',
            // Writes a column the dataset does not declare — the drift M9 exists
            // to surface, produced by a mapping pinned in an immutable version.
            config: {
              mapping: [{ source: 'id', sink: 'gone', type: 'string', onError: 'fail' }],
              mode: 'append',
            },
            connectionIds: { source: store, sink: store },
            datasetIds: { source: ds.id, sink: ds.id },
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
        catalogVersion: CATALOG_VERSION,
      });

      const res = await app.inject({ method: 'GET', url: `/api/datasets/${ds.id}/references` });
      expect(res.statusCode).toBe(200);
      // Parsed through the SHARED schema, so the route and the page cannot
      // disagree about the shape the page is about to render.
      const parsed = DatasetReferencesResponseSchema.parse(res.json());
      expect(parsed.references.map((r) => r.end)).toEqual(['source', 'sink']);
      expect(parsed.references[1]).toMatchObject({
        pipelineId: pipeline.id,
        pipelineName: 'M9 pipeline',
        status: 'disagrees',
        boundBy: ['latest'],
      });
      expect(parsed.dynamic).toEqual([]);
    });

    it('404s an unknown dataset rather than returning an empty list', async () => {
      // An empty list is a real answer ("nothing references this"), so a missing
      // dataset must not be able to produce one.
      const res = await app.inject({ method: 'GET', url: '/api/datasets/ds_nope/references' });
      expect(res.statusCode).toBe(404);
    });

    it('404s a dataset owned by someone else, before any walk', async () => {
      const foreign = createDataset(app.db, {
        ownerId: 'someone-else',
        name: 'Theirs',
        kind: 'table',
        connectionId: store,
        config: { table: 't' },
        columns: [],
      });
      const res = await app.inject({
        method: 'GET',
        url: `/api/datasets/${foreign.id}/references`,
      });
      expect(res.statusCode).toBe(404);
    });
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

  describe('POST /sheets (#1218)', () => {
    it('lists the sheets of a workbook inside the connection roots', async () => {
      const root = tempRoot('sheets-route-');
      const fsConn = createConnection(app.db, {
        ownerId: 'local',
        name: 'Sheets root',
        kind: 'fs',
        config: { roots: [root] },
        secretRef: null,
      });
      writeFileSync(
        join(root, 'book.xlsx'),
        buildXlsx({
          sheets: [
            { name: 'People', rows: [[{ kind: 'inline', text: 'name' }]] },
            { name: 'Costs', rows: [[{ kind: 'inline', text: 'amount' }]] },
          ],
        }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/datasets/sheets',
        payload: { connectionId: fsConn.id, path: join(root, 'book.xlsx') },
      });

      expect(res.statusCode).toBe(200);
      expect(DatasetSheetsResultSchema.parse(res.json())).toEqual({
        ok: true,
        sheets: ['People', 'Costs'],
      });
    });

    it('answers a refusal as a 200, so the form renders every failure in one place', async () => {
      const root = tempRoot('sheets-route-');
      const fsConn = createConnection(app.db, {
        ownerId: 'local',
        name: 'Empty root',
        kind: 'fs',
        config: { roots: [root] },
        secretRef: null,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/datasets/sheets',
        payload: { connectionId: fsConn.id, path: join(root, 'nothing-here.xlsx') },
      });

      // NOT a 4xx: a file the operator has not created yet is an ordinary
      // authoring state, not a protocol fault.
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(false);
    });

    // Authentication is not authorisation, and this route reads a FILE — so
    // binding to someone else's connection would read through their roots.
    it('refuses a connection that is not the caller’s, without disclosing which', async () => {
      const theirRoot = tempRoot('sheets-route-theirs-');
      const theirs = createConnection(app.db, {
        ownerId: 'someone_else',
        name: 'Their root',
        kind: 'fs',
        config: { roots: [theirRoot] },
        secretRef: null,
      });
      writeFileSync(
        join(theirRoot, 'secret.xlsx'),
        buildXlsx({ sheets: [{ name: 'Payroll', rows: [[{ kind: 'inline', text: 'x' }]] }] }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/datasets/sheets',
        payload: { connectionId: theirs.id, path: join(theirRoot, 'secret.xlsx') },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).not.toContain('Payroll');

      // The same existence-oracle rule the create path holds: "not yours" and
      // "no such connection" must be one sentence.
      const missing = await app.inject({
        method: 'POST',
        url: '/api/datasets/sheets',
        payload: { connectionId: 'conn_does_not_exist', path: 'book.xlsx' },
      });
      expect(missing.statusCode).toBe(400);
      expect(res.json().message.replace(theirs.id, 'X')).toBe(
        missing.json().message.replace('conn_does_not_exist', 'X'),
      );
    });

    it('rejects a body that is not a body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/datasets/sheets',
        payload: { path: 'book.xlsx' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // Authentication is not authorisation. `connectionId` is raw HTTP input, so a
  // logged-in caller must still be shown to own the store it names.
  it('refuses a create binding to a connection that is not the caller’s', async () => {
    const theirs = createConnection(app.db, {
      ownerId: 'someone_else',
      name: 'Their warehouse',
      kind: 'fs',
      config: { roots: ['/theirs'] },
      secretRef: null,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/datasets',
      payload: bodyFor(theirs.id),
    });
    expect(res.statusCode).toBe(400);
    // The message must not distinguish "not yours" from "no such connection" —
    // that difference is the existence oracle a prober is after.
    const missing = await app.inject({
      method: 'POST',
      url: '/api/datasets',
      payload: bodyFor('conn_does_not_exist'),
    });
    expect(missing.statusCode).toBe(400);
    expect(res.json().message.replace(theirs.id, 'X')).toBe(
      missing.json().message.replace('conn_does_not_exist', 'X'),
    );
  });

  it('refuses a PATCH that re-points a dataset at someone else’s connection', async () => {
    const theirs = createConnection(app.db, {
      ownerId: 'someone_else',
      name: 'Their other warehouse',
      kind: 'fs',
      config: { roots: ['/theirs'] },
      secretRef: null,
    });
    const created = (
      await app.inject({ method: 'POST', url: '/api/datasets', payload: body })
    ).json();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/datasets/${created.id}`,
      payload: { connectionId: theirs.id },
    });
    expect(res.statusCode).toBe(400);
    expect(getDataset(app.db, created.id)?.connectionId).toBe(store);
  });

  it('a PATCH that omits connectionId leaves the checked binding alone', async () => {
    const created = (
      await app.inject({ method: 'POST', url: '/api/datasets', payload: body })
    ).json();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/datasets/${created.id}`,
      payload: { name: 'Renamed only' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().connectionId).toBe(store);
  });

  it('404s for a missing dataset', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/datasets/ds_nope' });
    expect(res.statusCode).toBe(404);
  });
});
