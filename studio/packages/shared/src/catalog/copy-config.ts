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
 * The mapping's WHOLE-ARRAY rules, as plain data so two independent gates can
 * share ONE declaration of them (#1176).
 *
 * There are three, and what they have in common is that none of them is a
 * property of a single field: a copy that maps nothing, two rows writing one
 * sink column, and the `source`/`expression` XOR. Zod expresses them as a
 * `superRefine` because they are cross-row; the #444 write gate
 * (`engine/params.ts`) needs the same three against a `Node.config['mapping']`
 * it holds as `unknown`. Returning issues as data is what lets both call it
 * rather than one of them re-deriving it — the drift `fs-activity-config.ts`
 * names (#578), which is how these rules came to be enforced on the canvas and
 * at dispatch but NOT at the gate that mints the version.
 *
 * `rows` is `readonly unknown[]`, not a typed row array, and that is
 * load-bearing rather than defensive: the write gate reaches this with whatever
 * an operator's git repo held, and `params.ts` pins non-object rows and
 * non-string fields as SILENT SKIPS. Typing the parameter would put a
 * `TypeError` on the gate's own path — a 500 where a 400 belongs. On the Zod
 * side the element parse runs BEFORE this, so it never sees a malformed row and
 * the widened type costs it nothing.
 *
 * The rejected alternative, recorded because it is the obvious one: have the
 * gate `CopyMappingSchema.safeParse(mapping)` instead. It refuses far more than
 * these three — the schema is `.strict()` with a required `type` and a
 * `sink.min(1)` — so it would turn every pinned per-field type skip into a
 * refusal, and make the gate a second, stricter authority on a shape the
 * adapter already owns. These three are the cross-row rules specifically
 * because those are the ones NOTHING else can see in time.
 */
export function copyMappingShapeIssues(
  rows: readonly unknown[],
): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  // The CARDINALITY rule, on the array itself — `connection-config.ts`'s `roots`
  // ("an fs connection needs at least one allowed root") is the precedent. A
  // copy that maps no columns runs clean and moves nothing, which is the
  // silent-wrong direction every refusal in this file exists to avoid.
  if (rows.length === 0) {
    issues.push({ path: [], message: 'a copy maps no columns — add at least one mapping row' });
    return issues;
  }
  const seenSinks = new Set<string>();
  rows.forEach((raw, i) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
    const row = raw as { source?: unknown; expression?: unknown; sink?: unknown };
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
      issues.push({
        path: [i, hasSource ? 'expression' : 'source'],
        message: hasSource
          ? "a mapping row takes either 'source' or 'expression', never both"
          : "a mapping row needs either 'source' or 'expression'",
      });
    }
    // Two rows writing one sink column is silent LAST-WINS into the operator's
    // store — the same class of defect the duplicate-name rule exists for, and
    // not one a store reports, because the second write is perfectly valid SQL.
    //
    // Compared as STRINGS, deliberately: a sink name that differs only in case
    // is caught downstream by `resolveSinkColumns`, which folds it onto the
    // store's own spelling and refuses the collision with the store's answer for
    // what "the same column" means (#1151). Folding here would be a second,
    // store-blind opinion about that.
    if (typeof row.sink !== 'string') return;
    if (seenSinks.has(row.sink)) {
      issues.push({
        path: [i, 'sink'],
        message: `duplicate sink column '${row.sink}' (each sink column may be written by one mapping row)`,
      });
    }
    seenSinks.add(row.sink);
  });
  return issues;
}

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
  z
    .array(z.object({ ...copyMappingEntryShape, expression }).strict())
    // All three whole-array rules — cardinality (#1172), the XOR, and the
    // duplicate sink — replayed from `copyMappingShapeIssues` rather than
    // declared here, because the #444 write gate enforces the same three
    // against an untyped `Node.config['mapping']` (#1176) and two hand-mirrored
    // copies of a cross-row rule are exactly the drift #578 names.
    //
    // The emitted issues are UNCHANGED by that move. The cardinality rule still
    // lands on `path: []` — an empty array has no row to name — which nested
    // under `copyInputSchema` emerges as `['mapping']`, so `formatZodIssues`
    // still prefixes it with the control an author can see. That prefix is the
    // point: `dataset-config.ts`'s object-level `superRefine` documents the
    // failure mode of losing it — an operator told two things clash but not
    // which control to touch. The only difference is the issue CODE
    // (`too_small` became `custom`), which nothing reads: the sole `issue.code`
    // consumer in the tree is `paramRules.ts`, scoped to params and outputs.
    //
    // SCOPE, stated so it is not overread: these three now hold on all three
    // paths — the canvas Apply pre-check, the #444 write gate (so git-import
    // and a direct POST too), and dispatch. What the gate still does NOT read is
    // per-FIELD types, which stay the schema's and the adapter's: `params.ts`
    // pins those as silent skips, and its docblock says why.
    .superRefine((rows, ctx) => {
      for (const issue of copyMappingShapeIssues(rows)) {
        ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
      }
    });

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
 * The whole `copy` config, minus the one field the two variants disagree about
 * (#1134, §6.1+§4). Both variants below are built from this, for the reason the
 * `expression` docblock above gives about `mapping`: two independent `z.object`s
 * are how a shared config drifts (#578).
 *
 * Neither variant is `.strict()`, matching `fs-activity-config.ts`'s activity
 * schemas. Two independent reasons, one per variant: the dispatch path re-parses
 * a `preparedInput` the reducer built, and refusing an unrecognised key there
 * would turn an additive config field into a dispatch-time failure for pipelines
 * already saved; and the AUTHORED variant is handed a node's whole `config`
 * blob by the canvas — `config.outputs` included (#1 F13) — which a strict
 * schema would reject on every edit.
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
const copyInputShape = <T extends z.ZodType>(mapping: T) =>
  z.object({
    mapping,
    mode: z.enum(['append', 'overwrite']).default('append'),
  });

/**
 * The AUTHORED `copy` config — what a node's `config` holds, what the catalog
 * entry declares as its `configSchema` (M5 slice 4c, #1139), and what the
 * canvas validates an edit against before applying it.
 *
 * Differs from the dispatch variant in exactly ONE field, `mapping`, and shares
 * everything else through `copyInputShape` rather than by re-declaration. That
 * is not tidiness: `fs-activity-config.ts` states the rule this file's own
 * docblock cites — a config read by two independent sites that each declare
 * their own `z.object` is how they silently drift (#578) — and a hand-mirrored
 * `mode` here would have been the third copy.
 *
 * `mapping` is REQUIRED, with no `.default([])`. An empty default would author a
 * copy that runs clean and moves nothing, which is the silent-wrong direction
 * every refusal in this file exists to avoid; a missing mapping should be a
 * refusal an author can see. The cost this used to carry is PAID: until #1169
 * `deriveConfigFields` could not represent an array-of-objects, so the whole
 * copy form degraded to the JSON textarea and `mode` could not be set without
 * hand-typing a `mapping` beside it. M8 slice 1 built the general `objectList`
 * control §13 asked for, so a mapping is now authored as named row controls.
 */
export const copyInputSchema = copyInputShape(CopyMappingSchema);

/**
 * The DISPATCH variant — what an adapter re-parses out of `preparedInput`
 * (#1134). See `CopyDispatchMappingSchema` for why `expression` is `unknown` by
 * the time it gets here.
 */
export const copyDispatchInputSchema = copyInputShape(CopyDispatchMappingSchema);

export type CopyMapping = z.infer<typeof CopyMappingSchema>;
export type CopyInput = z.infer<typeof copyInputSchema>;
export type CopyDispatchInput = z.infer<typeof copyDispatchInputSchema>;
