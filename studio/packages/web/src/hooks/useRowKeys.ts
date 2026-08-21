import { useCallback, useState } from 'react';

/**
 * #1092 — stable React `key`s for a list-shaped sub-editor whose form model is
 * PURE.
 *
 * WHY IT EXISTS. `RunWindowsEditor` rendered its rows with `key={index}`, so
 * React matched rows by POSITION. Removing row 0 of three kept the DOM nodes of
 * positions 0 and 1 and unmounted position 2's, even though the row that
 * logically went away was the first — every surviving row's data was copied
 * into a node that had held a different window. No data is corrupted (every
 * field is controlled), but the element an operator had focused, selected text
 * in, or was mid-IME-composition in is destroyed, and their focus silently
 * comes to rest on a control that now means something else.
 *
 * WHY THE IDS LIVE HERE AND NOT IN THE MODEL. `runWindowsForm.ts` is
 * deliberately pure and deterministic, as are its siblings `windowForm.ts` and
 * `recurrenceForm.ts`; minting an id inside `blankRunWindowRow()` would make it
 * neither. The identity a React key needs is a property of one mounted editor,
 * not of the data — two editors showing the same windows want their own keys,
 * and a saved trigger must not carry them. So the impurity is quarantined in a
 * hook and the model stays a pure function of its input.
 *
 * REJECTED: `WeakMap<RunWindowRow, string>` keyed by row object identity. It
 * looks simpler and it does survive removal (`filter` preserves the identity of
 * the rows it keeps), but every keystroke goes through a `map` that mints a NEW
 * row object for the row being edited — so the row you are typing in would get
 * a fresh key and remount on each character, which is a far worse version of
 * the bug being fixed.
 *
 * THE CALLER TELLS IT WHAT HAPPENED. `removeAt`/`insertAt` exist because a
 * count alone cannot say WHICH row went: going from 3 rows to 2 is consistent
 * with any of three removals, and guessing would reintroduce exactly the
 * positional matching this hook removes. The `count` reconciliation below is
 * the fallback for changes that arrive from OUTSIDE the editor — `TriggersPage`
 * loads a different trigger into the same form state — where no such call is
 * made and there is nothing to be right about.
 */

/**
 * A process-wide counter rather than `crypto.randomUUID()`: uniqueness only has
 * to hold WITHIN one list, the values never leave the browser and are never
 * persisted, and a counter keeps test failures readable (`row-3`) instead of
 * printing a UUID that differs every run.
 */
let nextRowKey = 0;
const mintRowKey = () => `row-${(nextRowKey += 1)}`;

/** Grow by appending fresh ids, shrink by dropping from the END. */
function resize(keys: readonly string[], count: number): string[] {
  if (count < keys.length) return keys.slice(0, count);
  return [...keys, ...Array.from({ length: count - keys.length }, mintRowKey)];
}

export interface RowKeys {
  /** One stable key per row, in row order. Always exactly `count` long. */
  readonly keys: readonly string[];
  /** The row at `index` was removed: drop its key rather than truncating. */
  readonly removeAt: (index: number) => void;
  /** A row was inserted at `index` (`count` appends). */
  readonly insertAt: (index: number) => void;
}

export function useRowKeys(count: number): RowKeys {
  const [keys, setKeys] = useState<string[]>(() => resize([], count));

  /**
   * Reconciliation for a count that changed WITHOUT a `removeAt`/`insertAt` —
   * the editor's `value` being replaced wholesale from outside. Done during
   * render (React's documented "adjusting state when a prop changes" pattern)
   * rather than in an effect, because an effect would commit one frame in which
   * the key list and the row list disagree.
   *
   * `current` is used for THIS render rather than `keys`, so that first frame is
   * already correct instead of merely being discarded; the `setKeys` is what
   * makes it stick for the next one.
   *
   * On that path behaviour degrades to today's positional matching, and it is
   * the right degradation: an out-of-band replacement is a different list, not
   * an edit to this one, so there is no identity to preserve.
   */
  let current = keys;
  if (current.length !== count) {
    current = resize(current, count);
    setKeys(current);
  }

  const removeAt = useCallback((index: number) => {
    setKeys((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const insertAt = useCallback((index: number) => {
    setKeys((prev) => [...prev.slice(0, index), mintRowKey(), ...prev.slice(index)]);
  }, []);

  return { keys: current, removeAt, insertAt };
}
