import { z } from 'zod';

/**
 * A named worker binding (ADF "Linked Service" analog). `kind` selects which
 * `ConnectorAdapter` handles it; `config` is adapter-specific non-secret
 * settings; secrets are referenced by `secretRef` (→ `Secret.ref`), never
 * inlined — see `secret.ts`.
 */
export const ConnectionKindSchema = z.enum([
  'anthropic_api',
  'openai_api',
  'ollama',
  'agent_cli',
  'http',
]);
export type ConnectionKind = z.infer<typeof ConnectionKindSchema>;

export const ConnectionSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1).nullable(),
  name: z.string().min(1),
  kind: ConnectionKindSchema,
  config: z.record(z.string(), z.unknown()),
  secretRef: z.string().min(1).nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Connection = z.infer<typeof ConnectionSchema>;

/** Insert shape: server sets `id`/`createdAt`/`updatedAt`. */
export const NewConnectionSchema = ConnectionSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
// `z.input` (not `z.infer`/`z.output`): every `New*` insert type in this
// package uses the PRE-parse type, so a field with `.default()` elsewhere
// stays optional for callers instead of appearing spuriously required.
export type NewConnection = z.input<typeof NewConnectionSchema>;

/**
 * Client-facing projection with `secretRef` stripped, so a value never
 * reveals which secret record backs a connection. NOTE (deferred decision,
 * per the ticket): whether `config` itself can carry secret-adjacent values
 * for some connector kinds is NOT resolved here — today `config` is assumed
 * non-secret for every kind, matching the architecture doc's "secrets
 * referenced, never inlined." Revisit if a future connector kind's config
 * needs a secret-shaped field.
 */
export const ConnectionPublicSchema = ConnectionSchema.omit({ secretRef: true });
export type ConnectionPublic = z.infer<typeof ConnectionPublicSchema>;
