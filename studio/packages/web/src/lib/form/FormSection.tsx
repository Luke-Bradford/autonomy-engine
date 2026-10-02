import { useId, type ReactNode } from 'react';

/**
 * #1396 — one titled section of a resource form ("Basics", "Connection",
 * "Authentication", "Advanced"). A `fieldset` with a `legend`, so the heading
 * is the group's accessible name.
 *
 * `collapsible` sections are a `<details>`, closed unless `defaultOpen`: the
 * Advanced section holds settings most people never touch, and a form opened
 * on a row that already USES them opens it so the state is not hidden.
 *
 * #1413 — every section says what it holds in one line under its title, and
 * that line is the group's accessible description. `hint` is required, so a
 * new section without one is a compile error; the copy lives in
 * `FORM_SECTION_HINTS`, where `sectionHints.test.ts` holds it to the house rule.
 */
export function FormSection({
  title,
  hint,
  collapsible = false,
  defaultOpen = false,
  children,
}: {
  title: string;
  hint: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const headingId = useId();
  const hintId = useId();
  const hintLine = (
    <p id={hintId} className="field-hint form-section-hint">
      {hint}
    </p>
  );
  if (!collapsible) {
    return (
      <fieldset className="form-section" aria-describedby={hintId}>
        <legend className="form-section-title">{title}</legend>
        {hintLine}
        <div className="form-section-body">{children}</div>
      </fieldset>
    );
  }
  return (
    <details className="form-section" open={defaultOpen}>
      <summary className="form-section-title" id={headingId}>
        {title}
      </summary>
      <div
        className="form-section-body"
        role="group"
        aria-labelledby={headingId}
        aria-describedby={hintId}
      >
        {hintLine}
        {children}
      </div>
    </details>
  );
}
