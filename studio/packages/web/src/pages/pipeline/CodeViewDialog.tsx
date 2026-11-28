import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { GlobalRead } from '@autonomy-studio/shared';
import { isUnhandledEscape } from '../../lib/escape';
import { JsonEditor } from '../../lib/form/JsonEditor';
import { UnsavedChangesPrompt } from '../../lib/form/UnsavedChangesPrompt';
import { useUnsavedChangesGuard } from '../../lib/form/useUnsavedChangesGuard';
import type { WorkingDocSource } from './canvasStore';
import { checkCodeText } from './codeView';
import { portalRoot } from '../../lib/portalRoot';

/**
 * #1573 OR38 — the editor's Code view: the whole pipeline as JSON, edited and
 * applied to the canvas draft as one undoable edit. Save still mints a version.
 *
 * Modal, so the canvas cannot change under the text it was opened with. A native
 * `<dialog>` for `ExpressionEditor`'s reason (an unmounted open Fluent dialog
 * leaves `aria-hidden` on the whole app), which also means the discard question
 * is asked INSIDE it — a Fluent confirm would open beneath the top layer.
 */
export function CodeViewDialog({
  initial,
  globals,
  onApply,
  onClose,
  onDirtyChange,
  children,
}: {
  /** The doc as the view opens it (`codeViewText`). */
  initial: string;
  globals: readonly GlobalRead[];
  /** Replace the working doc; the dialog closes after. */
  onApply: (doc: WorkingDocSource) => void;
  onClose: () => void;
  /** Whether the text differs from `initial`: the editor's leave guard holds it. */
  onDirtyChange: (dirty: boolean) => void;
  /**
   * The editor's own leave prompt while it asks. Rendered in here because the
   * dialog is in the top layer: anywhere on the page, the prompt would sit inert
   * under the modal and the held navigation could never be answered.
   */
  children?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const problemsId = useId();
  const [text, setText] = useState(initial);
  // Checked a beat behind the typing: a keystroke never waits on a schema parse
  // and a validation pass over the whole doc.
  const checked = useDeferredValue(text);
  const check = useMemo(() => checkCodeText(checked, globals), [checked, globals]);
  const current = checked === text;
  const dirty = text !== initial;
  const guard = useUnsavedChangesGuard(dirty, { holdRoute: false });
  const requestClose = () => guard.request(onClose);
  const requestCloseRef = useRef(requestClose);
  useEffect(() => {
    requestCloseRef.current = requestClose;
  });
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    // StrictMode runs this twice on one element; a second `showModal` throws.
    if (!dialog.open) dialog.showModal();
    boxRef.current?.focus();
    boxRef.current?.setSelectionRange(0, 0);
    // The browser's own close request (Escape outside the box) asks first, as
    // Cancel does.
    const onCancel = (e: Event) => {
      e.preventDefault();
      requestCloseRef.current();
    };
    dialog.addEventListener('cancel', onCancel);
    return () => dialog.removeEventListener('cancel', onCancel);
  }, []);

  useEffect(() => {
    if (guard.confirming) keepRef.current?.focus();
  }, [guard.confirming]);

  /** Put the caret on `line` and select it, so the operator lands on the problem. */
  function goToLine(line: number) {
    const box = boxRef.current;
    if (box === null) return;
    const lines = text.split('\n');
    const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
    box.focus();
    box.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
  }

  const blocking = check.problems.some((p) => p.blocking);
  const applyReason = !dirty
    ? 'No changes to apply'
    : !current
      ? 'Checking…'
      : blocking
        ? 'Fix the problems marked Blocks apply first'
        : null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (isUnhandledEscape(e)) {
      e.preventDefault();
      requestClose();
    }
    // Modal: none of its keys are the canvas's (undo, delete, the dock's Escape),
    // though React bubbles them through the portal.
    e.stopPropagation();
  };

  return createPortal(
    // The handlers only stop the page behind a modal hearing its events.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <dialog
      ref={dialogRef}
      className="code-view"
      // `isModalDialogOpen` keys on it: the canvas's shortcuts stand down.
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <h2 id={titleId}>Pipeline code</h2>
      <JsonEditor
        ref={boxRef}
        label="Pipeline code"
        aria-labelledby={titleId}
        aria-describedby={problemsId}
        value={text}
        rows={24}
        spellCheck={false}
        onValueChange={setText}
      />
      <section id={problemsId} className="code-view-problems" aria-label="Problems">
        {check.problems.length === 0 ? (
          <p className="code-view-ok">No problems</p>
        ) : (
          <ul>
            {check.problems.map((p, i) => (
              <li key={i} data-blocking={p.blocking}>
                <span className="code-view-severity">
                  {p.blocking ? 'Blocks apply' : 'Blocks save'}
                </span>
                {p.line !== null ? (
                  <button
                    type="button"
                    className="subtle"
                    // A line read off an older text points nowhere in this one.
                    disabled={!current}
                    onClick={() => goToLine(p.line!)}
                  >
                    Line {p.line}
                  </button>
                ) : (
                  <span aria-hidden="true" />
                )}
                <span className="code-view-message">{p.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {guard.confirming && <UnsavedChangesPrompt guard={guard} keepRef={keepRef} />}
      {children}
      <div className="code-view-actions">
        <button type="button" onClick={requestClose}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={applyReason !== null}
          title={applyReason ?? 'Load into the canvas as one undoable edit'}
          onClick={() => {
            if (check.doc === null) return;
            onApply(check.doc);
            onClose();
          }}
        >
          Apply
        </button>
      </div>
    </dialog>,
    portalRoot(),
  );
}
