import { describe, expect, it } from 'vitest';
import {
  createConnection,
  deleteConnection,
  getConnection,
  getConnectionByResourceId,
  listConnections,
  updateConnection,
} from '../connections.js';
import { createSecret, deleteSecret } from '../secrets.js';
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

  describe('secretRef FK', () => {
    it('creates and round-trips a connection pointing at a real secret', () => {
      const { db } = freshDb();
      const secret = createSecret(db, { ref: 'anthropic-key-1', ciphertext: 'blob' });
      const created = createConnection(db, { ...newConnection, secretRef: secret.ref });
      expect(getConnection(db, created.id)).toEqual(created);
    });

    it('rejects creating a connection with a bogus secretRef (FK enforced)', () => {
      const { db } = freshDb();
      expect(() =>
        createConnection(db, { ...newConnection, secretRef: 'sec_does_not_exist' }),
      ).toThrow();
    });

    it('rejects deleting a secret that a connection still references (ON DELETE RESTRICT)', () => {
      const { db } = freshDb();
      const secret = createSecret(db, { ref: 'anthropic-key-2', ciphertext: 'blob' });
      createConnection(db, { ...newConnection, secretRef: secret.ref });

      expect(() => deleteSecret(db, secret.id)).toThrow();
    });

    it('allows deleting a secret no connection references', () => {
      const { db } = freshDb();
      const secret = createSecret(db, { ref: 'anthropic-key-3', ciphertext: 'blob' });
      expect(deleteSecret(db, secret.id)).toBe(true);
    });
  });

  it('corrupt-row read: a hand-crafted row with malformed JSON in `config` makes getConnection throw', () => {
    const { db, sqlite } = freshDb();
    // Bypasses Drizzle's JSON serialization entirely (a raw better-sqlite3
    // insert with a non-JSON string in the `config` column) — the kind of
    // row that could only land here via direct DB tampering, a bug in an
    // older writer, or a botched manual migration. `getConnection` must
    // still fail loudly instead of silently handing back a corrupt value:
    // Drizzle's JSON-mode column read (`JSON.parse`) throws on the way in.
    sqlite
      .prepare(
        `INSERT INTO connections (id, owner_id, name, kind, config, secret_ref, created_at, updated_at)
         VALUES (?, NULL, 'x', 'http', 'not-valid-json{', NULL, 1, 1)`,
      )
      .run('conn_corrupt');

    expect(() => getConnection(db, 'conn_corrupt')).toThrow();
    expect(() => listConnections(db)).toThrow();
  });

  // #3 G5c — the workspace-git reconcile apply primitives.
  describe('resourceId preservation + lookup (G5c)', () => {
    it('preserves a supplied resourceId on create (else mints fresh)', () => {
      const { db } = freshDb();
      const preserved = createConnection(db, newConnection, { resourceId: 'res_c' });
      expect(preserved.resourceId).toBe('res_c');
      const minted = createConnection(db, newConnection);
      expect(minted.resourceId).toMatch(/^res_/);
      expect(minted.resourceId).not.toBe('res_c');
    });

    it('resolves a connection by (ownerId, resourceId), owner-scoped', () => {
      const { db } = freshDb();
      const mine = createConnection(
        db,
        { ...newConnection, ownerId: 'me' },
        { resourceId: 'res_c' },
      );
      createConnection(db, { ...newConnection, ownerId: 'other' }, { resourceId: 'res_c' });
      expect(getConnectionByResourceId(db, 'me', 'res_c')?.id).toBe(mine.id);
      expect(getConnectionByResourceId(db, 'me', 'res_missing')).toBeNull();
    });
  });
});
