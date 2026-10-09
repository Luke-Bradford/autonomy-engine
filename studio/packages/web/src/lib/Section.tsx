import { useId, useState, type ReactNode } from 'react';
import { AboutHelp } from './HelpDisclosure';
import { Toolbar } from './PageHeader';

/**
 * #1594 OR40 S3 — the ONE section of a form, a panel or a page: its heading in
 * the section type, the `?` that says what the section holds, an optional row of
 * actions at the heading row's right end, then its content 8px below. Spacing
 * and type are decided once (`.section` in `index.css`); it replaces
 * `FormSection`'s legend, `DockSection`'s h4 and the `.panel-heading-row`.
 *
 * #1413 — every section says what it holds: `help` is required, and it is the
 * section's accessible description, so a screen reader hears it on entering the
 * section. It sits behind the `?` (labels, not prose), BESIDE the heading, never
 * inside it, so the section's name stays the heading alone.
 *
 * A section is a `group`: inside a form or a panel, which is already a named
 * part of the page, another landmark is noise. `landmark` makes it a `region`,
 * for a section that is itself a top-level part of a page (the Monitor's
 * account quota, a run's diagnostics).
 *
 * `collapsible` is a disclosure button inside the heading, not a
 * `<details>`: a `<summary>` may hold the heading but not the `?` beside it.
 * Closed unless `defaultOpen`, and it opens if `defaultOpen` turns true later,
 * so a record that loads after the form mounts and already uses the section's
 * settings never has them hidden.
 */
export function Section({
  heading,
  help,
  level = 4,
  landmark = false,
  collapsible = false,
  defaultOpen = false,
  actions,
  className,
  children,
}: {
  heading: string;
  help: ReactNode;
  /** The heading's level: 4 under a drawer or panel title (h3), 3 under a page title. */
  level?: 3 | 4;
  landmark?: boolean;
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** Controls for the heading row's right end, in a `Toolbar`. */
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  const helpId = useId();
  const bodyId = useId();
  const [open, setOpen] = useState(defaultOpen);
  const [seenDefault, setSeenDefault] = useState(defaultOpen);
  if (defaultOpen !== seenDefault) {
    setSeenDefault(defaultOpen);
    if (defaultOpen) setOpen(true);
  }
  const shown = !collapsible || open;
  const Heading = level === 3 ? 'h3' : 'h4';
  const head = (
    <div className="section__head help-row">
      <Heading id={headingId} className="section__title">
        {collapsible ? (
          <button
            type="button"
            className="section__toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((o) => !o)}
          >
            <span className="section__chevron" aria-hidden="true">
              {open ? '▾' : '▸'}
            </span>
            {heading}
          </button>
        ) : (
          heading
        )}
      </Heading>
      <AboutHelp name={heading} noteId={helpId}>
        {help}
      </AboutHelp>
      {actions !== undefined && <Toolbar>{actions}</Toolbar>}
    </div>
  );
  const body = (
    <div id={bodyId} className="section__body" hidden={!shown}>
      {children}
    </div>
  );
  const sectionClass = className === undefined ? 'section' : `section ${className}`;
  return landmark ? (
    <section className={sectionClass} aria-labelledby={headingId} aria-describedby={helpId}>
      {head}
      {body}
    </section>
  ) : (
    <div
      className={sectionClass}
      role="group"
      aria-labelledby={headingId}
      aria-describedby={helpId}
    >
      {head}
      {body}
    </div>
  );
}
