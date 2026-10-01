import { useId, type ReactNode } from 'react';

/**
 * #1396 — one titled section of a resource form ("Basics", "Connection",
 * "Authentication", "Advanced"). A `fieldset` with a `legend`, so the heading
 * is the group's accessible name.
 *
 * `collapsible` sections are a `<details>`, closed unless `defaultOpen`: the
 * Advanced section holds settings most people never touch, and a form opened
 * on a row that already USES them opens it so the state is not hidden.
 */
export function FormSection({
  title,
  collapsible = false,
  defaultOpen = false,
  children,
}: {
  title: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const headingId = useId();
  if (!collapsible) {
    return (
      <fieldset className="form-section">
        <legend className="form-section-title">{title}</legend>
        <div className="form-section-body">{children}</div>
      </fieldset>
    );
  }
  return (
    <details className="form-section" open={defaultOpen}>
      <summary className="form-section-title" id={headingId}>
        {title}
      </summary>
      <div className="form-section-body" role="group" aria-labelledby={headingId}>
        {children}
      </div>
    </details>
  );
}
