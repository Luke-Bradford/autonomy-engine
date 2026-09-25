import { useEffect, useRef } from 'react';
import { applyInsert, type InsertMode } from './expressionInsert';

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

  return {
    ref,
    onSelect: () => {
      touched.current = true;
    },
    /** `text` spliced with `insertText` at the author's selection (or replaced, per `mode`). */
    insert: (text: string, insertText: string, mode: InsertMode): string => {
      // The selection survives the toggle click (focus moves, the caret does
      // not), so a mid-string insert lands where the author left it — but only
      // if they ever placed one. See `touched`.
      const el = ref.current;
      const at = touched.current && el !== null ? (el.selectionStart ?? text.length) : text.length;
      const to = touched.current && el !== null ? (el.selectionEnd ?? text.length) : text.length;
      const next = applyInsert(text, at, to, insertText, mode);
      caret.current = next.caret;
      return next.value;
    },
  };
}
