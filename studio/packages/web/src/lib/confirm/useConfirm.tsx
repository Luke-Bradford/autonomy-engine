import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
} from '@fluentui/react-components';

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

/** Split a confirm message into its title and body paragraphs. */
export function splitConfirmMessage(message: string): {
  title: string;
  paragraphs: string[];
} {
  const [title = '', ...rest] = message.split(/\n\s*\n/);
  return { title: title.trim(), paragraphs: rest.map((p) => p.trim()).filter((p) => p !== '') };
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
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const seq = useRef(0);

  // The element to refocus once the dialog has unmounted. Fluent restores
  // focus only to a `DialogTrigger`, and these dialogs have none.
  const restoreTo = useRef<HTMLElement | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    const current = pendingRef.current;
    if (current === null) return;
    pendingRef.current = null;
    const target = current.restoreFocus?.() ?? current.opener;
    restoreTo.current = target instanceof HTMLElement ? target : null;
    setPending(null);
    current.resolve(confirmed);
  }, []);

  useEffect(() => {
    if (pending !== null) return;
    const target = restoreTo.current;
    restoreTo.current = null;
    if (target?.isConnected) target.focus();
  }, [pending]);

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
        setPending(next);
      }),
    [],
  );

  useEffect(
    () => () => {
      pendingRef.current?.resolve(false);
      pendingRef.current = null;
    },
    [],
  );

  const dialog =
    pending === null ? null : (
      <ConfirmDialog
        // A new question gets a fresh dialog, so a half-typed name never carries over.
        key={pending.id}
        request={pending}
        onAnswer={settle}
      />
    );
  return [confirm, dialog];
}

function ConfirmDialog({
  request,
  onAnswer,
}: {
  request: ConfirmRequest;
  onAnswer: (confirmed: boolean) => void;
}) {
  const { title, paragraphs } = splitConfirmMessage(request.message);
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const bodyId = useId();
  const blocked = request.typeToConfirm !== undefined && typed !== request.typeToConfirm;
  // Focus lands on the safe choice: Cancel, or the name box when one is asked
  // for — never the action, so a stray Enter cannot confirm a delete. Set here
  // rather than left to Fluent's first-focusable search, which agrees with it
  // in a browser but depends on layout to find a target.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    (inputRef.current ?? cancelRef.current)?.focus();
  }, []);
  return (
    <Dialog
      open
      modalType="alert"
      onOpenChange={(_event, data) => {
        if (!data.open) onAnswer(false);
      }}
    >
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
                  ref={inputRef}
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
            <button type="button" ref={cancelRef} onClick={() => onAnswer(false)}>
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
    </Dialog>
  );
}
