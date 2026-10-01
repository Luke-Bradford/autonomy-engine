import { useEffect, useId, useRef, type FormEvent, type ReactNode } from 'react';
import type { UnsavedChangesGuard } from './useUnsavedChangesGuard';

/**
 * #1396 — the create/edit drawer every resource form opens in.
 *
 * A side COLUMN of the page, not an overlay: the list beside it stays readable
 * and clickable, so "Edit" on another row works while a form is open (through
 * the page's guard), and nothing covers the row actions. Hence
 * `aria-modal="false"` and no focus trap.
 *
 * The drawer owns the `<form>`, so the footer's submit button is inside it, and
 * the layout: a header with the title and Close, a body that scrolls, and a
 * footer pinned to the bottom with its actions right-aligned, primary last.
 *
 * Every way of closing goes through `onRequestClose`, which the page routes
 * through its unsaved-changes guard; while the guard is asking, the footer
 * shows the question in place of the actions.
 */
export function FormDrawer({
  title,
  formLabel,
  className,
  guard,
  onRequestClose,
  onSubmit,
  actions,
  children,
}: {
  title: string;
  /** The form's accessible name. */
  formLabel: string;
  /** Extra class on the `<form>`, for the form's own field styles. */
  className?: string;
  guard: UnsavedChangesGuard;
  onRequestClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /** Footer buttons, secondary first and the primary (submit) LAST. */
  actions: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);

  // Focus the first field on open, and hand focus back to whatever opened the
  // drawer (the "New"/"Edit" button) when it closes.
  useEffect(() => {
    const opener = document.activeElement;
    bodyRef.current?.querySelector<HTMLElement>('input, select, textarea')?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  // The prompt takes focus while it asks, and gives it back to the form when it
  // goes: its buttons unmount, and focus left on <body> would put the drawer
  // out of reach of the keyboard, Escape included.
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (guard.confirming) keepRef.current?.focus();
    else if (wasConfirming.current) {
      bodyRef.current?.querySelector<HTMLElement>('input, select, textarea')?.focus();
    }
    wasConfirming.current = guard.confirming;
  }, [guard.confirming]);

  return (
    <aside
      className="form-drawer"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        // Escape that a control inside already handled (a picker, an IME
        // composition) is not a request to close the whole form.
        if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) {
          return;
        }
        event.preventDefault();
        if (guard.confirming) guard.keep();
        else onRequestClose();
      }}
    >
      <div className="form-drawer-header">
        <h3 id={titleId}>{title}</h3>
        <button
          type="button"
          className="form-drawer-close"
          aria-label={`Close ${title.toLowerCase()}`}
          onClick={onRequestClose}
        >
          ✕
        </button>
      </div>
      <form className={className} aria-label={formLabel} onSubmit={onSubmit}>
        <div className="form-drawer-body" ref={bodyRef}>
          {children}
        </div>
        <div className="form-drawer-footer">
          {guard.confirming ? (
            <div
              className="unsaved-confirm"
              role="alertdialog"
              aria-label="Unsaved changes"
              aria-describedby={`${titleId}-unsaved`}
            >
              <p id={`${titleId}-unsaved`}>You have unsaved changes. Discard them?</p>
              <div className="form-actions">
                <button type="button" ref={keepRef} onClick={guard.keep}>
                  Keep editing
                </button>
                <button type="button" className="danger" onClick={guard.discard}>
                  Discard changes
                </button>
              </div>
            </div>
          ) : (
            <div className="form-actions">{actions}</div>
          )}
        </div>
      </form>
    </aside>
  );
}
