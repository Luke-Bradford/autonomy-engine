import { useState } from 'react';

/**
 * #1694 OR42 item 5 — ONE reserved error line for a group of fields, under the
 * group, in place of a reserved line under every field. A slot per field kept
 * #1393's rule (an error arriving moves nothing) at the price of a line of
 * empty space under each row, so a run of number fields sat ~65px apart where
 * every other row is 36px. Here the rows keep the dock's rhythm and the one
 * line below them is what holds still.
 *
 * Each field writes into the line through a portal (`DraftNumberField`'s
 * `errorLine`), keeping its own error state. Two errors at once take a line
 * each, in the order they were raised: that moves only what is below the
 * group, never a field, and needs two fields wrong together.
 */
export function useFieldErrorLine() {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  return { node, line: <div ref={setNode} className="field-error-slot" /> };
}
