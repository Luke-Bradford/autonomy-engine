/**
 * #1466 — the confirmation dialog's "type the name" box, in one place.
 *
 * Pure (no React, no DOM), so the dialog, its unit-test helpers and the e2e
 * helpers all spell the label from these parts. A wording change then moves
 * every caller at once; `useConfirm.test.tsx` keeps one literal assertion so
 * that it cannot move silently.
 */
export const TYPED_NAME_PREFIX = 'Type ';
export const TYPED_NAME_SUFFIX = ' to confirm';

/**
 * The name as the box compares it: trimmed, with each whitespace run read as
 * one space. A connection name is any non-empty string, so it can carry
 * leading, trailing or doubled spaces that the dialog's `<strong>` does not
 * show, and an exact comparison would refuse the name the operator can see.
 *
 * A name that is ONLY whitespace keeps its exact form: normalised it would be
 * `''`, which the empty box already equals, and the guard would be open before
 * anything was typed.
 */
export function typedNameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ') || name;
}

/** The box's label, e.g. `Type Local store to confirm`. */
export function typedNameLabel(name: string): string {
  return `${TYPED_NAME_PREFIX}${typedNameKey(name)}${TYPED_NAME_SUFFIX}`;
}
