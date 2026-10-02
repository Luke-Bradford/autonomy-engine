import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
} from '@fluentui/react-components';
import { splitConfirmMessage } from './splitConfirmMessage';

/**
 * #1397 OR6 — the one confirmation dialog, replacing `window.confirm`.
 *
 * A native confirm cannot be styled, cannot say which button is the dangerous
 * one, and blocks the whole tab; it also cannot ask for the name to be typed.
 * This is a Fluent alert dialog instead: clicking the backdrop does not dismiss
 * it, and Escape answers Cancel.
 */
export interface ConfirmRequest {
  /**
   * The question, then its consequences. The first paragraph (up to the first
   * blank line) is the dialog's title, and every message builder in the app
   * already leads with the question ("Delete connection "x"?"). The rest is the
   * body, one paragraph per blank-line-separated block.
   */
  readonly message: string;
  /** The action button's label: what happens, e.g. "Delete" or "Archive". */
  readonly confirmLabel: string;
  /**
   * For an irreversible delete of something other resources depend on: the
   * action button stays disabled until this exact name is typed.
   */
  readonly typeToConfirm?: string;
  /**
   * Where focus goes when the dialog closes. Defaults to whatever had focus
   * when the question was asked — the row's button, as `window.confirm` did.
   * Pass this when that element is about to disappear (a menu item).
   */
  readonly restoreFocus?: () => HTMLElement | null;
}

interface Pending extends ConfirmRequest {
  readonly id: number;
  readonly opener: Element | null;
  readonly resolve: (confirmed: boolean) => void;
}

/**
 * `const [confirm, confirmDialog] = useConfirm()` — render `confirmDialog`
 * somewhere in the page, then `if (!(await confirm({...}))) return;`.
 *
 * Page-local rather than an app-wide provider: each page owns its dialog, so
 * rendering a page on its own (as its tests do) needs no wrapper.
 *
 * Only one question is open at a time. Asking again while one is open answers
 * the NEW question `false` and leaves the open one alone: swapping the dialog
 * under the operator could turn a click meant for "Delete B" into a delete of
 * A. The page unmounting answers an open question `false`, so no caller waits
 * forever.
 */
export function useConfirm(): [(request: ConfirmRequest) => Promise<boolean>, ReactNode] {
  // The question on screen, kept after it is answered so the dialog can CLOSE
  // (`open={false}`) rather than be torn out while open: unmounting an open
  // Fluent dialog leaves tabster's `aria-hidden` on the rest of the page, which
  // then stays invisible to screen readers and to `getByRole`.
  const [shown, setShown] = useState<{ request: Pending; open: boolean } | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const seq = useRef(0);
  // Where focus goes once the dialog has gone. Fluent restores focus only to a
  // `DialogTrigger`, and these dialogs have none.
  const restoreTo = useRef<HTMLElement | null>(null);
  // The control the dialog opens on (see `ConfirmDialog`).
  const initialFocus = useRef<HTMLElement | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    const current = pendingRef.current;
    if (current === null) return;
    pendingRef.current = null;
    const target = current.restoreFocus?.() ?? current.opener;
    restoreTo.current = target instanceof HTMLElement ? target : null;
    setShown((s) => (s?.request === current ? { request: current, open: false } : s));
    current.resolve(confirmed);
  }, []);

  /**
   * The dialog's surface has unmounted. Focus goes back to the opener — unless
   * another question is already open, or the caller has meanwhile put focus
   * somewhere on purpose (a delete that moved it to the next control).
   */
  const onGone = useCallback(() => {
    const target = restoreTo.current;
    restoreTo.current = null;
    if (pendingRef.current !== null || !target?.isConnected) return;
    const active = document.activeElement;
    if (active === null || active === document.body || !active.isConnected) target.focus();
  }, []);

  const confirm = useCallback(
    (request: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        if (pendingRef.current !== null) {
          resolve(false);
          return;
        }
        const next = {
          ...request,
          id: ++seq.current,
          opener: document.activeElement,
          resolve,
        };
        pendingRef.current = next;
        setShown({ request: next, open: true });
      }),
    [],
  );

  // Here, in the asking component, rather than in the dialog body: effects run
  // child-first, so this runs AFTER Fluent's own first-focus effect in `Dialog`
  // and has the last word on where focus lands.
  useEffect(() => {
    if (shown?.open) initialFocus.current?.focus();
  }, [shown]);

  useEffect(
    () => () => {
      pendingRef.current?.resolve(false);
      pendingRef.current = null;
    },
    [],
  );

  const dialog =
    shown === null ? null : (
      <Dialog
        open={shown.open}
        modalType="alert"
        onOpenChange={(_event, data) => {
          if (!data.open) settle(false);
        }}
      >
        <ConfirmDialog
          // A new question gets a fresh body, so a half-typed name never carries over.
          key={shown.request.id}
          request={shown.request}
          onAnswer={settle}
          onGone={onGone}
          initialFocus={initialFocus}
        />
      </Dialog>
    );
  return [confirm, dialog];
}

function ConfirmDialog({
  request,
  onAnswer,
  onGone,
  initialFocus,
}: {
  request: ConfirmRequest;
  onAnswer: (confirmed: boolean) => void;
  onGone: () => void;
  initialFocus: RefObject<HTMLElement | null>;
}) {
  const { title, paragraphs } = splitConfirmMessage(request.message);
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const bodyId = useId();
  const blocked = request.typeToConfirm !== undefined && typed !== request.typeToConfirm;
  // Focus opens on the safe choice: Cancel, or the name box when one is asked
  // for — never the action, so a stray Enter cannot confirm a delete. Placed
  // by `useConfirm` rather than left to Fluent's first-focusable search, which
  // agrees in a browser but depends on layout to find a target.
  const asksName = request.typeToConfirm !== undefined;
  useEffect(() => onGone, [onGone]);
  return (
    <DialogSurface className="confirm-dialog" aria-describedby={bodyId}>
      <DialogBody>
        <DialogTitle>{title}</DialogTitle>
        <DialogContent id={bodyId}>
          {paragraphs.map((p, i) => (
            <p key={i} className="confirm-dialog-paragraph">
              {p}
            </p>
          ))}
          {request.typeToConfirm !== undefined && (
            <div className="confirm-dialog-typed">
              <label htmlFor={inputId}>
                Type <strong>{request.typeToConfirm}</strong> to confirm
              </label>
              <input
                ref={initialFocus as RefObject<HTMLInputElement | null>}
                id={inputId}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !blocked) onAnswer(true);
                }}
              />
            </div>
          )}
        </DialogContent>
        <DialogActions>
          <button
            type="button"
            ref={asksName ? undefined : (initialFocus as RefObject<HTMLButtonElement | null>)}
            onClick={() => onAnswer(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="danger"
            disabled={blocked}
            onClick={() => onAnswer(true)}
          >
            {request.confirmLabel}
          </button>
        </DialogActions>
      </DialogBody>
    </DialogSurface>
  );
}
