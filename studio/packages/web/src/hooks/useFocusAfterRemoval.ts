import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { RowMenuOrigin } from '../lib/RowMoreMenu';

/**
 * #1470 — where focus goes when a list row's own Delete (or Archive) removes
 * the row it was asked from.
 *
 * The confirmation hands focus back to the row's `⋯`, and the refresh then
 * unmounts that row, so focus fell to `<body>` and a keyboard user started
 * again from the top of the page. It now lands on the NEXT row's `⋯` (the
 * previous row's, for the last row), and on the page's create control when the
 * list has emptied.
 *
 * Two orders, both covered:
 *   - the dialog finishes closing first and focuses the row's `⋯`; the refresh
 *     then removes the row. The effect below sees the row gone with focus
 *     stranded on `<body>` and moves it.
 *   - the delete and refresh finish while the dialog is still closing, so the
 *     row is already gone when the dialog asks `restoreFocus` (it asks once it
 *     has gone, `useConfirm`). The lookup then answers with the neighbour.
 *
 * The same pattern as `FactoryResources`' `deletingRow` (an effect on the list,
 * since the handler runs before React removes the row) and
 * `RunWindowsEditor`'s pending focus (the neighbour, else a fallback, rather
 * than stranding). FactoryResources keeps its own because a draft can own
 * focus there.
 *
 * Only a STRANDED focus is moved: if the operator has gone somewhere else by
 * the time the row leaves, they stay there.
 */
export interface FocusAfterRemoval {
  /**
   * For `confirm({ restoreFocus })` on a row's removal: the row's `⋯` while it
   * is still there (a declined or failed delete), else the neighbour's, else
   * the fallback. Records nothing, so a declined question leaves no trace.
   */
  readonly restoreFocus: (origin: RowMenuOrigin) => () => HTMLElement | null;
  /**
   * Once the removal is CONFIRMED: when row `id` leaves the list with focus
   * stranded, focus moves to its neighbour or the fallback. Returns `forget`,
   * for a removal that failed, so a row that stayed is not acted on later when
   * it leaves for some other reason.
   */
  readonly removing: (id: string, origin: RowMenuOrigin) => () => void;
}

/** The row after the origin's row, else the one before it. */
function neighbourRow(origin: RowMenuOrigin): Element | null {
  // Looked up again: a list refreshed while a dependants read ran may have
  // replaced the node `element` holds.
  const row = (origin.find() ?? origin.element).closest('tr');
  return row?.nextElementSibling ?? row?.previousElementSibling ?? null;
}

function menuButtonIn(row: Element | null): HTMLElement | null {
  if (row === null || !row.isConnected) return null;
  return row.querySelector<HTMLElement>('.row-menu__trigger');
}

function stranded(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}

/**
 * `rows` is the page's list; `null` means not known yet, never "emptied".
 * `fallback` is the page's create control.
 */
export function useFocusAfterRemoval(
  rows: readonly { readonly id: string }[] | null,
  fallback: RefObject<HTMLElement | null>,
): FocusAfterRemoval {
  // Keyed by row: two rows' deletes can be in flight at once.
  const pending = useRef(new Map<string, { readonly neighbour: Element | null }>());

  useEffect(() => {
    if (rows === null || pending.current.size === 0) return;
    for (const [id, { neighbour }] of [...pending.current]) {
      if (rows.some((row) => row.id === id)) continue;
      pending.current.delete(id);
      if (stranded()) (menuButtonIn(neighbour) ?? fallback.current)?.focus();
    }
  }, [rows, fallback]);

  const restoreFocus = useCallback(
    (origin: RowMenuOrigin) => {
      const neighbour = neighbourRow(origin);
      return () => origin.find() ?? menuButtonIn(neighbour) ?? fallback.current;
    },
    [fallback],
  );

  const removing = useCallback((id: string, origin: RowMenuOrigin) => {
    const entry = { neighbour: neighbourRow(origin) };
    pending.current.set(id, entry);
    // Compare-and-clear, as `FactoryResources` does: a later removal of the
    // same row may have replaced this entry.
    return () => {
      if (pending.current.get(id) === entry) pending.current.delete(id);
    };
  }, []);

  return { restoreFocus, removing };
}
