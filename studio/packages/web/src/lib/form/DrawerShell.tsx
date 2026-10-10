import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { isUnhandledEscape } from '../escape';

/** The first field a person can type into: read-only ones are skipped. */
export const FIRST_FIELD = 'input:not([readonly]), select, textarea:not([readonly])';

/**
 * #1477 — the drawer chrome every side drawer shares: the dialog column, its
 * header (title + Close), the Escape rule, and focus in on open / back out on
 * close. `FormDrawer` puts a `<form>` inside it; the connection-kind gallery
 * puts a picker inside it. One chrome, so the two cannot drift.
 *
 * A side COLUMN of the page, not an overlay: the list beside it stays readable
 * and clickable. Hence `aria-modal="false"` and no focus trap. A `div`, because
 * `aside` may not carry the `dialog` role.
 */
export function DrawerShell({
  title,
  onEscape,
  onClose,
  closeDisabled = false,
  returnFocusTo,
  children,
}: {
  title: string;
  /** Escape that no control inside already handled. */
  onEscape: () => void;
  /** The header's ✕. */
  onClose: () => void;
  closeDisabled?: boolean;
  /**
   * Where focus goes when the drawer closes. Defaults to whatever had focus
   * when it opened, which is wrong when the open came through the guard's
   * prompt (focus was on "Discard changes" by then), so a page passes the
   * button that really opened it.
   */
  returnFocusTo?: RefObject<HTMLElement | null>;
  /** Everything under the header: a body that scrolls and a pinned footer. */
  children: ReactNode;
}) {
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  // On open, focus the first field the operator can change: a read-only Name
  // on an edit form is information, not where typing goes. A field marked
  // `data-autofocus` wins, for a body whose first field is a shortcut rather
  // than where typing usually goes. On close, hand focus back to whatever
  // opened the drawer (the "New"/"Edit" button).
  useEffect(() => {
    const opener = returnFocusTo?.current ?? document.activeElement;
    const root = rootRef.current;
    (
      root?.querySelector<HTMLElement>('[data-autofocus]') ??
      root?.querySelector<HTMLElement>(FIRST_FIELD)
    )?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
    // Mount-only: the opener is whatever it was when this drawer opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    // Escape closes a dialog. The plugin exempts keyboard handlers on a dialog,
    // but matches the <dialog> tag only, not role="dialog".
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={rootRef}
      className="form-drawer"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        // Escape that a control inside already handled (a picker, an IME
        // composition) is not a request to close the whole drawer.
        if (!isUnhandledEscape(event)) return;
        event.preventDefault();
        onEscape();
      }}
    >
      <div className="form-drawer-header">
        <h2 id={titleId}>{title}</h2>
        <button type="button" aria-label="Close" onClick={onClose} disabled={closeDisabled}>
          ✕
        </button>
      </div>
      {children}
    </div>
  );
}
