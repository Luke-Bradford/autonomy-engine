/**
 * #1396 — the visual "required" asterisk.
 *
 * Hidden from assistive technology, and drawn by CSS (`.required-mark::after`)
 * rather than as a text node, on purpose: the control it marks carries
 * `aria-required` (or, for a native input, `required`), which is what a screen
 * reader announces, and a literal `*` in the label would become part of the
 * field's name — "Name*" — for every query, spec and label-text match.
 */
export function RequiredMark() {
  return <span className="required-mark" aria-hidden="true" />;
}
