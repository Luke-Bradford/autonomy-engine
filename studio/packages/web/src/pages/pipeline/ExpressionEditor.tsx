import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { isUnhandledEscape } from '../../lib/escape';
import { FLUENT_ROOT_CLASS } from '../../theme/fluentTheme';
import type { FieldPicker, PickerTarget } from './ConfigFieldControl';
import { ExpressionPicker } from './ExpressionPicker';
import { fieldPickerProps, useCaretInsert } from './useCaretInsert';

/**
 * #1694 OR42 F10 — ⤢: a config field opened in a full-size editor. A field
 * rests at one line in the dock and grows to eight while edited; a long
 * expression or a prompt wants more than that, and the room to read it whole.
 *
 * The editor edits a DRAFT of the field's text, with the same reference and
 * function flyout the field has, inserting at the editor's own caret. OK writes
 * the draft through the field's `onChange`, exactly as typing would; Cancel and
 * Escape discard it, as ADF's dynamic-content pane does.
 */
export function ExpressionEditor({
  fieldName,
  value,
  onChange,
  picker,
  target,
  singleLine,
}: {
  fieldName: string;
  value: string;
  onChange: (next: string) => void;
  picker: FieldPicker;
  target: PickerTarget;
  /** The field holds one line: a line break never enters it, and Enter is OK. */
  singleLine: boolean;
}) {
  // The draft, or `null` while closed.
  const [draft, setDraft] = useState<string | null>(null);
  // The field's text when the editor opened. OK writes only a draft that
  // differs from it: an untouched draft must not put back that text over a
  // change the field took while the editor was up.
  const opened = useRef('');
  const openerRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const done = (next: string | null) => {
    setDraft(null);
    if (next !== null && next !== opened.current) onChange(next);
    returnFocus.current = true;
  };
  // Back to ⤢ once the editor has GONE: while the modal is up, everything
  // outside it is inert and refuses focus.
  useEffect(() => {
    if (draft !== null || !returnFocus.current) return;
    returnFocus.current = false;
    openerRef.current?.focus();
  }, [draft]);
  return (
    <>
      <button
        type="button"
        ref={openerRef}
        className="expression-picker-toggle"
        aria-label={`Open ${fieldName} in the editor`}
        title="Open editor"
        aria-haspopup="dialog"
        onClick={() => {
          opened.current = value;
          setDraft(value);
        }}
      >
        ⤢
      </button>
      {draft !== null &&
        createPortal(
          <EditorDialog
            fieldName={fieldName}
            draft={draft}
            setDraft={setDraft}
            picker={picker}
            target={target}
            singleLine={singleLine}
            onDone={done}
          />,
          portalRoot(),
        )}
    </>
  );
}

/**
 * Outside the field, so the field's own rules (`.config-field > …`) and the
 * dock's key handling do not reach the editor; inside the app's Fluent root,
 * where the theme's tokens resolve. Native `<dialog>` in the top layer, rather
 * than Fluent's: it is mounted by a field that can unmount while it is open,
 * and an open Fluent dialog unmounted leaves `aria-hidden` on the whole app
 * (`useConfirm`), where removing a `<dialog>` takes it out of the top layer.
 */
function portalRoot(): Element {
  return document.querySelector(`.${FLUENT_ROOT_CLASS}:not([data-portal-node])`) ?? document.body;
}

function EditorDialog({
  fieldName,
  draft,
  setDraft,
  picker,
  target,
  singleLine,
  onDone,
}: {
  fieldName: string;
  draft: string;
  setDraft: (next: string) => void;
  picker: FieldPicker;
  target: PickerTarget;
  singleLine: boolean;
  /** Close; the draft to write, or `null` to discard it. */
  onDone: (next: string | null) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { ref: boxRef, onSelect, insert, functionOptions } = useCaretInsert<HTMLTextAreaElement>();
  const titleId = useId();
  const edit = (next: string) => setDraft(singleLine ? next.replace(/[\r\n]/g, '') : next);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    // StrictMode runs this twice on one element; a second `showModal` throws.
    if (!dialog.open) dialog.showModal();
    const box = boxRef.current;
    box?.focus();
    box?.setSelectionRange(box.value.length, box.value.length);
    // The browser's own close request is a discard. `onKeyDown` takes every
    // Escape that reaches it first, so these are the backstop: an Escape with
    // focus outside the dialog's tree (on the body after a backdrop click), and
    // Chromium's forced close, which skips `cancel` on a second close request
    // with no user activation between. React state, not the element, decides
    // whether the editor is up.
    const onCancel = (e: Event) => {
      e.preventDefault();
      onDoneRef.current(null);
    };
    const onClose = () => onDoneRef.current(null);
    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('close', onClose);
    return () => {
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('close', onClose);
    };
    // Mount-only: the box's ref is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    // An Escape the flyout already took closes only its list.
    if (isUnhandledEscape(e)) {
      e.preventDefault();
      onDone(null);
    } else if (
      e.key === 'Enter' &&
      !e.nativeEvent.isComposing &&
      e.target === boxRef.current &&
      (singleLine || e.metaKey || e.ctrlKey)
    ) {
      e.preventDefault();
      onDone(draft);
    }
    // The editor is modal: none of its keys are the page's (the dock's Escape,
    // the canvas's shortcuts), though React bubbles them through the portal.
    e.stopPropagation();
  };

  return (
    // The handlers only stop the page behind a modal hearing its events: React
    // bubbles them through the portal to the field's own ancestors.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <dialog
      ref={dialogRef}
      className="expression-editor"
      // `isModalDialogOpen` keys on it: the canvas's shortcuts stand down.
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <h2 id={titleId}>{fieldName}</h2>
      <textarea
        ref={boxRef}
        className="expression-editor-text"
        aria-labelledby={titleId}
        value={draft}
        rows={singleLine ? 4 : 16}
        spellCheck={false}
        onSelect={onSelect}
        onChange={(e) => edit(e.target.value)}
      />
      <ExpressionPicker
        fieldName={fieldName}
        {...fieldPickerProps({ insert, functionOptions }, picker, target, draft, edit)}
      />
      <div className="expression-editor-actions">
        {/* The confirm dialog's order: Cancel, then the primary act, at the right. */}
        <button type="button" onClick={() => onDone(null)}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={() => onDone(draft)}>
          OK
        </button>
      </div>
    </dialog>
  );
}
