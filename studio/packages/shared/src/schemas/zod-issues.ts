import type { z } from 'zod';

/**
 * The most validation issues any ONE rendered list echoes back — in EVERY
 * representation that list can take:
 *   - the response `issues[]` array (`server/errors.ts`, for BOTH the
 *     `validation_error` and `invalid_pipeline_doc` branches),
 *   - the joined human `message` of `InvalidPipelineDocError`
 *     (`server/repo/pipeline-versions.ts`), and
 *   - `formatZodIssues` below, the SSOT renderer behind ~44 call sites (#1183).
 *
 * ONE constant, deliberately: every representation describes the SAME underlying
 * list, and the whole point is that none of them re-emits it in full — a doc
 * whose issue count is proportional to its node/container count must not produce
 * an O(doc) body. Beyond this cap the tail is dropped and the truncation is
 * STATED (`truncated`/`totalIssues`, or "…and N more"), never silently — an
 * absent fact must not be manufactured as "that was all of them" (the F13a/#473
 * rule; #496).
 *
 * Deliberately well below the durable `RUN_DIAGNOSTIC_CAP` (500): this is a
 * synchronous 4xx returned to the caller who just sent the doc, not a durable
 * diagnostic log — 100 already exceeds what any human reads at once, and the
 * full count is still stated.
 *
 * ## Why it lives in `shared`, not `server/limits.ts` (#1183)
 *
 * It was a server constant until `formatZodIssues` — which is in `shared` and
 * cannot import from `server` — became the third consumer. The alternative was
 * to leave `formatZodIssues` the one uncapped renderer, which is exactly the
 * hole #1183 was filed for: `shared/portability/envelope.ts` throws an
 * `ImportError` whose message `server/errors.ts` sends VERBATIM as the
 * `import_error` 400 body, so a malformed envelope with one issue per node
 * produced a response of O(envelope).
 *
 * It sits beside the renderer rather than in a new `shared/limits.ts`, matching
 * `RUN_DIAGNOSTIC_CAP` (`schemas/run.ts`) which also lives beside its schema:
 * `shared` has no limits-file convention, and inventing one for a single
 * constant would create a second place to look.
 */
export const ISSUE_LIST_CAP = 100;

/**
 * Join already-rendered issue lines into one bounded operator-facing string:
 * the first `ISSUE_LIST_CAP`, then the remainder STATED as "…and N more".
 *
 * The ONE spelling of this tail (#1183). `server/repo/pipeline-versions.ts`'s
 * `summarizeIssues` had its own copy and now delegates here; the byte-identical
 * `; …and N more` (U+2026, not three dots) is asserted by `server/errors.test.ts`
 * and mirrored by `web/api/client.ts`, which reconstructs it from the server's
 * `truncated`/`totalIssues` rather than from a slice.
 *
 * ## What this bounds, and what it does NOT
 *
 * It bounds the issue COUNT, not the string LENGTH. An issue's rendered path is
 * caller-controlled — a `z.record` key of arbitrary size, or arbitrary nesting
 * depth, is one issue with an arbitrarily long path — so the result is O(largest
 * single issue), not O(1). That is the same property `errors.ts`'s `capIssues`
 * has, and it is stated rather than implied because "bounded" would claim more
 * than this delivers.
 *
 * Composition is likewise bounded but not flat: `engine/outputs.ts` feeds a
 * `formatZodIssues` string into a `validatePipelineDoc` issue, which
 * `summarizeIssues` then caps again — so an `invalid_pipeline_doc` message is
 * bounded by roughly CAP renders of CAP issues, not by CAP. A real improvement
 * over unbounded-of-unbounded, and not the same thing as constant.
 */
export function summarizeIssueList(rendered: ReadonlyArray<string>): string {
  const named = rendered.slice(0, ISSUE_LIST_CAP).join('; ');
  const rest = rendered.length - ISSUE_LIST_CAP;
  return rest > 0 ? `${named}; …and ${rest} more` : named;
}

/**
 * Render a Zod failure as one operator-facing line (#856).
 *
 * `issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')` had been
 * written EIGHT times across `packages/web` and `packages/shared` — and the
 * copies had already drifted into three different answers for the same case, an
 * issue whose `path` is EMPTY:
 *
 *  - four web sites printed a bare `': '` prefix with nothing before the colon;
 *  - `canvasStore` substituted a caller-supplied label for the missing path;
 *  - `formFields`, `llm-structured` and `outputs` dropped the prefix entirely.
 *
 * An empty path is not exotic — Zod reports one for any whole-object failure
 * (a wrong root type, a failed `.refine()` on the object itself) — so the four
 * plain copies were the ones actually showing an operator `": Expected object,
 * received array"`.
 *
 * This unifies on the guarded form: no path, no prefix. `fallbackPath` covers
 * `canvasStore`'s case, where the caller knows what the document IS ('pipeline',
 * 'trigger') and that name is more use than silence.
 *
 * Deliberately NOT applied to `engine/params.ts`'s four sites: those compose a
 * prefix into a longer sentence rather than joining a list, so folding them in
 * would mean bending this signature around a different shape.
 *
 * Known blind spot, carried over rather than introduced: a path of exactly `['']`
 * — a key that IS the empty string — joins to `''` and so reads as "no path",
 * taking the fallback. Every copy this replaces had the same behaviour, no schema
 * in the repo declares such a key, and distinguishing the two would mean testing
 * `path.length` separately from the joined value for a case nothing can reach.
 * Written down so the next reader does not have to re-derive that it is
 * deliberate. A numeric index is NOT affected: `[0].join('.')` is `'0'`.
 *
 * Bounded at `ISSUE_LIST_CAP` via `summarizeIssueList` (#1183) — see that
 * function for what the bound does and does not cover.
 */
export function formatZodIssues(
  issues: ReadonlyArray<z.core.$ZodIssue>,
  fallbackPath?: string,
): string {
  const rendered = issues.map((i) => {
    const path = i.path.join('.') || fallbackPath || '';
    return path === '' ? i.message : `${path}: ${i.message}`;
  });
  return summarizeIssueList(rendered);
}
