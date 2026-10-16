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
