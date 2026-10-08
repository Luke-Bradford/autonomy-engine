import type { MouseEvent as ReactMouseEvent } from 'react';
import { useHref, useNavigate } from 'react-router';

/**
 * A grid row that opens `path` when clicked anywhere that is not its own
 * control. Shared by the runs grid (#1484) and the pipelines grid (#1569): one
 * rule for "what counts as a click on the row", not two that drift.
 *
 * The row is a MOUSE affordance only. Each grid keeps a real link in the row
 * (the run's id, the pipeline's name) as the keyboard and assistive-tech path.
 * Ctrl/Cmd/Shift-click and a middle click open a new tab, as the link would.
 */
export function useRowOpen(path: string): {
  onClick: (e: ReactMouseEvent<HTMLTableRowElement>) => void;
  onAuxClick: (e: ReactMouseEvent<HTMLTableRowElement>) => void;
} {
  const navigate = useNavigate();
  const href = useHref(path);
  const open = (e: ReactMouseEvent<HTMLTableRowElement>, newTab: boolean): void => {
    if (e.target instanceof Element && e.target.closest('a, button, input, select, textarea')) {
      return;
    }
    // #1566 — React bubbles a click through a PORTAL to this row too: a cell's
    // ⋯ menu renders in the body, so a click on one of its items is not in the
    // row's DOM and must not also open the row.
    if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target)) return;
    // Only a selection INSIDE this row means "I was selecting text"; a stale one
    // elsewhere on the page must not make every row click do nothing.
    const selection = window.getSelection();
    if (
      selection !== null &&
      !selection.isCollapsed &&
      selection.anchorNode !== null &&
      e.currentTarget.contains(selection.anchorNode)
    ) {
      return;
    }
    if (newTab) window.open(href, '_blank', 'noopener');
    else void navigate(path);
  };
  return {
    onClick: (e) => open(e, e.metaKey || e.ctrlKey || e.shiftKey),
    onAuxClick: (e) => {
      if (e.button === 1) open(e, true);
    },
  };
}
