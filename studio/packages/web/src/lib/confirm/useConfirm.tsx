import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
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
import { TYPED_NAME_PREFIX, TYPED_NAME_SUFFIX, typedNameKey } from './typedName';

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
   * How the action button is drawn. `danger` (the default) for an act that
   * destroys or stops something; `primary` for one that destroys nothing (a
   * restore that mints a new version, a publish that moves a pointer), which a
   * red button would misdescribe.
   */
  readonly tone?: 'danger' | 'primary';
  /**
   * The dismiss button's label. "Cancel" unless that collides with the action:
   * "Cancel this run?" over [Cancel] [Cancel run] does not say which keeps it.
   */
  readonly cancelLabel?: string;
  /**
   * For an irreversible delete of something other resources depend on: the
   * action button stays disabled until this name is typed. Compared after
   * `typedNameKey`, so whitespace the dialog cannot show is not asked for.
   */
  readonly typeToConfirm?: string;
  /**
   * Where focus goes when the dialog closes. Defaults to whatever had focus
   * when the question was asked — the row's button, as `window.confirm` did.
   * Pass this when that element is about to disappear (a menu item).
   *
   * Called once the dialog has gone, not when it is answered, so it sees the
   * page after anything the answer removed. It runs in an effect cleanup, so it
   * must not throw: return `null` for "nowhere".
   */
  readonly restoreFocus?: () => HTMLElement | null;
}

interface Pending extends ConfirmRequest {
  readonly id: number;
  readonly owner: object;
  readonly opener: Element | null;
  readonly resolve: (confirmed: boolean) => void;
}

type Ask = (request: ConfirmRequest) => Promise<boolean>;

/** What an asker holds. Stable for the controller's lifetime. */
interface ConfirmApi {
  /** Ask; `owner` identifies the asker, so it can withdraw only its own question. */
  readonly confirm: (request: ConfirmRequest, owner: object) => Promise<boolean>;
  /** Answer `false` to the open question, if `owner` asked it. */
  readonly withdraw: (owner: object) => void;
}

const ConfirmHostContext = createContext<ConfirmApi | null>(null);

/**
 * The app's one confirmation dialog, mounted ABOVE the routes (`main.tsx`).
 *
 * A dialog rendered by the page it guards dies with that page, and an in-app
 * modal does not block Back the way `window.confirm` did. Unmounting an OPEN
 * Fluent dialog leaves tabster's `aria-hidden` on `#root` — the whole app then
 * reads as empty to a screen reader and to `getByRole`. Hosted here, the dialog
 * outlives the page: a page that goes away with its question open withdraws it,
 * and the dialog CLOSES (`open={false}`), which lifts the `aria-hidden`.
 */
export function ConfirmHost({ children }: { children: ReactNode }) {
  const { api, dialog } = useConfirmController();
  return (
    <ConfirmHostContext.Provider value={api}>
      {children}
      {dialog}
    </ConfirmHostContext.Provider>
  );
}

/**
 * `const [confirm, confirmDialog] = useConfirm()` — render `confirmDialog`
 * somewhere in the page, then `if (!(await confirm({...}))) return;`.
 *
 * Under a `ConfirmHost` (the app) the question is shown by the host and
 * `confirmDialog` is `null`; without one (a page rendered alone, as its unit
 * tests do) the page shows it itself.
 *
 * Only one question is open at a time. Asking again while one is open answers
 * the NEW question `false` and leaves the open one alone: swapping the dialog
 * under the operator could turn a click meant for "Delete B" into a delete of
 * A. The page unmounting answers its open question `false`, and so does asking
 * after it has gone (a caller that awaited a read first), so no caller waits
 * forever.
 */
export function useConfirm(): [Ask, ReactNode] {
  const host = useContext(ConfirmHostContext);
  const local = useConfirmController();
  const target = host ?? local.api;
  const [owner] = useState(() => ({}));
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      target.withdraw(owner);
    };
  }, [target, owner]);

  const confirm = useCallback<Ask>(
    (request) => (mounted.current ? target.confirm(request, owner) : Promise.resolve(false)),
    [target, owner],
  );
  return [confirm, host === null ? local.dialog : null];
}

