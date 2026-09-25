import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION, ImportError } from '@autonomy-studio/shared';
import {
  createConnection,
  createDataset,
  createPipeline,
  createPipelineVersion,
  getDataset,
  listDatasets,
} from '../../repo/index.js';
import { BadRequestError, NotFoundError } from '../../errors.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { exportDataset, exportPipeline } from '../export.js';
import { importEnvelope } from '../import.js';
import type { Db } from '../../repo/types.js';

// #1143 — the single-file dataset path. A dataset's store is NOT NULL, so unlike
// every other single-file import there is no "import now, rebind later" state:
// the import must land it in a connection or refuse.

function store(db: Db, ownerId: string, name = 'Files') {
  return createConnection(db, {
    ownerId,
    name,
    kind: 'fs',
    config: {},
    secretRef: null,
  });
}

function dataset(db: Db, ownerId: string, connectionId: string) {
  return createDataset(db, {
    ownerId,
    name: 'Customers CSV',
    connectionId,
    kind: 'delimited',
    config: { path: 'customers.csv', header: true },
    columns: [{ name: 'id', type: 'integer', nullable: false }],
  });
}

describe('exportDataset', () => {
  it('names its store by the connection resourceId, never the local id', () => {
    const { db } = freshDb();
    const conn = store(db, 'local');
    const ds = dataset(db, 'local', conn.id);

    const envelope = exportDataset(db, ds.id, 'local');
    if (envelope.kind !== 'dataset') throw new Error('unreachable');
    expect(envelope.data.connectionId).toBe(conn.resourceId);
    expect(JSON.stringify(envelope)).not.toContain(conn.id);
    expect(envelope.data.columns).toEqual(ds.columns);
    // A single-file export is stamped with WHEN, unlike the git form's fixed 0.
    expect(envelope.exportedAt).toBeGreaterThan(0);
  });

  it('404s for a nonexistent or not-owned dataset', () => {
    const { db } = freshDb();
    expect(() => exportDataset(db, 'ds_missing', 'local')).toThrow(NotFoundError);
    const theirs = dataset(db, 'someone-else', store(db, 'someone-else').id);
    expect(() => exportDataset(db, theirs.id, 'local')).toThrow(NotFoundError);
  });

  it('refuses (400, not a 500) when the store connection no longer exists', () => {
    const { db } = freshDb();
    const ds = dataset(db, 'local', 'conn_deleted');
    expect(() => exportDataset(db, ds.id, 'local')).toThrow(BadRequestError);
    expect(() => exportDataset(db, ds.id, 'local')).toThrow(/conn_deleted/);
  });

  it('refuses when the store is another owner’s connection', () => {
    const { db } = freshDb();
    const theirs = store(db, 'someone-else');
    const ds = dataset(db, 'local', theirs.id);
    // Their resourceId must not leak into our file.
    expect(() => exportDataset(db, ds.id, 'local')).toThrow(BadRequestError);
  });
});

describe('importEnvelope: dataset', () => {
  it('binds to the EXPLICITLY chosen store, as a fresh copy owned by the importer', () => {
    const { db } = freshDb();
    const source = store(db, 'owner-a');
    const ds = dataset(db, 'owner-a', source.id);
    const envelope = exportDataset(db, ds.id, 'owner-a');
    const chosen = store(db, 'owner-b', 'Chosen');

    const result = importEnvelope(db, 'owner-b', envelope, { store: chosen });
    if (result.kind !== 'dataset') throw new Error('unreachable');
    expect(result.attention).toEqual([]);
    const stored = getDataset(db, result.dataset.id)!;
    expect(stored.connectionId).toBe(chosen.id);
    expect(stored.ownerId).toBe('owner-b');
    // Portable import is a COPY (#3 G1): new id AND new resourceId.
    expect(stored.id).not.toBe(ds.id);
    expect(stored.resourceId).not.toBe(ds.resourceId);
    expect(stored.name).toBe(ds.name);
    expect(stored.kind).toBe(ds.kind);
    expect(stored.config).toEqual(ds.config);
    expect(stored.columns).toEqual(ds.columns);
  });

  it('with no choice, resolves the store by IDENTITY within the importer’s own connections', () => {
    const { db } = freshDb();
    const conn = store(db, 'local');
    store(db, 'local', 'Decoy');
    const ds = dataset(db, 'local', conn.id);

    const result = importEnvelope(db, 'local', exportDataset(db, ds.id, 'local'));
    if (result.kind !== 'dataset') throw new Error('unreachable');
    expect(getDataset(db, result.dataset.id)!.connectionId).toBe(conn.id);
  });

  it('refuses, creating nothing, when no choice is made and no connection matches', () => {
    const { db } = freshDb();
    const theirs = store(db, 'owner-a');
    const envelope = exportDataset(db, dataset(db, 'owner-a', theirs.id).id, 'owner-a');
    // owner-b has a connection, but not THAT one — and owner-a's must never
    // resolve for owner-b even though its resourceId is in the file.
    store(db, 'owner-b');

    expect(() => importEnvelope(db, 'owner-b', envelope)).toThrow(ImportError);
    expect(() => importEnvelope(db, 'owner-b', envelope)).toThrow(/choose the connection/i);
    expect(listDatasets(db, 'owner-b')).toEqual([]);
  });

  it('refuses a store binding on an envelope that has no store', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
    const envelope = exportPipeline(db, pipeline.id, 'local');
    expect(() => importEnvelope(db, 'local', envelope, { store: store(db, 'local') })).toThrow(
      ImportError,
    );
  });
});
