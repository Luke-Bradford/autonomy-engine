import { z } from 'zod';
import { ConnectionPublicSchema } from '../schemas/connection.js';
import { DatasetSchema } from '../schemas/dataset.js';
import { GlobalParamSchema } from '../schemas/global-param.js';
import { PipelineSchema, PipelineVersionSchema } from '../schemas/pipeline.js';
import { TriggerPublicSchema } from '../schemas/trigger.js';
import { BUNDLE_KIND } from './envelope.js';
import { ISSUE_LIST_CAP } from '../schemas/zod-issues.js';

/**
 * One thing the importer must know after `POST /api/import` succeeds — never a
 * blocking error (the import itself already succeeded). Almost every item is a
 * pointer to a manual step the normal CRUD routes already handle; the one that
 * is not, `unrunnableVersion`, reports history that cannot be repaired at all.
 */
export const ImportAttentionItemSchema = z.discriminatedUnion('type', [
  /** A pipeline node's `connectionId` came back `null` (every pipeline
   * export nulls it — see `NodeExportSchema`) — rebind it by authoring a new
   * `PipelineVersion` (versions are immutable) once a connection exists in
   * this workspace. */
  z.object({ type: z.literal('unresolvedConnectionRef'), nodeId: z.string().min(1) }),
  /** M3 (#1117) — a pipeline node's `datasetIds` had at least one LITERAL end,
   * which the export nulled (a concrete dataset id from another workspace is
   * meaningless). The import dropped the binding whole rather than manufacture
   * the missing half — re-point it by authoring a new `PipelineVersion` once the
   * datasets exist here.
   *
   * M12 slice 1 (#1220) — this used to rest on "`NodeSchema.datasetIds` requires
   * BOTH ends", which is no longer true: `sink` is optional, so `{source}` alone
   * is savable. The rule now rests on the distinction between NULL and ABSENT
   * (`portability/envelope.ts`) — a NULLED end is one that WAS bound and cannot
   * be resolved here, so the binding still drops and is still reported, while an
   * ABSENT sink means none was ever bound and is not an attention item at all.
   * Reporting the latter would ask an operator to repair something intact.
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
  /** #1492 — a HISTORICAL version (not the head) was saved before #1480 with an
   * activity type or literal config its adapter refuses. It is imported as it
   * was, because versions are immutable and the source workspace holds it the
   * same way, but it cannot run. `version` is its number in THIS workspace;
   * `issues` are the save gate's own diagnostics, capped at `ISSUE_LIST_CAP`,
   * with `totalIssues` the uncapped count. No repair step exists: the head is
   * unaffected, and a trigger or call should pin a version that runs. */
  z.object({
    type: z.literal('unrunnableVersion'),
    version: z.number().int().positive(),
    issues: z.array(z.string()).min(1).max(ISSUE_LIST_CAP),
    totalIssues: z.number().int().positive(),
  }),
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
  /** #1143 — a dataset lands already BOUND to a store (its `connectionId` is
   * NOT NULL, so there is no unbound state to report): the import either
   * resolved one or refused. Its `attention` is therefore always empty today;
   * the field stays for the uniform shape every caller reads. */
  z.object({
    kind: z.literal('dataset'),
    dataset: DatasetSchema,
    attention: z.array(ImportAttentionItemSchema),
  }),
  /** #844 GL6 — a global parameter holds no reference to rebind, so there is
   * never anything to attend to. */
  z.object({
    kind: z.literal('global-param'),
    globalParam: GlobalParamSchema,
    attention: z.array(ImportAttentionItemSchema),
  }),
]);
export type ImportResult = z.infer<typeof ImportResultSchema>;

/**
 * #1586 — the `201` body of `POST /api/import` for a bundle: one
 * `ImportResult` per member, in the bundle's order, each with its own
 * attention items. All or nothing — a refused member creates none of them.
 */
export const ImportBundleResultSchema = z.object({
  kind: z.literal(BUNDLE_KIND),
  items: z.array(ImportResultSchema),
});
export type ImportBundleResult = z.infer<typeof ImportBundleResultSchema>;

/** Every body `POST /api/import` can answer `201` with: one envelope's result,
 * or a bundle's. */
export const ImportResponseSchema = z.union([ImportResultSchema, ImportBundleResultSchema]);
export type ImportResponse = z.infer<typeof ImportResponseSchema>;
