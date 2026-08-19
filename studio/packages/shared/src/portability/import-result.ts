import { z } from 'zod';
import { ConnectionPublicSchema } from '../schemas/connection.js';
import { PipelineSchema, PipelineVersionSchema } from '../schemas/pipeline.js';
import { TriggerPublicSchema } from '../schemas/trigger.js';

/**
 * One thing the importer must follow up on after `POST /api/import`
 * succeeds — never a blocking error (the import itself already succeeded),
 * always a pointer to a manual step the normal CRUD routes already handle.
 */
export const ImportAttentionItemSchema = z.discriminatedUnion('type', [
  /** A pipeline node's `connectionId` came back `null` (every pipeline
   * export nulls it — see `NodeExportSchema`) — rebind it by authoring a new
   * `PipelineVersion` (versions are immutable) once a connection exists in
   * this workspace. */
  z.object({ type: z.literal('unresolvedConnectionRef'), nodeId: z.string().min(1) }),
  /** M3 (#1117) — a pipeline node's `datasetIds` had at least one LITERAL end,
   * which the export nulled (a concrete dataset id from another workspace is
   * meaningless). `NodeSchema.datasetIds` requires BOTH ends, so the import
   * dropped the pair whole rather than manufacture the missing half — re-point
   * it by authoring a new `PipelineVersion` once the datasets exist here.
   *
   * Unlike `unresolvedConnectionRef` this needs no envelope-side list: the
   * singular `connectionId` is nulled on EVERY node whether or not it was bound,
   * so a stripped-refs list is the only way to tell those apart, whereas
   * `datasetIds` is emitted only when the node binds a pair and a null end can
   * only mean a stripped literal. A `${}` pair is portable, survives intact, and
   * is correctly NOT reported here. */
  z.object({ type: z.literal('unresolvedDatasetRef'), nodeId: z.string().min(1) }),
  /** The exported connection had a secret bound — the ciphertext is NEVER
   * exported (see `ConnectionExportDataSchema.requiresSecret`); the importer
   * must `PATCH` a new plaintext secret in before this connection can call
   * its provider. */
  z.object({ type: z.literal('requiresSecret') }),
  /** The imported trigger's `pipelineVersionId` is `null` (every trigger
   * export nulls it) — rebind via `PATCH /api/triggers/:id` once its
   * pipeline exists in this workspace. An unbound trigger never fires. */
  z.object({ type: z.literal('unboundPipelineVersion') }),
  /** The exported trigger was a webhook trigger — its `webhook.secretRef` is
   * NEVER exported/imported (same reasoning as a connection secret), so the
   * imported trigger's `webhook` is `null` until the importer configures a
   * fresh webhook secret via `PATCH /api/triggers/:id`. */
  z.object({ type: z.literal('requiresWebhookSecret') }),
]);
export type ImportAttentionItem = z.infer<typeof ImportAttentionItemSchema>;

/**
 * The `201` response body of `POST /api/import`: the entity/entities
 * actually created (brand-new ids, owned by the importer) plus every
 * `ImportAttentionItem` the importer should act on next.
 */
export const ImportResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('pipeline'),
    pipeline: PipelineSchema,
    versions: z.array(PipelineVersionSchema),
    attention: z.array(ImportAttentionItemSchema),
  }),
  z.object({
    kind: z.literal('connection'),
    connection: ConnectionPublicSchema,
    attention: z.array(ImportAttentionItemSchema),
  }),
  z.object({
    kind: z.literal('trigger'),
    trigger: TriggerPublicSchema,
    attention: z.array(ImportAttentionItemSchema),
  }),
]);
export type ImportResult = z.infer<typeof ImportResultSchema>;
