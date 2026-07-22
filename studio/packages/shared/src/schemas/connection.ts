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
  // #4 A11 — the local filesystem connector: the FIRST non-http/LLM connector.
  // Credential-less (no `secretRef`); its non-secret `config.roots` is the
  // server-side allowlist the `fs` adapter confines every file activity to.
  'fs',
]);
export type ConnectionKind = z.infer<typeof ConnectionKindSchema>;

/**
 * The CLI/subscription connection kind (`claude -p` / `codex exec`). Named here
 * so the equality checks that gate subscription-only behaviour — the #2 L14c
 * quota admission gate (executor pre-flight) and its window writer (driver) —
 * share ONE typed identifier instead of a bare `'agent_cli'` string in each.
 */
export const AGENT_CLI_CONNECTION_KIND: ConnectionKind = 'agent_cli';

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
 *
 * A10 marker-subsumption note (item 7 / S4): when that revisit lands (the
 * `fs`/S3 connectors A11/A14, NOT item 7), the resolution is the SAME
 * `{$secret:name}` marker the unified secret model already uses at a node's
 * config sink (`ActivityCatalogEntry.secretSinkFields`) — one mechanism across
 * node config and connection config, rather than more `secretRef` columns. Item
 * 7 records the mechanism; it does not build the connection-config sink.
 */
export const ConnectionPublicSchema = ConnectionSchema.omit({ secretRef: true });
export type ConnectionPublic = z.infer<typeof ConnectionPublicSchema>;