function useConfirmController(): { api: ConfirmApi; dialog: ReactNode } {
  // The question on screen, kept after it is answered so the dialog can CLOSE
  // (`open={false}`) rather than be torn out while open (see `ConfirmHost`).
  const [shown, setShown] = useState<{ request: Pending; open: boolean } | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const seq = useRef(0);
  // Where focus goes once the dialog has gone. Fluent restores focus only to a
  // `DialogTrigger`, and these dialogs have none. Held as a lookup and asked
  // only when the dialog HAS gone (#1470): an accepted delete can remove its
  // row during the close animation, and the answer then has to come from the
  // page as it is by then, not as it was when the button was pressed.
  const restoreTo = useRef<(() => Element | null) | null>(null);
  // The control the dialog opens on (see `ConfirmDialog`).
  const initialFocus = useRef<HTMLElement | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    const current = pendingRef.current;
    if (current === null) return;
    pendingRef.current = null;
    restoreTo.current = () => current.restoreFocus?.() ?? current.opener;
    setShown((s) => (s?.request === current ? { request: current, open: false } : s));
    current.resolve(confirmed);
  }, []);

  /**
   * The dialog's surface has unmounted. Focus goes back to the opener — unless
   * another question is already open, or the caller has meanwhile put focus
   * somewhere on purpose (a delete that moved it to the next control).
   */
  const onGone = useCallback(() => {
    const lookup = restoreTo.current;
    restoreTo.current = null;
    if (pendingRef.current !== null || lookup === null) return;
    const target = lookup();
    if (!(target instanceof HTMLElement) || !target.isConnected) return;
    const active = document.activeElement;
    if (active === null || active === document.body || !active.isConnected) target.focus();
  }, []);

  const confirm = useCallback(
    (request: ConfirmRequest, owner: object) =>
      new Promise<boolean>((resolve) => {
        if (pendingRef.current !== null) {
          resolve(false);
          return;
        }
        const next = {
          ...request,
          id: ++seq.current,
          owner,
          opener: document.activeElement,
          resolve,
        };
        pendingRef.current = next;
        setShown({ request: next, open: true });
      }),
    [],
  );

  const withdraw = useCallback(
    (owner: object) => {
      if (pendingRef.current?.owner === owner) settle(false);
    },
    [settle],
  );

  // Here, in the component that renders the `Dialog`, rather than in the dialog
  // body: effects run child-first, so this runs AFTER Fluent's own first-focus
  // effect in `Dialog` and has the last word on where focus lands.
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
  // Stable, because askers key effects on it: an api that changed per render
  // would re-run an asker's unmount cleanup and withdraw its own question.
  const api = useMemo(() => ({ confirm, withdraw }), [confirm, withdraw]);
  return { api, dialog };
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
  const blocked =
    request.typeToConfirm !== undefined &&
    typedNameKey(typed) !== typedNameKey(request.typeToConfirm);
  // Focus opens on the safe choice: Cancel, or the name box when one is asked
  // for — never the action, so a stray Enter cannot confirm a delete. Placed
  // by `useConfirm` rather than left to Fluent's first-focusable search, which
  // agrees in a browser but depends on layout to find a target.
  const asksName = request.typeToConfirm !== undefined;
  // Cleanup only: runs when Fluent unmounts the surface after it has closed.
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
                {TYPED_NAME_PREFIX}
                <strong className="confirm-dialog-name">
                  {typedNameKey(request.typeToConfirm)}
                </strong>
                {TYPED_NAME_SUFFIX}
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
                  // Not mid-composition: an IME's Enter commits text, not the dialog.
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing && !blocked) onAnswer(true);
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
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            className={request.tone ?? 'danger'}
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
