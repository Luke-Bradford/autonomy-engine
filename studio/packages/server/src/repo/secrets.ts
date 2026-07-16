import { and, eq, isNotNull } from 'drizzle-orm';
import {
  NewSecretSchema,
  SecretSchema,
  type NewSecret,
  type Secret,
} from '@autonomy-studio/shared';
import { secrets } from '../db/schema.js';
import { newId } from './ids.js';
import type { Db } from './types.js';

/**
 * Stores an already-encrypted blob (`ciphertext`, produced by
 * `../secrets/secrets.ts`'s `encrypt()`) under a stable `ref`. This module
 * never sees plaintext and never validates ciphertext contents — it is a
 * pure key/value store keyed by `ref` (unique).
 */
export function createSecret(db: Db, input: NewSecret): Secret {
  const parsed = NewSecretSchema.parse(input);
  const row: Secret = {
    id: newId('sec'),
    ...parsed,
    createdAt: Date.now(),
  };
  db.insert(secrets).values(row).run();
  return SecretSchema.parse(row);
}

export function getSecret(db: Db, id: string): Secret | null {
  const row = db.select().from(secrets).where(eq(secrets.id, id)).get();
  return row ? SecretSchema.parse(row) : null;
}

/** The lookup `Connection.secretRef` resolution actually uses. */
export function getSecretByRef(db: Db, ref: string): Secret | null {
  const row = db.select().from(secrets).where(eq(secrets.ref, ref)).get();
  return row ? SecretSchema.parse(row) : null;
}

export function listSecrets(db: Db): Secret[] {
  return db
    .select()
    .from(secrets)
    .all()
    .map((row) => SecretSchema.parse(row));
}

/**
 * The STANDALONE secrets for one owner (item 7 / S1) — the surface `GET
 * /api/secrets` exposes. Filters `name IS NOT NULL` so a connection-owned
 * secret (minted internally, `name`/`ownerId` = `NULL`) is never listed here:
 * those are managed only through the connection they belong to. Owner-scoped,
 * mirroring `listConnections`.
 */
export function listNamedSecrets(db: Db, ownerId: string): Secret[] {
  return db
    .select()
    .from(secrets)
    .where(and(eq(secrets.ownerId, ownerId), isNotNull(secrets.name)))
    .all()
    .map((row) => SecretSchema.parse(row));
}

/** Rotation: replaces the ciphertext under the same stable `ref` so every
 * `Connection.secretRef` pointing at it keeps resolving. */
export function updateSecretCiphertext(db: Db, id: string, ciphertext: string): Secret | null {
  const existing = getSecret(db, id);
  if (!existing) return null;
  const updated = SecretSchema.parse({ ...existing, ciphertext });
  db.update(secrets).set(updated).where(eq(secrets.id, id)).run();
  return updated;
}

export function deleteSecret(db: Db, id: string): boolean {
  const result = db.delete(secrets).where(eq(secrets.id, id)).run();
  return result.changes > 0;
}
