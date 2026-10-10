import { useCallback, useId, useRef, useState } from 'react';
import type { Ref, TextareaHTMLAttributes } from 'react';
import { MAX_LAYOUT_DEPTH, formatJsonText, positionOf, scanJson } from '../json/jsonText';

type TextareaProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'defaultValue' | 'onChange' | 'children' | 'className' | 'wrap' | 'dir'
>;

/**
 * #1396 — the one control for typing JSON: Config (JSON), a JSON-kind setting,
 * dataset Columns, trigger Params, call parameters, a JSON run parameter and a
 * callback body all use it.
 *
 * It stays a NATIVE `<textarea>`. Its label pairs by `htmlFor`, its value is the
 * text Playwright and the forms read, `aria-invalid` and a `FieldError` attach as
 * they do to any field, and the keyboard is the platform's: Tab leaves the box
 * (WCAG 2.1.2), undo is the browser's. What makes it a code editor is the
 * monospace, unwrapped, left-to-right text with spelling and autocorrect off, and
 * **Format JSON**:
 * - JSON is laid out with two-space indents, moving only whitespace
 *   (`formatJsonText`), so no value changes and a freshly seeded form stays
 *   unedited. The text goes in through `insertText`, which keeps it on the undo
 *   stack, and the field's own `onChange` runs as for typing.
 * - Text that is not JSON is left alone: the mistake is selected and its line,
 *   column and reason are shown beside the button, in a one-line slot that is
 *   always there so the form below does not move (#1393).
 *
 * The button's name is the same everywhere, "Format JSON", so that no other
 * field's `getByLabel` can match it; `aria-description` says which field it is for.
 */
export function JsonEditor({
  value,
  onValueChange,
  label,
  ref,
  ...textarea
}: TextareaProps & {
  value: string;
  onValueChange: (next: string) => void;
  /** The field's label, for the Format button's description. */
  label: string;
  ref?: Ref<HTMLTextAreaElement>;
}) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const problemId = useId();
  // A problem is about the text it was found in. Once the value changes in any
  // way (typing, a reset, the canvas panel moving to another node), it is gone.
  const [problem, setProblem] = useState<{ text: string; message: string } | null>(null);
  const shown = problem !== null && problem.text === value ? problem.message : null;

  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      own.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );

  function format() {
    const el = own.current;
    setProblem(null);
    if (el === null || el.readOnly || el.disabled || value.trim() === '') return;
    let source = value;
    let scan = scanJson(source);
    // The call and run-parameter forms trim before parsing, so a BOM or a
    // no-break space around pasted JSON is accepted there. Lay out what they read.
    if (!scan.ok && scanJson(value.trim()).ok) {
      source = value.trim();
      scan = { ok: true };
    }
    if (!scan.ok) {
      const { line, column } = positionOf(value, scan.offset);
      setProblem({
        text: value,
        message: `Not JSON at line ${line}, column ${column}: ${scan.reason}`,
      });
      el.focus();
      // One character, and a whole one: an emoji is two UTF-16 units.
      const width = (value.codePointAt(scan.offset) ?? 0) > 0xffff ? 2 : 1;
      el.setSelectionRange(scan.offset, Math.min(value.length, scan.offset + width));
      return;
    }
    const formatted = formatJsonText(source);
    if (formatted === null) {
      setProblem({
        text: value,
        message: `Nested more than ${MAX_LAYOUT_DEPTH} deep: too deep to lay out`,
      });
      return;
    }
    if (formatted === value) return;
    const top = el.scrollTop;
    el.focus();
    el.select();
    // `execCommand` is deprecated but is the only way to replace a textarea's
    // text that the browser's undo stack records. Where it does nothing (jsdom),
    // the value is set as typing would set it.
    const inserted =
      typeof document.execCommand === 'function' &&
      document.execCommand('insertText', false, formatted);
    if (!inserted || el.value !== formatted) onValueChange(formatted);
    // Inserting leaves the caret, and the scroll, at the end; keep the operator's place.
    el.setSelectionRange(0, 0);
    el.scrollTop = top;
  }

  const describedBy =
    [textarea['aria-describedby'], shown === null ? undefined : problemId]
      .filter((id) => id !== undefined && id !== '')
      .join(' ') || undefined;

  return (
    <div className="json-editor">
      <textarea
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        {...textarea}
        aria-describedby={describedBy}
        ref={setRef}
        className="json-editor-input"
        dir="ltr"
        wrap="off"
        value={value}
        onChange={(e) => {
          // Typing ends the problem too, even when the edit comes back to the
          // very text it was found in.
          setProblem(null);
          onValueChange(e.target.value);
        }}
      />
      <div className="json-editor-tools">
        {/* aria-description is an ARIA 1.3 global attribute; aria-query 5.3
            does not list it on button. */}
        {/* eslint-disable-next-line jsx-a11y/role-supports-aria-props */}
        <button
          type="button"
          className="json-editor-format"
          aria-description={`Lays out ${label} with two-space indents`}
          disabled={textarea.disabled === true || textarea.readOnly === true}
          onClick={format}
        >
          Format JSON
        </button>
        {/* Always mounted, so a message arriving is announced (a live region
            inserted already holding its text often is not). Not a `status`
            role: an empty one would be found by every page-wide role query. One
            line, so a message cannot grow the row and move the form (#1393); the
            whole of it is in the title and in the box's description. */}
        <span
          id={problemId}
          className="json-editor-problem"
          aria-live="polite"
          title={shown ?? undefined}
        >
          {shown}
        </span>
      </div>
    </div>
  );
}
