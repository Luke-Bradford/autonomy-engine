import { z } from 'zod';
import { MappingAgreementSchema } from './mapping-agreement.js';

/**
 * #996 M9 (#1185) — the wire shape of "which of my pipelines reference this
 * dataset, and which of their mappings no longer agree with it".
 *
 * §2.1 names this a READ-SIDE AFFORDANCE, not a write-side gate: "a dataset
 * cannot cheaply know its consumers at save time". Nothing computed from this
 * refuses anything — the only refusal in the data-movement layer is §7's
 * dispatch gate, which compares the mapping against the store's ACTUAL columns
 * rather than the dataset's declared ones (§7:633).
 */

/** Which END of a `copy` node the dataset is bound to. */
export const DatasetReferenceEndSchema = z.enum(['source', 'sink']);
export type DatasetReferenceEnd = z.infer<typeof DatasetReferenceEndSchema>;

/**
 * WHY this version is walked at all. Not decoration: it is the answer to "will
 * editing this dataset affect anything", and the three have different force.
 *
 * - `latest` — the newest version of the pipeline. What a DB-only workspace
 *   binds a new trigger to, and what an author is editing against.
 * - `active` — the published version a GIT-mode workspace binds to
 *   (`routes/triggers.ts`'s `resolveBindToActive`). In a git workspace this,
 *   not `latest`, is what a new binding fires.
 * - `trigger` — a version an existing trigger pins. A trigger records
 *   `pipelineVersionId` ONCE, at creation, so it can lag both of the above.
 */
export const DatasetReferenceBindingSchema = z.enum(['latest', 'active', 'trigger']);
export type DatasetReferenceBinding = z.infer<typeof DatasetReferenceBindingSchema>;

/**
 * `unreadable` is deliberately NOT foldable into `agrees`. A `copy` node with no
 * readable mapping is an unknown, and reporting an unknown as agreement would
 * manufacture an absent fact into a reassuring one — the failure #473 was filed
 * for, and the same polarity as "a `gh` failure is never CI-green".
 */
export const DatasetReferenceStatusSchema = z.enum(['agrees', 'disagrees', 'unreadable']);
export type DatasetReferenceStatus = z.infer<typeof DatasetReferenceStatusSchema>;

export const DatasetReferenceSchema = z.object({
  pipelineId: z.string().min(1),
  pipelineName: z.string(),
  /** Archived pipelines are REPORTED, flagged — they can be un-archived. */
  pipelineArchived: z.boolean(),
  versionId: z.string().min(1),
  version: z.number().int().positive(),
  boundBy: z.array(DatasetReferenceBindingSchema).min(1),
  /** The triggers pinning this version, when `boundBy` includes `trigger`. */
  triggerIds: z.array(z.string()),
  nodeId: z.string().min(1),
  nodeType: z.string().min(1),
  end: DatasetReferenceEndSchema,
  status: DatasetReferenceStatusSchema,
  /** `null` exactly when `status` is `unreadable`. */
  agreement: MappingAgreementSchema.nullable(),
  /** Why the mapping could not be read. `null` unless `status` is `unreadable`. */
  unreadable: z.string().nullable(),
  /**
   * Mapping rows claiming no sink column. Zero for any mapping the #444 write
   * gate admitted; non-zero is itself worth saying rather than dropping.
   */
  unnamedRows: z.number().int().nonnegative(),
});
export type DatasetReference = z.infer<typeof DatasetReferenceSchema>;

/**
 * A dataset end this walk CANNOT resolve, named rather than counted.
 *
 * `Node.datasetIds` may hold a `${}` expression (`schemas/pipeline.ts`'s
 * `datasetIds` docblock), whose value is only known at dispatch. Such a node may
 * well address this dataset, so omitting it silently would let the page report
 * "nothing references this" over a pipeline that does.
 */
export const DatasetDynamicReferenceSchema = z.object({
  pipelineId: z.string().min(1),
  pipelineName: z.string(),
  versionId: z.string().min(1),
  version: z.number().int().positive(),
  nodeId: z.string().min(1),
  nodeType: z.string().min(1),
  end: DatasetReferenceEndSchema,
});
export type DatasetDynamicReference = z.infer<typeof DatasetDynamicReferenceSchema>;

export const DatasetReferencesResponseSchema = z.object({
  references: z.array(DatasetReferenceSchema),
  dynamic: z.array(DatasetDynamicReferenceSchema),
});
export type DatasetReferencesResponse = z.infer<typeof DatasetReferencesResponseSchema>;
