import { getSecretByRef } from '../repo/secrets.js';
import type { Db } from '../repo/types.js';
import { SecretDecryptionError, decrypt } from './secrets.js';

/**
 * #1600 C1q-c — what reading a connection's stored secret came to.
 *
 * Three callers spend a stored connection secret: the executor's dispatch, the
 * saved-connection "Test connection" route and the dataset Preview route. Each
 * words the refusal its own way, so this returns the REASON and leaves the
 * sentence to the caller; the lookup and the decrypt are written once.
 *
 * - `missing`: the `secretRef` names no row. The FK makes it unreachable today;
 *   it is a reason rather than a throw so a relaxed schema surfaces loudly.
 * - `undecryptable`: the ciphertext does not open with the current master key.
 * - `unreadable`: any other decrypt failure.
 *
 * The underlying error is never carried: it can hold ciphertext or key detail.
 */
export type ConnectionSecretRead =
  | { readonly ok: true; readonly secret: string | null }
  | { readonly ok: false; readonly reason: 'missing' | 'undecryptable' | 'unreadable' };

/** A null `secretRef` is a connection that holds no secret: `{ ok, secret: null }`. */
export async function readConnectionSecret(
  db: Db,
  masterKey: Uint8Array,
  secretRef: string | null,
): Promise<ConnectionSecretRead> {
  if (secretRef === null) return { ok: true, secret: null };
  const row = getSecretByRef(db, secretRef);
  if (row === null) return { ok: false, reason: 'missing' };
  try {
    return { ok: true, secret: await decrypt(row.ciphertext, masterKey) };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof SecretDecryptionError ? 'undecryptable' : 'unreadable',
    };
  }
}

/**
 * The operator-facing sentence for a refused read, shared by the two routes that
 * answer a person (Test connection and Preview). The executor keeps its own
 * coded failures.
 */
export function connectionSecretRefusal(
  reason: 'missing' | 'undecryptable' | 'unreadable',
): string {
  if (reason === 'undecryptable') {
    return "this connection's secret could not be decrypted with the current master key";
  }
  return reason === 'missing'
    ? "this connection's secret was not found"
    : "this connection's secret could not be read";
}
