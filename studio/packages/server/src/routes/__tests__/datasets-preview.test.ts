import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  CopyPreviewResultSchema,
  DatasetPreviewResultSchema,
  DatasetSchemaResultSchema,
  type DatasetKind,
} from '@autonomy-studio/shared';
import {
  createConnection,
  createDataset,
  getDataset,
  listWorkspaceEventsPage,
} from '../../repo/index.js';
import { connections } from '../../db/schema.js';
import { seedDb } from '../../connectors/__tests__/sqlite-fixtures.js';
import { cleanupTempRoots, tempRoot } from '../../connectors/__tests__/temp-roots.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';
import { PREVIEW_ROW_CAP } from '../../limits.js';

/**
 * #1401 OR10 — see the data: a saved dataset's preview, Import schema, and the
 * Copy panel's mapped preview. Real stores throughout: a sqlite file and CSV
 * files on an fs connection, read through the adapters' own Lookup arm.
 */
describe('dataset preview routes (#1401)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    cleanupTempRoots();
  });

  /** A caller's sqlite store holding `t (id INTEGER, name TEXT)`. */
  const sqliteStore = (rows = 2, ownerId = 'local') => {
    const root = tempRoot('or10-sqlite-');
    const path = seedDb(root, rows);
    return createConnection(app.db, {
      ownerId,
      name: 'Orders db',
      kind: 'sqlite',
      config: { roots: [root], path },
      secretRef: null,
    });
  };

  /** A caller's fs store whose root holds `files`. */
  const fsStore = (files: Record<string, string>) => {
    const root = tempRoot('or10-fs-');
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
    const connection = createConnection(app.db, {
      ownerId: 'local',
      name: 'Drop folder',
      kind: 'fs',
      config: { roots: [root] },
      secretRef: null,
    });
    return { root, connection };
  };

  const dataset = (
    connectionId: string,
    kind: DatasetKind,
    config: Record<string, unknown>,
    ownerId = 'local',
  ) =>
    createDataset(app.db, {
      ownerId,
      name: `My ${kind}`,
      connectionId,
      kind,
      config,
      columns: [{ name: 'declared', type: 'string', nullable: true }],
    });

  const post = (url: string, payload?: Record<string, unknown>) =>
    payload === undefined
      ? app.inject({ method: 'POST', url })
      : app.inject({ method: 'POST', url, payload });

  const latestEvent = () =>
    listWorkspaceEventsPage(app.db, 'local', { limit: 1 }, 'desc').items[0]?.payload;

  describe('POST /api/datasets/:id/preview', () => {
    it('answers a table dataset’s first rows and the columns they show', async () => {
      const ds = dataset(sqliteStore().id, 'table', { table: 't' });
      const res = await post(`/api/datasets/${ds.id}/preview`);
      expect(res.statusCode).toBe(200);
      expect(DatasetPreviewResultSchema.parse(res.json())).toEqual({
        ok: true,
        rows: [
          { id: 1, name: 'row-1' },
          { id: 2, name: 'row-2' },
        ],
        truncated: false,
        columns: [
          { name: 'id', type: 'integer', nullable: false },
          { name: 'name', type: 'string', nullable: false },
        ],
      });
    });

    it('answers a query dataset’s rows', async () => {
      const ds = dataset(sqliteStore(3).id, 'query', {
        sql: 'SELECT name FROM t WHERE id > 1 ORDER BY id',
      });
      const res = await post(`/api/datasets/${ds.id}/preview`);
      expect(res.json()).toMatchObject({
        ok: true,
        rows: [{ name: 'row-2' }, { name: 'row-3' }],
        columns: [{ name: 'name', type: 'string', nullable: false }],
      });
    });

    it('answers a CSV dataset’s rows, inferring types through the dataset’s null value', async () => {
      const { connection } = fsStore({ 'people.csv': 'id,score,note\n1,2.5,hi\n2,\\N,\\N\n' });
      const ds = dataset(connection.id, 'delimited', {
        path: 'people.csv',
        header: true,
        nullValue: '\\N',
      });
      const res = await post(`/api/datasets/${ds.id}/preview`);
      expect(DatasetPreviewResultSchema.parse(res.json())).toEqual({
        ok: true,
        rows: [
          { id: '1', score: '2.5', note: 'hi' },
          { id: '2', score: null, note: null },
        ],
        truncated: false,
        columns: [
          { name: 'id', type: 'integer', nullable: false },
          { name: 'score', type: 'number', nullable: true },
          { name: 'note', type: 'string', nullable: true },
        ],
      });
    });

    it(`keeps the first ${PREVIEW_ROW_CAP} rows and says more exist`, async () => {
      const ds = dataset(sqliteStore(PREVIEW_ROW_CAP + 5).id, 'table', { table: 't' });
      const res = await post(`/api/datasets/${ds.id}/preview`);
      const body = DatasetPreviewResultSchema.parse(res.json());
      if (!body.ok) throw new Error(body.error);
      expect(body.rows).toHaveLength(PREVIEW_ROW_CAP);
      expect(body.truncated).toBe(true);
    });

    // The fs reader confines every path to the connection's own roots.
    it('refuses a file outside the connection’s roots', async () => {
      const outside = fsStore({ 'secret.csv': 'pay\n100\n' });
      const { connection } = fsStore({});
      const ds = dataset(connection.id, 'delimited', {
        path: join(outside.root, 'secret.csv'),
        header: true,
      });
      const res = await post(`/api/datasets/${ds.id}/preview`);
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(false);
      expect(res.body).not.toContain('100');
    });

    // Authentication is not authorisation: another owner's dataset is a 404
    // that says nothing about it, and nothing is read or recorded.
    it('answers 404 for a dataset that is not the caller’s', async () => {
      const theirs = dataset(
        sqliteStore(2, 'someone_else').id,
        'table',
        { table: 't' },
        'someone_else',
      );
      const before = latestEvent();
      const res = await post(`/api/datasets/${theirs.id}/preview`);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('row-1');
      expect(latestEvent()).toEqual(before);
      expect((await post('/api/datasets/ds_does_not_exist/preview')).statusCode).toBe(404);
    });

    it('refuses a disabled connection before reading', async () => {
      const conn = sqliteStore();
      const ds = dataset(conn.id, 'table', { table: 't' });
      app.db.update(connections).set({ enabled: false }).where(eq(connections.id, conn.id)).run();
      const res = await post(`/api/datasets/${ds.id}/preview`);
      expect(res.json()).toEqual({ ok: false, error: 'this connection is disabled' });
    });

    it('records the read in the workspace audit, without what it read', async () => {
      const conn = sqliteStore();
      const ds = dataset(conn.id, 'table', { table: 't' });
      await post(`/api/datasets/${ds.id}/preview`);
      const event = latestEvent();
      expect(event).toEqual({
        type: 'store.previewed',
        read: 'rows',
        connectionId: conn.id,
        connectionName: 'Orders db',
        datasetId: ds.id,
        datasetName: 'My table',
        ok: true,
        by: 'local',
      });
      expect(JSON.stringify(event)).not.toContain('row-1');
    });
  });

  describe('POST /api/datasets/:id/schema', () => {
    it('answers a table’s own columns and types, and writes nothing', async () => {
      const ds = dataset(sqliteStore(0).id, 'table', { table: 't' });
      const res = await post(`/api/datasets/${ds.id}/schema`);
      expect(DatasetSchemaResultSchema.parse(res.json())).toEqual({
        ok: true,
        columns: [
          { name: 'id', type: 'integer', nullable: true },
          { name: 'name', type: 'string', nullable: true },
        ],
        from: 'table',
      });
      expect(getDataset(app.db, ds.id)?.columns).toEqual(ds.columns);
      expect(latestEvent()).toMatchObject({ type: 'store.previewed', read: 'schema', ok: true });
    });

    it('infers a CSV’s columns from its first rows', async () => {
      const { connection } = fsStore({ 'a.csv': 'when,flag\n02/01/2026,yes\n03/01/2026,no\n' });
      const ds = dataset(connection.id, 'delimited', {
        path: 'a.csv',
        header: true,
        dateFormat: 'dd/MM/yyyy',
      });
      const res = await post(`/api/datasets/${ds.id}/schema`);
      expect(res.json()).toEqual({
        ok: true,
        columns: [
          { name: 'when', type: 'date', nullable: false },
          { name: 'flag', type: 'boolean', nullable: false },
        ],
        from: 'sample',
      });
    });

    it('says so when a file has no rows to infer from', async () => {
      const { connection } = fsStore({ 'empty.csv': 'a,b\n' });
      const ds = dataset(connection.id, 'delimited', { path: 'empty.csv', header: true });
      const res = await post(`/api/datasets/${ds.id}/schema`);
      expect(res.json()).toEqual({
        ok: false,
        error: 'the source has no rows, so there are no columns to read',
      });
    });
  });

  describe('POST /api/datasets/copy-preview', () => {
    const mapping = [
      { source: 'id', sink: 'ident', type: 'integer', onError: 'fail' },
      { source: 'price', sink: 'price', type: 'number', onError: 'null' },
    ];

    it('maps a saved source’s rows and names each cell the copy cannot coerce', async () => {
      const { connection } = fsStore({ 'p.csv': 'id,price\n1,2.5\n1.5,abc\n' });
      const ds = dataset(connection.id, 'delimited', { path: 'p.csv', header: true });
      const res = await post('/api/datasets/copy-preview', {
        source: { from: 'dataset', datasetId: ds.id },
        mapping,
      });
      // An integer coerces to a bigint, which JSON carries as its exact decimal
      // text (`logSafeRow`), never a rounded number.
      expect(CopyPreviewResultSchema.parse(res.json())).toEqual({
        ok: true,
        rows: [
          { values: { ident: '1', price: 2.5 }, failures: {} },
          {
            values: { ident: null, price: null },
            failures: {
              ident: { code: 'not_integral', reason: expect.any(String), nulled: false },
              price: { code: 'not_a_number', reason: expect.any(String), nulled: true },
            },
          },
        ],
        truncated: false,
      });
      expect(latestEvent()).toMatchObject({ read: 'copy', datasetId: ds.id, ok: true });
    });

    it('maps an inline source’s rows', async () => {
      const conn = sqliteStore(1);
      const res = await post('/api/datasets/copy-preview', {
        source: {
          from: 'inline',
          connectionId: conn.id,
          inline: { kind: 'query', config: { sql: 'SELECT id, name AS price FROM t' } },
        },
        mapping,
      });
      expect(res.json()).toMatchObject({
        ok: true,
        rows: [{ values: { ident: '1', price: null }, failures: { price: { nulled: true } } }],
      });
    });

    it('refuses a mapping naming a column the source does not have', async () => {
      const ds = dataset(sqliteStore().id, 'table', { table: 't' });
      const res = await post('/api/datasets/copy-preview', {
        source: { from: 'dataset', datasetId: ds.id },
        mapping: [{ source: 'nope', sink: 'nope', type: 'string', onError: 'fail' }],
      });
      expect(res.json()).toEqual({ ok: false, error: expect.stringContaining('nope') });
    });

    it('answers 404 for a saved source that is not the caller’s', async () => {
      const theirs = dataset(
        sqliteStore(2, 'someone_else').id,
        'table',
        { table: 't' },
        'someone_else',
      );
      const res = await post('/api/datasets/copy-preview', {
        source: { from: 'dataset', datasetId: theirs.id },
        mapping,
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
