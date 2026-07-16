import { describe, expect, it } from 'vitest';
import { secrets } from '../../db/schema.js';
import {
  createSecret,
  deleteSecret,
  getSecret,
  getSecretByName,
  getSecretByRef,
  listNamedSecrets,
  listSecrets,
  updateSecretCiphertext,
} from '../secrets.js';
import { freshDb } from './helpers.js';

describe('secrets repo', () => {
  it('creates and reads back a secret by id and by ref', () => {
    const { db } = freshDb();
    const created = createSecret(db, { ref: 'anthropic-key-1', ciphertext: 'opaque-blob-1' });
    expect(created.id).toMatch(/^sec_/);
    expect(getSecret(db, created.id)).toEqual(created);
    expect(getSecretByRef(db, 'anthropic-key-1')).toEqual(created);
  });

  it('returns null for a missing id/ref', () => {
    const { db } = freshDb();
    expect(getSecret(db, 'sec_missing')).toBeNull();
    expect(getSecretByRef(db, 'no-such-ref')).toBeNull();
  });

  it('lists all secrets', () => {
    const { db } = freshDb();
    const a = createSecret(db, { ref: 'ref-a', ciphertext: 'blob-a' });
    const b = createSecret(db, { ref: 'ref-b', ciphertext: 'blob-b' });
    expect(
      listSecrets(db)
        .map((s) => s.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  });

  it('rotates ciphertext under the same ref via updateSecretCiphertext', () => {
    const { db } = freshDb();
    const created = createSecret(db, { ref: 'anthropic-key-1', ciphertext: 'old-blob' });
    const rotated = updateSecretCiphertext(db, created.id, 'new-blob');
    expect(rotated!.ciphertext).toBe('new-blob');
    expect(rotated!.ref).toBe('anthropic-key-1');
    expect(rotated!.id).toBe(created.id);
  });

  it('deletes a secret', () => {
    const { db } = freshDb();
    const created = createSecret(db, { ref: 'anthropic-key-1', ciphertext: 'blob' });
    expect(deleteSecret(db, created.id)).toBe(true);
    expect(getSecret(db, created.id)).toBeNull();
  });

  it('rejects a duplicate ref at the DB layer (unique index enforced)', () => {
    const { db } = freshDb();
    createSecret(db, { ref: 'dup-ref', ciphertext: 'blob-1' });

    const row = {
      id: 'sec_dup_2',
      ref: 'dup-ref',
      ciphertext: 'blob-2',
      createdAt: Date.now(),
    };
    expect(() => db.insert(secrets).values(row).run()).toThrow();
  });

  it('a connection-owned secret leaves ownerId + name null (default provenance)', () => {
    const { db } = freshDb();
    const created = createSecret(db, { ref: 'conn-secret', ciphertext: 'blob' });
    expect(created.ownerId).toBeNull();
    expect(created.name).toBeNull();
    expect(getSecret(db, created.id)!.ownerId).toBeNull();
  });

  it('a standalone secret carries owner + name; listNamedSecrets scopes to the owner and excludes connection-owned rows', () => {
    const { db } = freshDb();
    const mine = createSecret(db, {
      ref: 'ref-mine',
      ciphertext: 'blob-mine',
      ownerId: 'local',
      name: 'stripe-key',
    });
    createSecret(db, {
      ref: 'ref-other',
      ciphertext: 'blob-other',
      ownerId: 'someone-else',
      name: 'their-key',
    });
    // A connection-owned secret (name/owner null) must never appear in the list.
    createSecret(db, { ref: 'ref-conn', ciphertext: 'blob-conn' });

    const listed = listNamedSecrets(db, 'local');
    expect(listed.map((s) => s.id)).toEqual([mine.id]);
    expect(listed[0]!.name).toBe('stripe-key');
    expect(listed[0]!.ownerId).toBe('local');
  });

  it('rejects a duplicate (owner_id, name) at the DB layer (unique index enforced)', () => {
    const { db } = freshDb();
    createSecret(db, { ref: 'ref-1', ciphertext: 'blob-1', ownerId: 'local', name: 'dup' });
    expect(() =>
      createSecret(db, { ref: 'ref-2', ciphertext: 'blob-2', ownerId: 'local', name: 'dup' }),
    ).toThrow();
  });

  it('does NOT collide many connection-owned secrets — (NULL, NULL) is distinct in the unique index', () => {
    const { db } = freshDb();
    // The exact regression the (owner_id, name) unique index risks: every
    // connection secret is (NULL, NULL); SQLite treats NULLs as distinct, so
    // they must coexist.
    const a = createSecret(db, { ref: 'conn-a', ciphertext: 'blob-a' });
    const b = createSecret(db, { ref: 'conn-b', ciphertext: 'blob-b' });
    expect(a.id).not.toBe(b.id);
    expect(
      listSecrets(db)
        .map((s) => s.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  });

  it('getSecretByName resolves the owner-scoped standalone secret (item 7 / S3 dispatch)', () => {
    const { db } = freshDb();
    const mine = createSecret(db, {
      ref: 'ref-mine',
      ciphertext: 'blob-mine',
      ownerId: 'local',
      name: 'stripe-key',
    });
    // Same NAME, different owner — must not leak across the owner boundary.
    createSecret(db, {
      ref: 'ref-other',
      ciphertext: 'blob-other',
      ownerId: 'someone-else',
      name: 'stripe-key',
    });
    expect(getSecretByName(db, 'stripe-key', 'local')?.id).toBe(mine.id);
    // Wrong owner / wrong name → null (the executor maps this to config_secret_not_found).
    expect(getSecretByName(db, 'stripe-key', 'nobody')).toBeNull();
    expect(getSecretByName(db, 'no-such-name', 'local')).toBeNull();
  });

  // #533 — secret names collate CASE-INSENSITIVELY for BOTH uniqueness and
  // lookup (ASCII `COLLATE NOCASE`). The two halves are load-bearing TOGETHER:
  // the NOCASE unique index guarantees at most ONE case-variant row per owner,
  // so the NOCASE `.get()` lookup below is DETERMINISTIC. A NOCASE lookup
  // WITHOUT the NOCASE index could match either of two coexisting rows
  // (non-deterministic) — which is exactly the "half-measure just moves the
  // mismatch" the ticket warns against, so neither half may be reverted alone.
  it('getSecretByName resolves a case-variant name (lookup is case-insensitive)', () => {
    const { db } = freshDb();
    const mine = createSecret(db, {
      ref: 'ref-mine',
      ciphertext: 'blob-mine',
      ownerId: 'local',
      name: 'Stripe-Key',
    });
    // Stored casing is preserved verbatim; lookup folds ASCII case.
    expect(getSecretByName(db, 'stripe-key', 'local')?.id).toBe(mine.id);
    expect(getSecretByName(db, 'STRIPE-KEY', 'local')?.id).toBe(mine.id);
    expect(getSecretByName(db, 'Stripe-Key', 'local')?.id).toBe(mine.id);
  });

  it('rejects a case-variant of an existing same-owner name (uniqueness is case-insensitive)', () => {
    const { db } = freshDb();
    createSecret(db, { ref: 'ref-1', ciphertext: 'blob-1', ownerId: 'local', name: 'stripe-key' });
    expect(() =>
      createSecret(db, {
        ref: 'ref-2',
        ciphertext: 'blob-2',
        ownerId: 'local',
        name: 'Stripe-Key',
      }),
    ).toThrow();
  });

  it('owner_id stays case-SENSITIVE — NOCASE is scoped to the name column only', () => {
    const { db } = freshDb();
    // Same name, owner ids differing only in case are DISTINCT owners: the
    // NOCASE collation must not bleed onto owner_id (opaque machine ids compare
    // exactly). Both rows coexist and each resolves within its own owner scope.
    const lower = createSecret(db, {
      ref: 'ref-lower',
      ciphertext: 'blob-lower',
      ownerId: 'local',
      name: 'key',
    });
    const upper = createSecret(db, {
      ref: 'ref-upper',
      ciphertext: 'blob-upper',
      ownerId: 'LOCAL',
      name: 'key',
    });
    expect(lower.id).not.toBe(upper.id);
    expect(getSecretByName(db, 'key', 'local')?.id).toBe(lower.id);
    expect(getSecretByName(db, 'key', 'LOCAL')?.id).toBe(upper.id);
  });

  it('getSecretByName never resolves a connection-owned secret (name is NULL)', () => {
    const { db } = freshDb();
    // Connection-owned secrets carry name = NULL, so a name lookup can never
    // reach one — a node cannot reference a connection credential by guessing.
    createSecret(db, { ref: 'ref-conn', ciphertext: 'blob' });
    expect(getSecretByName(db, 'ref-conn', 'local')).toBeNull();
  });

  it('two owners may use the SAME name (uniqueness is per-owner)', () => {
    const { db } = freshDb();
    const a = createSecret(db, { ref: 'ref-a', ciphertext: 'blob', ownerId: 'alice', name: 'key' });
    const b = createSecret(db, { ref: 'ref-b', ciphertext: 'blob', ownerId: 'bob', name: 'key' });
    expect(a.id).not.toBe(b.id);
  });

  it('never round-trips plaintext — ciphertext is stored/read back exactly as given, opaque to this layer', () => {
    const { db } = freshDb();
    const created = createSecret(db, { ref: 'anthropic-key-1', ciphertext: 'base64:AAAA' });
    // This module has no decrypt/encrypt awareness at all; asserting the
    // stored value is bit-for-bit what was handed in (never re-derived,
    // never logged as a side channel) is the whole of its "never plaintext"
    // contract at this layer — actual encryption is `secrets/secrets.ts`'s.
    expect(getSecret(db, created.id)!.ciphertext).toBe('base64:AAAA');
  });
});
