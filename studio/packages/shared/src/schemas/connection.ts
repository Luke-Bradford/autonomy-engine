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

/**
 * #3 G8a — the connection kinds that REQUIRE a connection-level `secretRef`
 * credential to dispatch. The single source of truth for `deriveSecretStatus`
 * (server) and any UI readiness affordance — never a bare `kind === 'anthropic_api'`
 * string re-spelled at a call site. Only the hosted-API LLM kinds need a
 * connection secret: `ollama` (local) and `agent_cli` (subscription CLI) run
 * credential-less, `fs` is explicitly credential-less (`config.roots` allowlist),
 * and `http` carries auth as a config-sink `{$secret}` marker (item 7 / S4), NOT
 * a connection `secretRef`. A future kind that needs a connection credential adds
 * itself HERE; the 0030 migration's one-time SQL backfill snapshots this set.
 */
export const SECRET_REQUIRING_CONNECTION_KINDS: ReadonlySet<ConnectionKind> =
  new Set<ConnectionKind>(['anthropic_api', 'openai_api']);

/** Whether `kind` requires a connection-level `secretRef` to dispatch (the G8a
 * readiness derivation's kind axis). */
export function connectionKindRequiresSecret(kind: ConnectionKind): boolean {
  return SECRET_REQUIRING_CONNECTION_KINDS.has(kind);
}

/**
 * #3 G8a — a connection's SECRET-READINESS state, a real runtime dispatch GATE
 * (git-publish spec 120-131, 742-745). Server-derived + server-maintained
 * (never client-writable), stored so export/UI/dispatch read ONE fact:
 * - `not_required` — the kind needs no connection secret and none is set.
 * - `ready` — the required secret is present (`secretRef` resolves).
 * - `needs_secret` — a secret is required (kind requires one, or a `secretRef`
 *   was declared) but is absent. A node bound to such a connection is refused at
 *   DISPATCH (`CONNECTION_NOT_READY`) — the gate is at fire time, not just
 *   enable time, so a secret removed after a trigger was enabled cannot fire a
 *   secretless run.
 */
export const SecretStatusSchema = z.enum(['not_required', 'ready', 'needs_secret']);
export type SecretStatus = z.infer<typeof SecretStatusSchema>;

export const ConnectionSchema = z.object({
  id: z.string().min(1),
  /**
   * #3 G1 — stable cross-workspace identity (see `PipelineSchema.resourceId`
   * for the full contract): server-minted, never client-writable, unique per
   * owner, backfilled for pre-G1 rows by migration 0024.
   */
  resourceId: z.string().min(1),
  ownerId: z.string().min(1).nullable(),
  name: z.string().min(1),
  kind: ConnectionKindSchema,
  config: z.record(z.string(), z.unknown()),
  /**
   * #2 L13b — the per-dispatch override ALLOWLIST: the `config` keys a node may
   * override via its `${}`-bound `connectionParams` (resolved at dispatch,
   * shallow-merged over `config` — the static value IS the default). Declared
   * on the CONNECTION, not the node, because connections can be shared
   * (null-owner) and carry a secret: without the owner's opt-in per key, a
   * borrower node could override e.g. `baseUrl` and point the decrypted
   * credential at a hostile host. Names only in v1 — richer metadata
   * (types/defaults) is a widening, not a break. `.default([])` is the READ
   * heal for pre-L13b rows/exports and is fail-closed here (an absent
   * allowlist declares NOTHING overridable); the WRITE body must NOT inherit
   * this default — Zod applies a `.default()` even through `.partial()`, so a
   * defaulted PATCH field would silently reset a stored allowlist to `[]`
   * (see `routes/connections.ts`).
   *
   * Parameters are NON-secret by design: the dispatch merge refuses any
   * resolved value that is `{$secret:…}`-marker-shaped (executor). Connection
   * `config` itself carries no secret sinks today (see the A10
   * marker-subsumption note below) — if A11/S4 ever adds them, the merge must
   * also refuse a declared parameter naming a sink path.
   */
  parameters: z.array(z.string().min(1)).default([]),
  secretRef: z.string().min(1).nullable(),
  /**
   * #3 G8a — secret-readiness (see `SecretStatusSchema`) + operator enable flag.
   * BOTH server-maintained and REQUIRED with NO `.default()`: an absent stored
   * value must fail loudly at this read boundary, never be manufactured as a
   * benign default (the #473 lesson — the same fail-closed shape as `resourceId`
   * and the merge-gate's "a `gh` failure is never CI-green"). Derived on every
   * connection write (`deriveSecretStatus`); the 0030 migration backfills every
   * existing row. `enabled` defaults truthfully to `true` for pre-G8 rows at the
   * DB layer (they were all usable), never here.
   */
  secretStatus: SecretStatusSchema,
  enabled: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Connection = z.infer<typeof ConnectionSchema>;

/** Insert shape: server sets `id`/`createdAt`/`updatedAt`. */
export const NewConnectionSchema = ConnectionSchema.omit({
  id: true,
  // Server-minted, like `id` — no write path (create OR patch) may supply it.
  resourceId: true,
  // #3 G8a — server-derived (`deriveSecretStatus`) / server-set (`enabled`),
  // never client-writable: readiness is a runtime fact, not authoring input.
  // Create sets `enabled: true` + derives `secretStatus`; a toggle/supply flow
  // is G8b.
  secretStatus: true,
  enabled: true,
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
