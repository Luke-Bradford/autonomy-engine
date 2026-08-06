import type { z } from 'zod';

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
 */
export function formatZodIssues(
  issues: ReadonlyArray<z.core.$ZodIssue>,
  fallbackPath?: string,
): string {
  return issues
    .map((i) => {
      const path = i.path.join('.') || fallbackPath || '';
      return path === '' ? i.message : `${path}: ${i.message}`;
    })
    .join('; ');
}
