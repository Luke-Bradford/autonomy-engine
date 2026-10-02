import { useId, type ReactNode } from 'react';

/**
 * #1413 — a dock or panel section: a heading, then one line saying what the
 * section holds. The heading names the region and the line describes it, as
 * `FormSection`'s legend and hint do for a form, so a screen reader announces
 * both on entering it. `hint` is required for the same reason it is there.
 *
 * An `h4` rather than `FormSection`'s `legend`: these sit in the property dock
 * and the run monitor's node panel beside other `h4`-headed parts, and a hint may
 * be markup (a `${…}` reference in `<code>`), which `FormSection`'s string hint
 * is not.
 */
export function DockSection({
  heading,
  hint,
  children,
}: {
  heading: string;
  hint: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  const hintId = useId();
  return (
    <section className="contract-section" aria-labelledby={headingId} aria-describedby={hintId}>
      <h4 id={headingId}>{heading}</h4>
      <p id={hintId} className="page-hint">
        {hint}
      </p>
      {children}
    </section>
  );
}
