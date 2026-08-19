import { describe, expect, it } from 'vitest';
import {
  createDataset,
  deleteDataset,
  getDataset,
  getDatasetByResourceId,
  listDatasets,
  listDatasetsPage,
  updateDataset,
} from '../datasets.js';
import { createConnection, deleteConnection } from '../connections.js';
import type { NewDataset } from '@autonomy-studio/shared';
import { decodeCursor } from '../pagination.js';
import { freshDb } from './helpers.js';

const newDataset = {
  ownerId: 'local',
  name: 'Customers CSV',
  connectionId: 'conn_store',
  kind: 'delimited' as const,
  config: { path: 'customers.csv', header: true },
  columns: [{ name: 'id', type: 'integer' as const, nullable: false }],
};

describe('datasets repo', () => {
  it('creates and reads back a dataset', () => {
    const { db } = freshDb();
    const created = createDataset(db, newDataset);
    expect(created.id).toMatch(/^ds_/);
    expect(created.resourceId).toMatch(/^res_/);
    expect(created.createdAt).toBe(created.updatedAt);
    expect(getDataset(db, created.id)).toEqual(created);
  });

  it('returns null for an unknown id', () => {
    const { db } = freshDb();
    expect(getDataset(db, 'ds_nope')).toBeNull();
  });

  it('preserves a supplied resourceId (the import path), else mints one', () => {
    const { db } = freshDb();
    const imported = createDataset(db, newDataset, { resourceId: 'res_from_git' });
    expect(imported.resourceId).toBe('res_from_git');
    expect(getDatasetByResourceId(db, 'local', 'res_from_git')).toEqual(imported);
  });

  it('scopes getDatasetByResourceId to the owner', () => {
    const { db } = freshDb();
    createDataset(db, newDataset, { resourceId: 'res_shared' });
    expect(getDatasetByResourceId(db, 'other', 'res_shared')).toBeNull();
  });

  it('lists all datasets, or only one owner’s', () => {
    const { db } = freshDb();
    createDataset(db, newDataset);
    createDataset(db, { ...newDataset, ownerId: 'other', name: 'Theirs' });
    expect(listDatasets(db)).toHaveLength(2);
    expect(listDatasets(db, 'local')).toHaveLength(1);
  });

  it('paginates owner-scoped, keyset over created_at/id', () => {
    const { db } = freshDb();
    for (let i = 0; i < 3; i += 1) createDataset(db, { ...newDataset, name: `ds ${i}` });
    const first = listDatasetsPage(db, 'local', { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    // `nextCursor` is the ENCODED opaque string the HTTP boundary hands back;
    // `PageArgs.cursor` is the decoded key (`pageArgsFromQuery` does this).
    const second = listDatasetsPage(db, 'local', {
      limit: 2,
      cursor: decodeCursor(first.nextCursor!) ?? undefined,
    });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it('updates a dataset and advances updatedAt', () => {
    const { db } = freshDb();
    const created = createDataset(db, newDataset);
    const updated = updateDataset(db, created.id, { name: 'Renamed' });
    expect(updated?.name).toBe('Renamed');
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
  });

  // `updateDataset` pins `id`/`resourceId`/`createdAt` to the existing row
  // EXPLICITLY rather than leaving them to the spread. `Partial<NewDataset>`
  // already omits them, so the pins only bite for a caller that hands a RAW
  // object — which is precisely the case they exist for, and therefore the case
  // this test has to construct for the assertion to mean anything.
  it('refuses to let a raw patch rewrite identity or creation time', () => {
    const { db } = freshDb();
    const created = createDataset(db, newDataset);
    const updated = updateDataset(db, created.id, {
      name: 'Renamed',
      id: 'ds_forged',
      resourceId: 'res_forged',
      createdAt: 1,
    } as Partial<NewDataset>);
    expect(updated?.name).toBe('Renamed');
    expect(updated?.id).toBe(created.id);
    expect(updated?.resourceId).toBe(created.resourceId);
    expect(updated?.createdAt).toBe(created.createdAt);
    // ...and it is the STORED row that matters, not just the return value.
    expect(getDataset(db, created.id)?.resourceId).toBe(created.resourceId);
  });

  it('returns null when updating an unknown dataset', () => {
    const { db } = freshDb();
    expect(updateDataset(db, 'ds_nope', { name: 'x' })).toBeNull();
  });

  it('deletes a dataset, reporting whether a row went', () => {
    const { db } = freshDb();
    const created = createDataset(db, newDataset);
    expect(deleteDataset(db, created.id)).toBe(true);
    expect(deleteDataset(db, created.id)).toBe(false);
    expect(getDataset(db, created.id)).toBeNull();
  });

  // The `connection_id` column deliberately carries NO foreign key (see the 0036
  // migration). This pins the CONSEQUENCE so it stays a decision rather than
  // drifting into an accident: deleting the store a dataset names must leave the
  // dataset intact (not cascade-destroyed) and must not itself be refused. The
  // dangling ref is caught loudly later — at serialize, and at dispatch.
  it('survives deletion of the connection it names, and does not block it', () => {
    const { db } = freshDb();
    const store = createConnection(db, {
      ownerId: 'local',
      name: 'Warehouse',
      kind: 'fs',
      config: { roots: ['/tmp'] },
      secretRef: null,
    });
    const dataset = createDataset(db, { ...newDataset, connectionId: store.id });

    expect(deleteConnection(db, store.id)).toBe(true);

    const stillThere = getDataset(db, dataset.id);
    expect(stillThere).not.toBeNull();
    expect(stillThere?.connectionId).toBe(store.id);
  });
});
