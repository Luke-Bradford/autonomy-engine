import { z } from 'zod';
import { DataTypeSchema } from '../schemas/dataset.js';

/**
 * #996 M5 slice 1 (#1122) — the `copy` activity's MAPPING declaration
 * (data-movement spec §6.1).
 *
 * It lives here, beside `fs-activity-config.ts` and `dataset-config.ts`, because
 * that file states the rule for the whole catalog: an activity's config shape is
 * "the SINGLE SOURCE OF TRUTH … read by TWO independent sites" — the registry
 * and the server adapter. Slice 3's `copyConfigSchema` embeds this array, so
 * putting it anywhere else would strand it from its own consumer.
 *
 * §6.3 is the most important decision behind this shape, and it is the reason
 * the mapping is DECLARED rather than derived: auto-map is an AUTHORING action
 * that writes an explicit mapping into the node's config, and it never runs at
 * dispatch. Resolved at dispatch, renaming a source column would silently
 * re-map — the pipeline would keep succeeding while writing different data to
 * different columns, with nothing in the log to show it. #1077 settled the same
 * question the same way for run-log attribution; mapping is strictly more
 * dangerous, because the artefact is the user's data.
 */
const CopyMappingEntrySchema = z
  .object({
    /** A source column name — XOR `expression`. */
    source: z.string().min(1).optional(),
    /** A `${}` expression producing the value — XOR `source`. */
    expression: z.string().optional(),
    /** The sink column this row writes. */
    sink: z.string().min(1),
    /**
     * The TARGET type, declared and never inferred. Drawn from the closed
     * `DataTypeSchema` set (`schemas/dataset.ts`) precisely because §6.2 defines
     * an outcome for every (source value → target type) pair: a type reachable
     * here without a matrix row would be a silent corruption path.
     */
    type: DataTypeSchema,
    /**
     * §6.2's per-column opt-out. `'fail'` (the default) fails the ROW on a
     * coercion failure; `'null'` writes a null instead.
     *
     * The refusal that pairs with it — `'null'` is REFUSED where the sink column
     * is `nullable: false`, because accepting it pushes the failure into the
     * store as a constraint violation, by which time part of the output is
     * already written — needs the RESOLVED sink dataset's columns and therefore
     * lands with the activity in slice 3. It is named here so the split is
     * legible rather than lost between tickets.
     */
    onError: z.enum(['fail', 'null']).default('fail'),
  })
  .strict();

export const CopyMappingSchema = z.array(CopyMappingEntrySchema).superRefine((rows, ctx) => {
  const seenSinks = new Set<string>();
  rows.forEach((row, i) => {
    // The XOR. Both issues carry a PER-ELEMENT `path` so a message names its own
    // row rather than the whole array — #1087's precedent, and the same reason
    // `refuseDuplicateNames` (`schemas/pipeline.ts`) emits `[i, 'name']`.
    const hasSource = row.source !== undefined;
    const hasExpression = row.expression !== undefined;
    if (hasSource === hasExpression) {
      ctx.addIssue({
        code: 'custom',
        path: [i, hasSource ? 'expression' : 'source'],
        message: hasSource
          ? "a mapping row takes either 'source' or 'expression', never both"
          : "a mapping row needs either 'source' or 'expression'",
      });
    }
    // Two rows writing one sink column is silent LAST-WINS into the operator's
    // store — the same class of defect the duplicate-name rule exists for, and
    // not one a store reports, because the second write is perfectly valid SQL.
    if (seenSinks.has(row.sink)) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'sink'],
        message: `duplicate sink column '${row.sink}' (each sink column may be written by one mapping row)`,
      });
    }
    seenSinks.add(row.sink);
  });
});

export type CopyMapping = z.infer<typeof CopyMappingSchema>;
