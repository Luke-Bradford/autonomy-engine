import { z } from 'zod';

/**
 * An encrypted-at-rest secret blob. `ciphertext` is produced by
 * `packages/server/src/secrets/secrets.ts` (`encrypt()`) — this schema never
 * sees, validates, or transports plaintext. `ref` is the stable handle other
 * config objects point at (`Connection.secretRef → Secret.ref`); unique.
 *
 * This schema (and its `NewSecretSchema`/`Secret` types) must never be
 * reachable from any schema returned toward an HTTP client — see
 * `ConnectionPublicSchema` in `connection.ts`, which strips `secretRef`
 * rather than exposing it.
 */
export const SecretSchema = z.object({
  id: z.string().min(1),
  ref: z.string().min(1),
  ciphertext: z.string().min(1),
  createdAt: z.number().int(),
});
export type Secret = z.infer<typeof SecretSchema>;

/** Insert shape: server sets `id` + `createdAt`. */
export const NewSecretSchema = SecretSchema.omit({ id: true, createdAt: true });
export type NewSecret = z.input<typeof NewSecretSchema>;
