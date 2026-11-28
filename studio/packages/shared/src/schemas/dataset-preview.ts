import { z } from 'zod';
import { CopyDispatchMappingSchema } from '../catalog/copy-config.js';
import { DatasetColumnSchema } from './dataset.js';
import { InlineDatasetSchema } from './pipeline.js';

/**
 * #1600 C1q-c — the body of `POST /api/datasets/preview`.
 *
 * A union on `source` so a saved dataset's variant could sit beside the inline
 * one. Only the inline variant exists: a Copy or Lookup's Table or Query, as the
 * Source tab holds it, with every bind value already literal (the form asks for
 * a value in place of each `${}`). A saved dataset is previewed at
 * `POST /api/datasets/:id/preview` (#1401 OR10), which needs no body.
 */
export const DatasetPreviewRequestSchema = z.object({
  connectionId: z.string().min(1),
  source: z.discriminatedUnion('from', [
    z.object({ from: z.literal('inline'), inline: InlineDatasetSchema }),
  ]),
});
export type DatasetPreviewRequest = z.infer<typeof DatasetPreviewRequestSchema>;

/**
 * What a preview answers. A refusal is a 200 with `ok: false`, the posture of
 * `DatasetSheetsResultSchema` and `ConnectionProbeResultSchema`: every way it
 * fails is an authoring condition the panel shows in one place.
 *
 * `truncated` means `rows` is a prefix of what the source holds. `note` says why
 * when the reason is not simply the row cap (the first row alone is over the
 * byte cap, so `rows` is empty for that reason and not because the source is).
 *
 * #1401 OR10 — `columns` is the schema inferred from `rows`
 * (`inferDatasetColumns`): their names in order and the narrowest type every
 * shown value reads as. Empty when `rows` is.
 */
export const DatasetPreviewResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    rows: z.array(z.record(z.string(), z.unknown())),
    truncated: z.boolean(),
    note: z.string().min(1).optional(),
    columns: z.array(DatasetColumnSchema),
  }),
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);
export type DatasetPreviewResult = z.infer<typeof DatasetPreviewResultSchema>;

/**
 * #1600 C1q-c — the body of `POST /api/datasets/tables`: the connection whose
 * tables the Source tab's Table field offers. A POST beside `/preview` and
 * `/sheets`, which share its gate.
 */
export const DatasetTablesRequestSchema = z.object({ connectionId: z.string().min(1) });
export type DatasetTablesRequest = z.infer<typeof DatasetTablesRequestSchema>;

/**
 * The tables and views a connection's store lists, as Table `[▾ from the
 * connection]` offers them. `schema` is `null` for a store with no schema to
 * name (sqlite's main database). `truncated` means the list is a prefix: the
 * read stopped at Lookup's row or byte cap. A refusal is a 200 with `ok: false`,
 * as `DatasetPreviewResultSchema`.
 */
export const DatasetTableSchema = z.object({ schema: z.string().nullable(), name: z.string() });
export type DatasetTable = z.infer<typeof DatasetTableSchema>;

export const DatasetTablesResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    tables: z.array(DatasetTableSchema),
    truncated: z.boolean(),
  }),
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);
export type DatasetTablesResult = z.infer<typeof DatasetTablesResultSchema>;

/**
 * #1401 OR10 — where Import schema's columns came from. `table`: the store's
 * own column list and types for a `table` dataset, so an empty table still has
 * columns. `sample`: inferred from the preview's rows, for a file or a query.
 */
export const DatasetSchemaSourceSchema = z.enum(['table', 'sample']);
export type DatasetSchemaSource = z.infer<typeof DatasetSchemaSourceSchema>;

/**
 * #1401 OR10 — what `POST /api/datasets/:id/schema` answers: the columns Import
 * schema fills the form with. It writes nothing; the page saves them with the
 * dataset's PATCH once the operator has looked. A refusal is a 200, as preview.
 */
export const DatasetSchemaResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    columns: z.array(DatasetColumnSchema),
    from: DatasetSchemaSourceSchema,
  }),
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);
export type DatasetSchemaResult = z.infer<typeof DatasetSchemaResultSchema>;

/**
 * #1401 OR10 — the body of `POST /api/datasets/copy-preview`: the Copy node's
 * source, saved or inline, and its mapping as the panel holds it.
 *
 * The mapping is the DISPATCH shape: an `expression` is the literal value it
 * would substitute to, as Preview takes bind values literal. A saved source is
 * read as stored, without the node's per-dispatch dataset overrides.
 */
export const CopyPreviewRequestSchema = z.object({
  source: z.discriminatedUnion('from', [
    z.object({ from: z.literal('dataset'), datasetId: z.string().min(1) }),
    z.object({
      from: z.literal('inline'),
      connectionId: z.string().min(1),
      inline: InlineDatasetSchema,
    }),
  ]),
  mapping: CopyDispatchMappingSchema,
});
export type CopyPreviewRequest = z.infer<typeof CopyPreviewRequestSchema>;

/** One failing cell: the coercion's code and reason; `nulled` when the copy writes null. */
export const CopyPreviewCellFailureSchema = z.object({
  code: z.string().min(1),
  reason: z.string().min(1),
  nulled: z.boolean(),
});

/**
 * #1401 OR10 — the first source rows as the copy would hand them to the sink.
 * `values` holds every mapped sink column (a failing cell is `null`); `failures`
 * names each failing cell. A row with a failure that is not `nulled` is a row
 * the copy drops. `truncated` as preview.
 */
export const CopyPreviewResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    rows: z.array(
      z.object({
        values: z.record(z.string(), z.unknown()),
        failures: z.record(z.string(), CopyPreviewCellFailureSchema),
      }),
    ),
    truncated: z.boolean(),
    note: z.string().min(1).optional(),
  }),
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);
export type CopyPreviewResult = z.infer<typeof CopyPreviewResultSchema>;
