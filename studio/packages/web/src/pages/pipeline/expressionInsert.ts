/**
 * The pure half of the U8a expression-insert flyout: where a chosen reference
 * lands in a field, and whether it SPLICES or REPLACES.
 *
 * Kept apart from the component so both decisions are testable without mounting
 * a canvas — the same split `configForm.ts` / `containerRules.ts` already use.
 */

import { refAt } from '@autonomy-studio/shared';

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
/**
 * A plain literal: no `${}`, and a valid identifier, so it satisfies every
 * literal-only field (a column name, a tool name) that any value could.
 */
export const LITERAL_PROBE = 'x';
/** The same reference as an interpolated TEMPLATE — the shape a splice makes. */
export const INTERPOLATED_PROBE = `${LITERAL_PROBE}${WHOLE_VALUE_PROBE}`;

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

/** A half-open `[start, end)` range of a field's value. */
export type WrapSpan = { start: number; end: number };

/**
 * The text a "Wrap in function" choice goes around (#864), as a half-open
 * `[start, end)` range of the field's value — or `null` when the caret is in
 * no `${}` at all, and there is nothing to wrap.
 *
 * A function is almost always wanted AROUND something already written
 * (`toUpper(X)`), which is why this wraps rather than inserting a bare
 * `${name()}` — that would be refused at save the moment it landed. The target
 * is the author's SELECTION when it sits inside one expression's body, so a
 * sub-expression can be wrapped in place; otherwise it is that expression's
 * whole body. A selection that reaches past the body — over the braces, say —
 * means the expression itself.
 */
export function wrapTarget(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): WrapSpan | null {
  const ref = refAt(value, selectionStart, selectionEnd);
  if (ref === null) return null;
  const bodyStart = ref.start + 2;
  if (selectionStart < selectionEnd && selectionStart >= bodyStart && selectionEnd <= ref.end) {
    return { start: selectionStart, end: selectionEnd };
  }
  return { start: bodyStart, end: ref.end };
}

/**
 * `value` with `fn(...)` put around `target`, and the caret just after the
 * closing paren — still inside the expression, so a second wrap goes around
 * the first.
 */
export function applyWrap(
  value: string,
  target: WrapSpan,
  fn: string,
): { value: string; caret: number } {
  const wrapped = `${fn}(${value.slice(target.start, target.end)})`;
  return {
    value: `${value.slice(0, target.start)}${wrapped}${value.slice(target.end)}`,
    caret: target.start + wrapped.length,
  };
}
