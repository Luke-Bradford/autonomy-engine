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
 *
 * `not_applicable` (#1221, M12 slice 2) is the fourth state, and it exists
 * because that rule cuts BOTH ways. `lookup` reads a dataset WHOLE and declares
 * no column mapping at all, so there is no agreement to compute — and the three
 * prior states have no room for that fact. Folding it into `unreadable` would
 * report "this node declares no column mapping" as a FAULT on every lookup ever
 * authored, which is the same manufacturing in the other direction: inventing a
 * problem where there is none is as dishonest as inventing reassurance, and it
 * would make M9's page — the surface an operator uses to answer "is this dataset
 * still wired up correctly" — cry wolf on correct pipelines. Folding it into
 * `agrees` would be worse still, claiming a mapping checked out when none exists.
 *
 * The distinction is: `unreadable` means "this node SHOULD have a readable
 * mapping and does not", `not_applicable` means "this kind of node has no
 * mapping to read". It is decided from the CATALOG, never from the node's own
 * shape — see `agreementOf`.
 */
export const DatasetReferenceStatusSchema = z.enum([
  'agrees',
  'disagrees',
  'unreadable',
  'not_applicable',
]);
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
  /**
   * Rows that DO claim a column — what the agreement was computed over.
   *
   * On the wire because ZERO is a state the verdict cannot express. A mapping
   * that claims no column disagrees with nothing on the SOURCE side, so it
   * would otherwise render as a bare "agrees" for a copy that in fact moves no
   * column at all. The SINK end of the same node says so loudly — every NOT
   * NULL column is unwritten — but a reader on the source dataset's page sees
   * only the agreement.
   *
   * REACHABLE, not merely a legacy shape. A wholly empty `mapping: []` is
   * refused at save (#1172), but a row whose `sink` is blank is ADMITTED — the
   * #444 write gate's three cross-row rules are about identifiers and
   * duplicates, not emptiness — and such a row claims nothing. So a live,
   * savable doc can produce `mappedRows: 0` beside a non-zero `unnamedRows`.
   */
  mappedRows: z.number().int().nonnegative(),
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
