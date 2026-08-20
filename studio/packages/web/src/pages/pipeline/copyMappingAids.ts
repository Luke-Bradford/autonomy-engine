import type { AutoMapResult } from '@autonomy-studio/shared';

import type { ConfigField } from './configForm';

/**
 * #1170 M8 slice 2 — the `copy` mapping's authoring aids: auto-map (§6.3) and
 * §13's explicit *unmapped* state.
 *
 * §13 asks that "a column deliberately not copied must be visibly so, never
 * merely absent". That is implemented as an ADVISORY read off the two bound
 * datasets, not as a persisted per-column acknowledgment: the mapping element is
 * `.strict()` and has no key for one, so persisting it would mean a schema
 * change and a `CATALOG_VERSION` bump that this slice does not carry.
 */
const MAPPING_FIELD = 'mapping';

/** The cells auto-map writes. See {@link autoMappableField}. */
const AUTOMAP_CELLS = ['source', 'sink', 'type', 'onError'] as const;

/**
 * The `mapping` field, IF its rows carry the cells auto-map writes.
 *
 * A NAME plus a SHAPE gate, and the shape half is the load-bearing one:
 * `formatFieldValue`'s objectList arm refuses any undeclared column key, so a
 * row list without these four cells is one auto-map could only write a refusal
 * into. Reading the cells off the DERIVED fields keeps the Zod schema the single
 * source of truth (U7) — rename one and this follows, where a hand-written
 * per-activity list would drift.
 *
 * The name half is a plain constant rather than anything cleverer. `mapping` is
 * `copy`'s field and no other activity declares one; a field of the same name
 * and shape on a future activity would get the button and would work, which is
 * why the shape is what is checked rather than the activity type.
 */
export function autoMappableField(fields: readonly ConfigField[] | null): ConfigField | null {
  const field = fields?.find((f) => f.name === MAPPING_FIELD);
  if (!field || field.kind !== 'objectList') return null;
  const cells = new Set((field.elementFields ?? []).map((c) => c.name));
  return AUTOMAP_CELLS.every((name) => cells.has(name)) ? field : null;
}

/** What auto-map did NOT do, so a press that maps nothing still says why. */
export function describeSkips(result: AutoMapResult): string {
  const parts: string[] = [];
  if (result.alreadyMapped.length > 0) {
    parts.push(`${result.alreadyMapped.length} already mapped`);
  }
  if (result.duplicateDeclared.length > 0) {
    // NOT folded into "already mapped": the author never touched these. The
    // dataset declares two column names that differ only by case, which the
    // store treats as ONE column, so only the first could be written.
    parts.push(
      `${result.duplicateDeclared.join(', ')} ${
        result.duplicateDeclared.length === 1 ? 'differs' : 'differ'
      } from an earlier column only by case, and the sink has one such column`,
    );
  }
  if (result.ambiguous.length > 0) {
    // Named, not counted: the author has to pick the source column by hand, and
    // cannot without knowing which sink column is stuck.
    parts.push(`${result.ambiguous.join(', ')} matched more than one source column`);
  }
  if (result.unmatched.length > 0) {
    parts.push(`${result.unmatched.join(', ')} had no source column of that name`);
  }
  return parts.length > 0 ? ` Skipped: ${parts.join('; ')}.` : '';
}
