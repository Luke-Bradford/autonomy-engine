import { describe, expect, it } from 'vitest';
import {
  createConnection,
  deleteConnection,
  getConnection,
  listConnections,
  updateConnection,
} from '../connections.js';
import { freshDb } from './helpers.js';

const newConnection = {
  ownerId: 'local',
  name: 'My Claude key',
  kind: 'anthropic_api' as const,
  config: { model: 'claude-sonnet' },
  secretRef: null,
};

describe('connections repo', () => {
  it('creates and reads back a connection', () => {
    const { db } = freshDb();
    const created = createConnection(db, newConnection);
    expect(created.id).toMatch(/^conn_/);
    expect(created.createdAt).toBe(created.updatedAt);

    const fetched = getConnection(db, created.id);
    expect(fetched).toEqual(created);
  });

  it('returns null for a missing id', () => {
    const { db } = freshDb();
    expect(getConnection(db, 'conn_missing')).toBeNull();
  });

  it('lists connections, optionally filtered by ownerId', () => {
    const { db } = freshDb();
    const a = createConnection(db, { ...newConnection, ownerId: 'local', name: 'A' });
    const b = createConnection(db, { ...newConnection, ownerId: 'other', name: 'B' });

    expect(
      listConnections(db)
        .map((c) => c.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    expect(listConnections(db, 'local')).toEqual([a]);
  });

  it('updates a connection and bumps updatedAt without changing createdAt', async () => {
    const { db } = freshDb();
    const created = createConnection(db, newConnection);
    await new Promise((resolve) => setTimeout(resolve, 2));

    const updated = updateConnection(db, created.id, { name: 'Renamed key' });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('Renamed key');
    expect(updated!.createdAt).toBe(created.createdAt);
    expect(updated!.updatedAt).toBeGreaterThan(created.createdAt);
    expect(getConnection(db, created.id)).toEqual(updated);
  });

  it('returns null when updating a missing connection', () => {
    const { db } = freshDb();
    expect(updateConnection(db, 'conn_missing', { name: 'x' })).toBeNull();
  });

  it('deletes a connection', () => {
    const { db } = freshDb();
    const created = createConnection(db, newConnection);
    expect(deleteConnection(db, created.id)).toBe(true);
    expect(getConnection(db, created.id)).toBeNull();
    expect(deleteConnection(db, created.id)).toBe(false);
  });

  it('rejects an invalid kind at the repo boundary (Zod, not just Drizzle types)', () => {
    const { db } = freshDb();
    expect(() =>
      createConnection(db, { ...newConnection, kind: 'not_a_real_kind' as never }),
    ).toThrow();
  });
});
