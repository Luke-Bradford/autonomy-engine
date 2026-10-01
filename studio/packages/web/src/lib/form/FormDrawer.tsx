import { useEffect, useId, useRef, type FormEvent, type ReactNode, type RefObject } from 'react';
import type { UnsavedChangesGuard } from './useUnsavedChangesGuard';
import { firstBadInput, focusFirstInvalid, type FieldValidation } from './fieldValidation';
import { UnsavedChangesPrompt } from './UnsavedChangesPrompt';

/** The first field a person can type into: read-only ones are skipped. */
const FIRST_FIELD = 'input:not([readonly]), select, textarea:not([readonly])';

/**
 * #1396 — the create/edit drawer every resource form opens in.
 *
 * A side COLUMN of the page, not an overlay: the list beside it stays readable
 * and clickable, so "Edit" on another row works while a form is open (through
 * the page's guard), and nothing covers the row actions. Hence
 * `aria-modal="false"` and no focus trap. A `div`, because `aside` may not
 * carry the `dialog` role.
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
  busy = false,
  returnFocusTo,
  status,
  validation,
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
  /** A save or test in flight: Close and Escape wait for it, as Cancel does. */
  busy?: boolean;
  /**
   * Where focus goes when the drawer closes. Defaults to whatever had focus
   * when it opened, which is wrong when the open came through the guard's
   * prompt (focus was on "Discard changes" by then), so a page passes the
   * button that really opened it.
   */
  returnFocusTo?: RefObject<HTMLElement | null>;
  /** The form's error and result messages, shown in the footer above the actions. */
  status?: ReactNode;
  /**
   * The form's inline validation (`useFieldValidation`). With it the form
   * checks its own fields (`noValidate`: the browser's "fill out this field"
   * bubble would pre-empt the inline message), its edits and blurs are seen,
   * and a refused submit moves focus to the first invalid field.
   */
  validation?: FieldValidation;
  /** Footer buttons, secondary first and the primary (submit) LAST. */
  actions: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);

  // On open, focus the first field the operator can change: a read-only Name
  // on an edit form is information, not where typing goes. On close, hand
  // focus back to whatever opened the drawer (the "New"/"Edit" button).
  useEffect(() => {
    const opener = returnFocusTo?.current ?? document.activeElement;
    bodyRef.current?.querySelector<HTMLElement>(FIRST_FIELD)?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
    // Mount-only: the opener is whatever it was when this drawer opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The prompt takes focus while it asks, and gives it back to the form when it
  // goes: its buttons unmount, and focus left on <body> would put the drawer
  // out of reach of the keyboard, Escape included.
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (guard.confirming) keepRef.current?.focus();
    else if (wasConfirming.current) {
      bodyRef.current?.querySelector<HTMLElement>(FIRST_FIELD)?.focus();
    }
    wasConfirming.current = guard.confirming;
  }, [guard.confirming]);

  // After the errors are on screen, not when they were raised: focusing first
  // would read the field to assistive tech without its error.
  const focusRequest = validation?.focusRequest ?? 0;
  useEffect(() => {
    if (focusRequest > 0 && bodyRef.current !== null) focusFirstInvalid(bodyRef.current);
  }, [focusRequest]);

  return (
    <div
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
        else if (!busy) onRequestClose();
      }}
    >
      <div className="form-drawer-header">
        <h3 id={titleId}>{title}</h3>
        <button type="button" aria-label="Close" onClick={onRequestClose} disabled={busy}>
          ✕
        </button>
      </div>
      <form
        className={className}
        aria-label={formLabel}
        onSubmit={(event) => {
          // #1396 — `noValidate` also turns off the browser's refusal of input
          // it could not read (`1e` in a number box reads as ''), which a page
          // would take for a blank and quietly drop. Refused here, for every
          // form that checks its own fields.
          const bad = validation === undefined ? null : firstBadInput(event.currentTarget);
          if (validation !== undefined && bad !== null) {
            event.preventDefault();
            validation.refuseBadInput(bad);
            return;
          }
          onSubmit(event);
        }}
        noValidate={validation !== undefined}
        {...validation?.formHandlers}
      >
        <div className="form-drawer-body" ref={bodyRef}>
          {children}
        </div>
        <div className="form-drawer-footer">
          {guard.confirming ? (
            <UnsavedChangesPrompt guard={guard} keepRef={keepRef} />
          ) : (
            <>
              {status}
              <div className="form-actions">{actions}</div>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
