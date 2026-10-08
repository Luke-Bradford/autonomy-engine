import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import {
  useUnsavedChangesGuard,
  type UnsavedChangesGuard,
  type UnsavedChangesGuardOptions,
} from './useUnsavedChangesGuard';

/**
 * #1396 — the page-side state of a resource form that opens in a `FormDrawer`:
 * which form is open, whether it has unsaved changes, and the guard that holds
 * every way out of it. One hook so each page that adopts the pattern does not
 * re-derive the open counter and the dirty check.
 *
 * `signatureOf` turns a form into what Save would write, as one comparable
 * string (see `payloadSignature`). "Dirty" is that against the value taken when
 * the form opened.
 */
export interface DrawerForm<F> {
  /** The open form, or `null` when the drawer is closed. */
  readonly form: F | null;
  /** Edit the open form, or close it with `null` (bypassing the guard). */
  readonly setForm: Dispatch<SetStateAction<F | null>>;
  /**
   * Open `next` now. Pages call it inside `guard.request`. `baseline` is what
   * "dirty" compares against, `next` itself by default; a form opened already
   * holding the operator's input (#1477 paste-to-detect) passes the blank form,
   * so closing it asks first.
   */
  readonly openForm: (next: F, baseline?: F) => void;
  /**
   * How many times a form has been OPENED; mount the form with this as its
   * `key`.
   *
   * Keying on the record's id is not enough. "New" is not gated behind the
   * form being closed, so pressing it with a new form already open leaves the
   * id at `null` (no remount) while the blank form is byte-identical, and any
   * state the form holds about the previous draft (a probe verdict, a sheet
   * listing) would render against a form that never produced it. A counter
   * cannot collide with itself, so every way of opening a form starts it clean.
   */
  readonly seq: number;
  /**
   * Whether `seq` is still the latest open. A save keeps running after its
   * form is gone (Edit on another row, then Discard, while it is in flight),
   * and its `onSaved` must close only the form it belongs to, never the one
   * opened since.
   */
  readonly isLatest: (seq: number) => boolean;
  readonly guard: UnsavedChangesGuard;
  /** The open form differs from what it opened with. #1476 — a host that holds
   * route changes itself (the editor) folds this into its own guard. */
  readonly dirty: boolean;
  /**
   * The button that opened the form on screen, so closing it returns focus
   * there. Set it when the open actually HAPPENS (inside the guarded action),
   * so a held "Edit" that the operator then abandons does not steal it.
   */
  readonly openerRef: RefObject<HTMLElement | null>;
  /**
   * Run `open` (which calls `openForm`) from the button the operator pressed,
   * through the guard: a dirty form asks first, and the opener is recorded only
   * if the open goes ahead.
   */
  readonly openFrom: (opener: HTMLElement, open: () => void) => void;
  /** Close the form through the guard (Cancel, Close, Escape). */
  readonly requestClose: () => void;
  /** After a save: close the form only if it is still the one that saved. */
  readonly closeIfLatest: (seq: number) => void;
  /**
   * Close the open form if `match` says so, bypassing the guard. For a delete:
   * a form open on the record just deleted would save to a row that no longer
   * exists, and there is nothing left for its edits to be saved to.
   */
  readonly closeWhere: (match: (open: F) => boolean) => void;
}

export type { UnsavedChangesGuard };

export function useDrawerForm<F>(
  signatureOf: (form: F) => string,
  /** #1476 — `{ holdRoute: false }` where the host page already holds route
   * changes: React Router consults only one blocker at a time. */
  guardOptions?: UnsavedChangesGuardOptions,
): DrawerForm<F> {
  const [form, setForm] = useState<F | null>(null);
  const [seq, setSeq] = useState(0);
  const latestSeq = useRef(0);
  const [openedAs, setOpenedAs] = useState<string | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const openForm = useCallback(
    (next: F, baseline: F = next) => {
      setForm(next);
      setOpenedAs(signatureOf(baseline));
      latestSeq.current += 1;
      setSeq(latestSeq.current);
      // A page passes a module-level function, so this is stable in practice.
    },
    [signatureOf],
  );

  const dirty = useMemo(
    () => form !== null && signatureOf(form) !== openedAs,
    [form, openedAs, signatureOf],
  );
  const guard = useUnsavedChangesGuard(dirty, guardOptions);
  const isLatest = useCallback((s: number) => latestSeq.current === s, []);
  const { request } = guard;
  const openFrom = useCallback(
    (opener: HTMLElement, open: () => void) =>
      request(() => {
        openerRef.current = opener;
        open();
      }),
    [request],
  );
  const requestClose = useCallback(() => request(() => setForm(null)), [request]);
  const closeIfLatest = useCallback((s: number) => {
    if (latestSeq.current === s) setForm(null);
  }, []);

  const closeWhere = useCallback(
    (match: (open: F) => boolean) =>
      setForm((open) => (open !== null && match(open) ? null : open)),
    [],
  );

  return {
    form,
    setForm,
    openForm,
    seq,
    isLatest,
    guard,
    dirty,
    openerRef,
    openFrom,
    requestClose,
    closeIfLatest,
    closeWhere,
  };
}
