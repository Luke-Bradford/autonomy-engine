import { z } from 'zod';
import { InlineDatasetSchema } from './pipeline.js';

/**
 * #1600 C1q-c — the body of `POST /api/datasets/preview`.
 *
 * A union on `source` so OR10 #1401 can add a saved dataset's variant beside the
 * inline one without breaking a caller. Only the inline variant exists today: a
 * Copy or Lookup's Table or Query, as the Source tab holds it, with every bind
 * value already literal (the form asks for a value in place of each `${}`).
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
 */
export const DatasetPreviewResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    rows: z.array(z.record(z.string(), z.unknown())),
    truncated: z.boolean(),
    note: z.string().min(1).optional(),
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
export const DatasetTablesResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    tables: z.array(z.object({ schema: z.string().nullable(), name: z.string() })),
    truncated: z.boolean(),
  }),
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);
export type DatasetTablesResult = z.infer<typeof DatasetTablesResultSchema>;
