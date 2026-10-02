import { useEffect, useRef } from 'react';
import type { ExampleChoices, FunctionOption, FunctionsOptions } from './ExpressionPicker';
import {
  applyInsert,
  applyWrap,
  outsideExpressions,
  wrapTarget,
  type InsertMode,
  type WrapSpan,
} from './expressionInsert';

/**
 * The caret half of the U8a flyout: where a chosen reference lands in a
 * controlled text control, and where the caret goes afterwards.
 *
 * ONE copy, shared by the derived config form (`ConfigFieldControl`) and the
 * call-node editor (`CallPanel`, #1012) — the second consumer is why this left
 * `ConfigFieldControl`, rather than being re-typed beside its new home.
 *
 * `insert` returns the NEXT value for the owner to store; it does not write the
 * DOM. The control is CONTROLLED, so the new value has to round-trip through
 * the owner's state before the selection can be moved — setting it inline would
 * be overwritten by the re-render. The caret is held in a ref rather than state
 * so restoring it does not itself cause one.
 */
export function useCaretInsert<E extends HTMLInputElement | HTMLTextAreaElement>() {
  const ref = useRef<E>(null);
  const caret = useRef<number | null>(null);
  // Whether the author has ever put the caret in THIS control. One nobody has
  // focused reports `selectionStart === 0`, which is indistinguishable from a
  // deliberate caret at the start — so without this, the commonest flow of all
  // (select a node, click Insert reference without clicking into the field
  // first) PREPENDS the reference to the value already there. Untouched means
  // "append", which is what an author who never placed a caret means.
  const touched = useRef(false);
  useEffect(() => {
    const at = caret.current;
    if (at === null || ref.current === null) return;
    caret.current = null;
    ref.current.focus();
    ref.current.setSelectionRange(at, at);
  });

  // The selection survives the toggle click (focus moves, the caret does not),
  // so a mid-string insert lands where the author left it — but only if they
  // ever placed one. See `touched`.
  const selection = (text: string): [number, number] => {
    const el = ref.current;
    if (!touched.current || el === null) return [text.length, text.length];
    return [el.selectionStart ?? text.length, el.selectionEnd ?? text.length];
  };

  return {
    ref,
    onSelect: () => {
      touched.current = true;
    },
    /** `text` spliced with `insertText` at the author's selection (or replaced, per `mode`). */
    insert: (text: string, insertText: string, mode: InsertMode): string => {
      const [at, to] = selection(text);
      const next = applyInsert(text, at, to, insertText, mode);
      caret.current = next.caret;
      return next.value;
    },
    /**
     * The functions half of the flyout for `text`, settled NOW (when the list
     * opens) from where the author's selection is:
     *  - in no `${}` — the functions' worked examples (#1413), one of which is
     *    inserted at that selection as a whole `${call}`, in the field's mode;
     *  - in one — the functions the span there can be wrapped in (#864), and
     *    an `apply` that wraps it and leaves the caret after the closing paren;
     *  - `null` when neither fits: an end in quoted text, a selection across
     *    expressions, or plain text where a spliced `${…}` would not stay one
     *    (straight after a `$`, or after an unterminated `${`).
     * The selection is fixed at opening for both acts, so a caret moved while
     * the list is open cannot put an example inside an expression.
     */
    functionOptions: (
      text: string,
      functionsFor: (span: WrapSpan) => FunctionOption[],
      examplesFor: () => ExampleChoices,
      onChange: (next: string) => void,
    ): FunctionsOptions => {
      // The caret goes after the change once the new value has round-tripped.
      const commit = (next: { value: string; caret: number }) => {
        caret.current = next.caret;
        onChange(next.value);
      };
      const [at, to] = selection(text);
      if (outsideExpressions(text, at, to)) {
        const { mode, functions } = examplesFor();
        return {
          kind: 'examples',
          mode,
          functions,
          apply: (call) => commit(applyInsert(text, at, to, `\${${call}}`, mode)),
        };
      }
      const span = wrapTarget(text, at, to);
      if (span === null) return null;
      return {
        kind: 'wrap',
        functions: functionsFor(span),
        apply: (name) => commit(applyWrap(text, span, name)),
      };
    },
  };
}
