import { useEffect, useRef, type FormEvent, type ReactNode, type RefObject } from 'react';
import type { UnsavedChangesGuard } from './useUnsavedChangesGuard';
import { DrawerShell, FIRST_FIELD } from './DrawerShell';
import { firstBadInput, focusFirstInvalid, type FieldValidation } from './fieldValidation';
import { UnsavedChangesPrompt } from './UnsavedChangesPrompt';

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
  /**
   * A save or test in flight: Close and Escape wait for it, as Cancel does, and
   * the fields are inert (#1438) — anything typed after Save was pressed would
   * be dropped when the drawer closes on success, and a test's verdict would
   * describe values no longer on screen.
   */
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
  const bodyRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);

  // #1438 — making the body inert drops focus from the field the operator
  // pressed Enter in. The last field focused is remembered (as it happens, so
  // nothing has moved it yet) and given focus back when the form is live again,
  // unless focus has gone somewhere real since. Declared before the
  // invalid-field effect below, so a refused save still lands on its field.
  const lastFocused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (busy) return;
    const field = lastFocused.current;
    const stranded = document.activeElement === null || document.activeElement === document.body;
    if (stranded && field !== null && field.isConnected) field.focus();
  }, [busy]);

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
    <DrawerShell
      title={title}
      onEscape={() => {
        if (guard.confirming) guard.keep();
        else if (!busy) onRequestClose();
      }}
      onClose={onRequestClose}
      closeDisabled={busy}
      returnFocusTo={returnFocusTo}
    >
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
        <div
          className="form-drawer-body"
          ref={bodyRef}
          inert={busy}
          aria-busy={busy || undefined}
          onFocus={(event) => {
            if (event.target instanceof HTMLElement) lastFocused.current = event.target;
          }}
        >
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
    </DrawerShell>
  );
}
