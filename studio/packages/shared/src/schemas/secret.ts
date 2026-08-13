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

/**
 * Upper bounds so a client cannot submit an unbounded payload to be encrypted
 * and stored. `name` is a short human-chosen identifier; `secret` is generous
 * enough for any realistic credential (an RSA-4096 PEM is ~3.2 KB, a full cert
 * chain a few KB more) while still capping the encrypt-and-store cost.
 */
export const MAX_SECRET_NAME_LEN = 255;
export const MAX_SECRET_VALUE_LEN = 16384;

/**
 * The client-facing write body of `POST /api/secrets`: a user-chosen `name` +
 * the plaintext `secret`. `ownerId` is stamped server-side from the principal
 * and `ref` (the opaque machine handle) is minted server-side — a client sets
 * neither, and `.strict()` makes an attempt to smuggle either a loud 400 at the
 * boundary rather than a silent drop. A secret write is the highest-stakes
 * boundary in the API; there is no reason to be lenient about unknown keys.
 *
 * SHARED, so the route (`packages/server/src/routes/secrets.ts`) and the
 * Secrets form (`packages/web/src/api/secrets.ts`) parse the SAME object rather
 * than two copies that agree today. The `TriggerWriteBodySchema` precedent
 * states the rule this follows: a response envelope can reasonably be
 * re-declared client-side, but a RULE about which values are legal cannot — a
 * copy drifts silently, and the drift only shows up as a 400 the client
 * believed it had already ruled out. The `.refine` below is exactly such a
 * rule. (`ConnectionWriteSchema` re-derives instead, because there the client
 * body genuinely DIVERGES from the server's; this one does not.)
 *
 * `NewSecretSchema` is NOT the thing to derive this from: that is the internal
 * INSERT shape (`ref` + `ciphertext`), which is the encrypted result of this
 * body, not the body itself. They share no field a client sends.
 */
export const SecretWriteBodySchema = z
  .object({
    /*
     * The name is a lookup KEY — F15's `{ "$secret": "<name>" }` sink resolves
     * by it (case-insensitively per #533: `UNIQUE(owner_id, name COLLATE
     * NOCASE)`, so a case-variant is a 409), and it is listed/deleted by it. So
     * it must be non-blank AND already trimmed: a whitespace-only name (`" "`
     * passes `min(1)`) or one with leading/trailing whitespace (`"key "` vs
     * `"key"`) is a silent lookup footgun that ASCII case-folding does NOT
     * cover. Reject it loudly at the boundary rather than mutating the client's
     * input by trimming.
     */
    name: z
      .string()
      .min(1)
      .max(MAX_SECRET_NAME_LEN)
      .refine((s) => s.trim() === s && s.length > 0, {
        message: 'name must not be blank or have leading/trailing whitespace',
      }),
    secret: z.string().min(1).max(MAX_SECRET_VALUE_LEN),
  })
  .strict();
export type SecretWriteBody = z.infer<typeof SecretWriteBodySchema>;
