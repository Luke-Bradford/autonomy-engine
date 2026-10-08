import { useId, type ReactNode } from 'react';
import { HelpDisclosure } from '../HelpDisclosure';

/**
 * #1413 — a dock or panel section: a heading, and what the section holds. The
 * heading names the region and the hint describes it, as `FormSection`'s
 * legend and hint do for a form, so a screen reader announces both on entering
 * it. `hint` is required for the same reason it is there.
 *
 * #1477 OR29 — the hint sits behind a `?` beside the heading rather than as a
 * paragraph under it (the UI standard: labels, not prose). It is still the
 * section's `aria-describedby`: a closed `<details>`' note stays in the
 * accessibility tree as a description. The `?` is BESIDE the `h4`, never inside
 * it, so the region's name stays the heading alone.
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
      <div className="dock-section__head">
        <h4 id={headingId}>{heading}</h4>
        <HelpDisclosure label={`About ${heading}`} noteId={hintId} inline>
          {hint}
        </HelpDisclosure>
      </div>
      {children}
    </section>
  );
}
