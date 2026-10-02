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
   * For `confirm({ restoreFocus })` on a row's removal. Records the row, so the
   * row leaving the list later moves a stranded focus to its neighbour; and
   * returns the lookup the dialog uses on close: the row's `⋯` while it is
   * still there (a declined or failed delete), else the neighbour's, else the
   * fallback.
   *
   * A declined or failed delete leaves its row listed, and a listed row is
   * never acted on, so nothing has to be unwound.
   */
  readonly restoreFocus: (id: string, origin: RowMenuOrigin) => () => HTMLElement | null;
}

/** The `⋯` of the row after the origin's row, else the one before it. */
function neighbourRow(origin: RowMenuOrigin): Element | null {
  const row = origin.element.closest('tr');
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
  const pending = useRef(new Map<string, Element | null>());

  useEffect(() => {
    if (rows === null || pending.current.size === 0) return;
    for (const [id, neighbour] of [...pending.current]) {
      if (rows.some((row) => row.id === id)) continue;
      pending.current.delete(id);
      if (stranded()) (menuButtonIn(neighbour) ?? fallback.current)?.focus();
    }
  }, [rows, fallback]);

  const restoreFocus = useCallback(
    (id: string, origin: RowMenuOrigin) => {
      const neighbour = neighbourRow(origin);
      pending.current.set(id, neighbour);
      return () => origin.find() ?? menuButtonIn(neighbour) ?? fallback.current;
    },
    [fallback],
  );

  return { restoreFocus };
}
