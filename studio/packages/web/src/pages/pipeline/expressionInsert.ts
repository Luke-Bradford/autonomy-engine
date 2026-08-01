/**
 * The pure half of the U8a expression-insert flyout: where a chosen reference
 * lands in a field, and whether it SPLICES or REPLACES.
 *
 * Kept apart from the component so both decisions are testable without mounting
 * a canvas — the same split `configForm.ts` / `containerRules.ts` already use.
 */

/**
 * How an insert must be applied to a field.
 *
 *  - `insert`  — the field is an interpolated TEMPLATE, so the reference is
 *                spliced at the caret and the surrounding text survives.
 *  - `replace` — the field takes ONE whole-value `${...}` expression and
 *                nothing else, so splicing would produce `text${x}` and be
 *                refused at save. The whole value is replaced instead, which is
 *                destructive and therefore has to be LABELLED as such.
 */
export type InsertMode = 'insert' | 'replace';

/**
 * A field's current value with `text` applied at the caret (or over the whole
 * field), plus where the caret should land afterwards.
 *
 * A selection is REPLACED, matching what typing would do. The caret is returned
 * rather than set here because the textarea is a controlled component: the value
 * has to round-trip through React state before the DOM selection can be moved,
 * so the caller restores it after the re-render.
 */
export function applyInsert(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  text: string,
  mode: InsertMode,
): { value: string; caret: number } {
  if (mode === 'replace') return { value: text, caret: text.length };
  const start = Math.min(Math.max(selectionStart, 0), value.length);
  const end = Math.min(Math.max(selectionEnd, start), value.length);
  const next = `${value.slice(0, start)}${text}${value.slice(end)}`;
  return { value: next, caret: start + text.length };
}

/**
 * A reference that is legal in EVERY scope, used only to probe a field's shape.
 * `run.runId` is a run-level seed with no dominance question, so neither probe
 * can fail for a reason other than the one being measured.
 */
export const WHOLE_VALUE_PROBE = '${run.runId}';
/** The same reference as an interpolated TEMPLATE — the shape a splice makes. */
export const INTERPOLATED_PROBE = `x${WHOLE_VALUE_PROBE}`;

/**
 * Whether inserting into this field must replace it — i.e. whether the field is
 * whole-value-required.
 *
 * PROBED against the real validator rather than read from a table. Whole-value-
 * ness is enforced by per-activity validators inside `validateDoc`
 * (`if.condition`, `filter.items`/`predicate`, `llm_call.history`, `wait`,
 * `webhook`, `fail`) and is declared NOWHERE in the schema the form is derived
 * from — so a list of whole-value field names here would be a second reader of
 * those rules (#847's anti-pattern), silently wrong the day a new one is added
 * or an old one relaxed.
 *
 * The probe asks the one question that matters: does this field acquire a NEW
 * complaint when its value goes from a bare `${...}` to an interpolated
 * template? A type complaint the field would raise either way appears in BOTH
 * issue sets and cancels, which is why this compares sets rather than counts.
 *
 * `issuesWith(value)` must return `validatePipelineDoc` over the whole doc with
 * this one field set to `value` — the caller owns building that candidate, since
 * only it knows the node.
 */
export function insertModeFor(issuesWith: (fieldValue: string) => string[]): InsertMode {
  const whole = issuesWith(WHOLE_VALUE_PROBE);
  const interpolated = issuesWith(INTERPOLATED_PROBE);
  return interpolated.some((issue) => !whole.includes(issue)) ? 'replace' : 'insert';
}
