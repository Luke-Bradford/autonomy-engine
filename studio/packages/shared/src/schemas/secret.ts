import { z } from 'zod';

/**
 * An encrypted-at-rest secret blob. `ciphertext` is produced by
 * `packages/server/src/secrets/secrets.ts` (`encrypt()`) — this schema never
 * sees, validates, or transports plaintext. `ref` is the stable machine
 * handle other config objects point at (`Connection.secretRef → Secret.ref`);
 * unique.
 *
 * A secret has one of two provenances (item 7 / S1, the unified secret model):
 * - **Connection-owned** — minted as a side effect of a connection/webhook
 *   write, addressed only by its opaque `ref`. `name` and `ownerId` are
 *   `null`: it is never user-addressable and never surfaced by `/api/secrets`.
 * - **Standalone** — created directly via `POST /api/secrets`, addressed by a
 *   user-chosen `name`, unique per `ownerId` (`UNIQUE(owner_id, name)`), so
 *   `{ "$secret": "<name>" }` (S2) resolves deterministically.
 *
 * This schema (and its `NewSecretSchema`/`Secret` types) must never be
 * reachable from any schema returned toward an HTTP client — see
 * `SecretPublicSchema` below (and `ConnectionPublicSchema` in `connection.ts`),
 * which strip `ciphertext`/`ref` rather than exposing them.
 */
export const SecretSchema = z.object({
  id: z.string().min(1),
  ref: z.string().min(1),
  ciphertext: z.string().min(1),
  // Both nullable + `.default(null)`: existing internal callers (connections/
  // triggers) mint `{ ref, ciphertext }` only, so via `z.input` (see
  // `NewSecret` below) these stay OPTIONAL for them and fill to `null`. A
  // read of a legacy/connection row (its columns are `NULL`) parses cleanly.
  ownerId: z.string().min(1).nullable().default(null),
  name: z.string().min(1).nullable().default(null),
  createdAt: z.number().int(),
});
export type Secret = z.infer<typeof SecretSchema>;

/**
 * Insert shape: server sets `id` + `createdAt`. `ownerId`/`name` stay
 * optional here BECAUSE `NewSecret` is `z.input` — a `.default(null)` field is
 * optional pre-parse, so the three existing `{ ref, ciphertext }` callers keep
 * compiling. Do NOT switch this to `z.infer`/`z.output`: those fields would
 * become required `string | null` and break every internal caller.
 */
export const NewSecretSchema = SecretSchema.omit({ id: true, createdAt: true });
export type NewSecret = z.input<typeof NewSecretSchema>;

/**
 * The ONLY secret projection an HTTP client may receive: `ciphertext` AND the
 * opaque machine `ref` are stripped, so a value never reveals stored key
 * material or the FK a connection resolves through. A standalone secret is
 * addressed by `name`; a client never needs — and must never see — its `ref`.
 * Mirrors `ConnectionPublicSchema`'s omit-don't-expose discipline.
 */
export const SecretPublicSchema = SecretSchema.omit({ ref: true, ciphertext: true });
export type SecretPublic = z.infer<typeof SecretPublicSchema>;
