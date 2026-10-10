import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

/**
 * #1484 M2 — a `?` help: a `<details>` whose note floats over the page
 * (`.help-disclosure`), anchored to the `?`'s right edge. `inline` (#1477
 * OR29, `Section`) anchors it to the section's heading row instead, at that
 * row's width: in a scrolling dock, a note anchored to a `?` at the left would
 * hang off the panel's edge. It dismisses the way a popover does, which native
 * `<details>` does not: on Escape, when focus moves to an element outside it,
 * and on a pointer press outside it.
 *
 * A blur to NOTHING (`relatedTarget` null) is ignored: the window losing focus,
 * a click on text, or Safari, which does not focus a `<summary>` on click. A
 * click outside on something that takes no focus is the pointer listener's. That
 * listener lives only while the help is open, in an effect, so an unmount while
 * open removes it too.
 *
 * The note is `tabIndex={-1}`: a click on it then moves focus inside the help,
 * rather than to nothing.
 */
export function HelpDisclosure({
  label,
  noteId,
  inline = false,
  children,
}: {
  /** The `?`'s accessible name, also its hover. */
  label: string;
  /** The note's id, for a control's `aria-describedby`. */
  noteId: string;
  /** Anchor the open note to the enclosing positioned row, at its width. */
  inline?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const details = ref.current;
    if (!open || details === null) return;
    const doc = details.ownerDocument;
    const onDown = (ev: PointerEvent) => {
      if (!details.contains(ev.target as Node | null)) details.open = false;
    };
    doc.addEventListener('pointerdown', onDown, true);
    return () => doc.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDetailsElement>) => {
    if (e.key !== 'Escape' || !e.currentTarget.open) return;
    // Claimed, so a drawer or the expanded dock around it stays open.
    e.preventDefault();
    e.currentTarget.open = false;
    e.currentTarget.querySelector('summary')?.focus();
  };
  const onBlur = (e: FocusEvent<HTMLDetailsElement>) => {
    const to = e.relatedTarget as Node | null;
    if (to !== null && !e.currentTarget.contains(to)) e.currentTarget.open = false;
  };

  return (
    // The details only catches Escape bubbling up from its summary and note.
    // role="presentation" would strip the disclosure's own semantics.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <details
      ref={ref}
      className={inline ? 'help-disclosure help-disclosure--inline' : 'help-disclosure'}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      <summary aria-label={label} title={label}>
        ?
      </summary>
      <span id={noteId} role="note" tabIndex={-1}>
        {children}
      </span>
    </details>
  );
}

/**
 * #1594 OR40 S3c-2 — the `?` for a named thing (a section, a field, an
 * activity): "About {name}", its note anchored to the row it sits in. The one
 * home of that convention, for `Section`, `LabelledControl`'s `about` and the
 * config fields.
 */
export function AboutHelp({
  name,
  noteId,
  children,
}: {
  name: string;
  noteId: string;
  children: ReactNode;
}) {
  return (
    <HelpDisclosure label={`About ${name}`} noteId={noteId} inline>
      {children}
    </HelpDisclosure>
  );
}
