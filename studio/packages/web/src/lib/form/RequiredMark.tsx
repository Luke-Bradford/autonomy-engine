/**
 * #1396 — the visual "required" asterisk. Hidden from assistive technology on
 * purpose: the control it marks carries `aria-required` (or, for a native
 * input, `required`), which is what a screen reader announces, and an asterisk
 * inside the label would otherwise be read as part of the field's name.
 */
export function RequiredMark() {
  return (
    <span className="required-mark" aria-hidden="true">
      *
    </span>
  );
}
