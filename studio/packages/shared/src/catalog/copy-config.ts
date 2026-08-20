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
/**
 * The fields both variants share, declared ONCE.
 *
 * There are two, and #1134 (M5 slice 4b) is where the second arrives: the
 * AUTHORED shape below and the DISPATCH shape an adapter re-parses. They differ
 * in exactly one field — `expression` — and in nothing else, which is why they
 * are built from this object rather than written twice. `fs-activity-config.ts`
 * states the rule this follows: an activity's config shape is read by "TWO
 * independent sites that previously each declared an inline `z.object` and could
 * silently drift (#578)". Two hand-mirrored copies here would be that defect
 * with an extra step, and 4c's catalog `configSchema` would make it three.
 */
const copyMappingEntryShape = {
  /** A source column name — XOR `expression`. */
  source: z.string().min(1).optional(),
  // `expression` — `source`'s XOR partner — is NOT declared here. It is the one
  // field whose TYPE differs between the two shapes, so `mappingArray` below
  // splices it in and documents it.
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
   * lands with the activity, which slice 3's re-split put in **slice 4**
   * (#1130) along with dataset resolution itself. It is named here so the
   * split is legible rather than lost between tickets.
   */
  onError: z.enum(['fail', 'null']).default('fail'),
};

/**
 * The shape rules that hold whatever `expression` is typed as.
 *
 * Shared as a FUNCTION rather than a parsed-then-extended schema because both
 * rules are `superRefine` checks over the whole array: they cannot be inherited
 * by extension, only re-run.
 */
const refineMapping = (
  rows: readonly { source?: unknown; expression?: unknown; sink: string }[],
  ctx: z.RefinementCtx,
) => {
  const seenSinks = new Set<string>();
  rows.forEach((row, i) => {
    // The XOR. Both issues carry a PER-ELEMENT `path` so a message names its own
    // row rather than the whole array. Two precedents, both in-tree: #1087's
    // `roots.superRefine` (`server/src/connectors/fs.ts`, `path: [index]`),
    // whose docstring makes the argument — "a whole-array check would have
    // reported only `roots`, which reads fine with one root and uselessly with
    // several" — and `refuseDuplicateNames` (`schemas/pipeline.ts`), which emits
    // `[i, 'name']` for the same reason.
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
};

/**
 * Splices `expression` — the field that is the whole reason this file exists —
 * onto the shared shape, and applies the rules that hold whatever it is typed as.
 *
 * `expression` is a `${}` expression producing the value, XOR `source`. Its TYPE
 * is the parameter because the two call sites disagree about it, and the callers
 * below say why. The constraint that forces the disagreement: by the time a copy
 * reaches an adapter this field has been through the reducer, and a whole-value
 * `${}` reference PRESERVES ITS NATIVE TYPE (`engine/params.ts:740`) — so
 * `expression: '${params.limit}'` arrives as a NUMBER, and re-parsing
 * `preparedInput` through a string-typed schema would refuse a working pipeline
 * at dispatch. The pump types the substituted constant `unknown` for exactly this
 * reason (`datamove/pump.ts`), and it is a constant per DISPATCH rather than per
 * row, because §8 puts substitution in the reducer.
 */
const mappingArray = (expression: z.ZodType) =>
  z.array(z.object({ ...copyMappingEntryShape, expression }).strict()).superRefine(refineMapping);

/**
 * The AUTHORED mapping — what a node's config holds and what an author edits.
 * `expression` is the `${}` TEMPLATE, so it is a string here.
 */
export const CopyMappingSchema = mappingArray(z.string().optional());

/**
 * The DISPATCH mapping — what an adapter re-parses out of `preparedInput`.
 *
 * `expression` is `unknown` because by this point it is the SUBSTITUTED VALUE,
 * not the template: substitution happens in the reducer (§8), and a whole-value
 * reference PRESERVES ITS NATIVE TYPE (`engine/params.ts:740`). So
 * `expression: '${params.limit}'` reaches an adapter as a NUMBER and
 * `'${params.enabled}'` as a BOOLEAN. Re-parsing dispatch input through the
 * authored schema would refuse a working pipeline — the exact regression the
 * `expression` docblock above predicts, and the one this variant exists to stop.
 * The pump types the substituted constant `unknown` for the same reason.
 */
export const CopyDispatchMappingSchema = mappingArray(z.unknown().optional());

/**
 * The whole authored `copy` config as an ADAPTER receives it (#1134, §6.1+§4).
 *
 * Not `.strict()`, matching `fs-activity-config.ts`'s activity schemas: the
 * dispatch path re-parses a `preparedInput` the reducer built, and refusing an
 * unrecognised key there would turn an additive config field into a dispatch-time
 * failure for pipelines already saved.
 *
 * `mode` defaults to the NON-DESTRUCTIVE arm. `'overwrite'` DELETEs inside the
 * write transaction (§4), so a default that erased the sink on an omitted field
 * would be the worst possible polarity for a mistyped config.
 *
 * §13 also lists a per-copy batch size among the node's flat scalars. It is NOT
 * declared here: `SqliteDatasetRead.batchRows` already defaults to
 * `COPY_BATCH_ROWS`, and exposing an author-set scheduling quantum is an
 * authoring-surface decision that belongs with the mapping panel (M8), not with
 * the first adapter that runs one.
 */
export const copyDispatchInputSchema = z.object({
  mapping: CopyDispatchMappingSchema,
  mode: z.enum(['append', 'overwrite']).default('append'),
});

export type CopyMapping = z.infer<typeof CopyMappingSchema>;
export type CopyDispatchInput = z.infer<typeof copyDispatchInputSchema>;
