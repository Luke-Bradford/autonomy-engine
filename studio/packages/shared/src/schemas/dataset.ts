import { z } from 'zod';

/**
 * #9 M2 (data-movement spec §2) — a DATASET: "a thing in a store, in a shape".
 *
 * A dataset is honestly both an ADDRESS and a CONTRACT, and the spec splits it
 * by role (§2, the role table): the **address** (which store, which table/path,
 * format options) lives on this MUTABLE row, while the **contract** (the column
 * mapping) lives in a `copy` node's config inside an IMMUTABLE `PipelineVersion`
 * — a run must execute the mapping it was authored with, but resolves the
 * address live.
 *
 * Mutable, and deliberately so: only pipelines are versioned; connections and
 * triggers are already mutable rows, and run binding is preserved by
 * `runs.pipelineVersionId` being NOT NULL / `onDelete: restrict`, not by every
 * resource being versioned. A dataset address is the same class of fact as a
 * `Connection`'s `config` — read live at dispatch — so a mutable dataset is
 * CONSISTENT with the binding model rather than an exception to it (§2).
 *
 * Modelled field-for-field on `connection.ts`, which the spec names as the
 * template; the deliberate omissions (no `active` pointer, no Publish, no
 * trigger binding, no audit event) are settled in §2.4.
 */

/**
 * The CLOSED type set every column and every mapping target is drawn from
 * (§6.2). Closed on purpose: the coercion matrix defines an outcome for every
 * (source value → target type) pair, and every conversion either produces a
 * value or FAILS THE ROW — there is no "best effort" third outcome. A type
 * added here without a matrix row would be a silent corruption path.
 */
export const DataTypeSchema = z.enum([
  'string',
  'integer',
  'number',
  'boolean',
  'date',
  'timestamp',
]);
export type DataType = z.infer<typeof DataTypeSchema>;

/**
 * One column of a dataset's DECLARED schema.
 *
 * `nullable` is REQUIRED with no default, and that is the point rather than an
 * oversight: it is a fact about the store, and either default would be a wrong
 * answer stated confidently. Defaulting it `false` would refuse a legitimate
 * `onError: 'null'` mapping (§6.2's per-column opt-out is refused where the sink
 * is not nullable); defaulting it `true` would bless a mapping that pushes a
 * constraint violation into the store mid-write, after part of the output is
 * already committed. An absent fact is neither — so it is refused at the read
 * boundary, exactly as `columns` itself is.
 */
export const DatasetColumnSchema = z.object({
  name: z.string().min(1),
  type: DataTypeSchema,
  nullable: z.boolean(),
});
export type DatasetColumn = z.infer<typeof DatasetColumnSchema>;

/**
 * The dataset KIND: which reader handles it, and therefore which shape its
 * `config` carries (§2.5 settles that format lives on the DATASET — not on the
 * linked service, which would multiply the credential-bearing object for a
 * presentational distinction, and not on the copy, which would leave a dataset
 * unable to describe its own columns).
 *
 * All four land with the resource because `kind` is part of the address
 * vocabulary portability must round-trip. The READERS that give each kind's
 * `config` keys meaning arrive later — M4 (`table`/`query`), M7 (`delimited`),
 * M11 (`excel`) — and each ticket brings its own config schema then (§2.6).
 */
export const DatasetKindSchema = z.enum(['delimited', 'excel', 'table', 'query']);
export type DatasetKind = z.infer<typeof DatasetKindSchema>;

export const DatasetSchema = z.object({
  id: z.string().min(1),
  /**
   * #3 G1 — stable cross-workspace identity, on the IDENTICAL contract as
   * `ConnectionSchema.resourceId` (§2.2): server-minted, never client-writable,
   * unique per owner.
   */
  resourceId: z.string().min(1),
  ownerId: z.string().min(1).nullable(),
  name: z.string().min(1),
  /**
   * The STORE this dataset lives in — a `Connection` id.
   *
   * This is a cross-resource REFERENCE, so it is a first-class field and never a
   * `config` key: `config` is an opaque `z.record` that nothing remaps, and a
   * local DB id hidden inside one would be committed to git verbatim and
   * resolve to nothing — or to something else — on import, with nothing thrown
   * (§3's finding, one layer up). The portability layer maps it to the
   * connection's `resourceId` on the way out and back on the way in.
   */
  connectionId: z.string().min(1),
  kind: DatasetKindSchema,
  /** Kind-specific, NON-SECRET options (§2.6). The store credential stays on the
   * connection; nothing in here is a secret sink. */
  config: z.record(z.string(), z.unknown()),
  /**
   * The DECLARED schema: an authoring aid (what auto-map matches against, §6.3)
   * and a read-side drift affordance (§7's schema (1)) — never a run input. The
   * dispatch-time gate gates the node's MAPPING against the store's ACTUAL
   * columns, deliberately not this list, so a stale declaration can neither
   * block a copy that would succeed nor bless one that would fail.
   *
   * REQUIRED with NO `.default([])` (§2.2, stated there in as many words). An
   * absent column list must fail loudly at the read boundary rather than be
   * manufactured as an empty schema — the #473 lesson, and the same fail-closed
   * shape `connection.ts` already applies to `secretStatus`. An empty declared
   * schema would otherwise read as "this table has no columns", and auto-map
   * would silently produce an empty mapping.
   */
  columns: z.array(DatasetColumnSchema),
  /**
   * #2 L13b — the per-dispatch override ALLOWLIST, reused VERBATIM from
   * `ConnectionSchema.parameters` (§2.2): the owner declares which `config` keys
   * a node may override per dispatch via `${}`, and the dispatch merge refuses
   * any resolved value that is `{$secret:…}`-marker-shaped. ADF datasets are
   * parameterised and studio already has exactly this mechanism, already
   * secret-refusing — so datasets adopt it rather than growing a second one.
   *
   * `.default([])` is fail-CLOSED here (an absent allowlist declares NOTHING
   * overridable), which is why it defaults where `columns` refuses: this default
   * withholds a permission, it does not manufacture a fact. As on Connection,
   * the WRITE body must NOT inherit it — Zod applies a `.default()` even through
   * `.partial()`, so a defaulted PATCH field would silently reset a stored
   * allowlist to `[]` (see `routes/datasets.ts`).
   */
  parameters: z.array(z.string().min(1)).default([]),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Dataset = z.infer<typeof DatasetSchema>;

/** Insert shape: server sets `id`/`resourceId`/`createdAt`/`updatedAt`. */
export const NewDatasetSchema = DatasetSchema.omit({
  id: true,
  // Server-minted, like `id` — no write path (create OR patch) may supply it.
  resourceId: true,
  createdAt: true,
  updatedAt: true,
});
// `z.input` (not `z.infer`/`z.output`): every `New*` insert type in this package
// uses the PRE-parse type, so a field with `.default()` stays optional for
// callers instead of appearing spuriously required.
export type NewDataset = z.input<typeof NewDatasetSchema>;
