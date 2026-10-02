import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useStore } from 'zustand';
import { PaneSplitter } from '../../shell/PaneSplitter';
import { useElementSize } from './useElementSize';
import { DOCK_MIN_HEIGHT, DOCK_RESIZE_STEP, dockMaxHeight, uiStore } from '../../stores/uiStore';

/** The custom property `.property-dock`'s height reads (`index.css`). */
export const DOCK_HEIGHT_VAR = '--dock-height';

interface DockSplitterProps {
  /** `.canvas-main`, the column the canvas and the dock share. */
  columnRef: RefObject<HTMLElement | null>;
  /** `.property-dock`, the element this resizes. */
  dockRef: RefObject<HTMLElement | null>;
  dockId: string;
}

/**
 * #1475 OR27 — the divider between the canvas and its property dock: drag it,
 * arrow-key it, or double-click it to maximise the dock and again to put it
 * back.
 *
 * Its OWN component so its measuring re-renders only itself, never the editor
 * around it. It watches the COLUMN's height (which bounds the dock and does not
 * change during a drag), not the dock's — a dock observer would fire on every
 * drag frame, which is exactly what `PaneSplitter` keeps out of React.
 *
 * The value it reports is the stored height under the column's cap, which is
 * what the CSS draws; until the first resize there is no stored height, only
 * the default share, and then it is the dock's RENDERED height, read from the
 * DOM. The store comes first because it is current the moment a key commits,
 * where a DOM read lags a render behind — so a quick run of arrow keys steps
 * from where the last one landed.
 *
 * Until the column has been measured it draws only the empty 8px track — the
 * same box, so the divider arriving moves nothing (#1393's no-shift rule) —
 * and offers no control, so no key or drag can clamp against a maximum taken
 * from a zero-height column. jsdom, with no layout and no `ResizeObserver`,
 * only ever gets the track.
 */
export function DockSplitter({ columnRef, dockRef, dockId }: DockSplitterProps) {
  const dockHeight = useStore(uiStore, (s) => s.dockHeight);
  const setDockHeight = useStore(uiStore, (s) => s.setDockHeight);
  const column = useElementSize(columnRef, 'height');
  const [rendered, setRendered] = useState(0);
  /**
   * The preference to go back to from a double-click maximise. `undefined`
   * means "not maximised from here"; `null` is a real value — the default share.
   */
  const beforeMaximise = useRef<number | null | undefined>(undefined);

  // Re-read after anything that can change the dock's height: a committed
  // preference, or a new column height (which moves the default share and the cap).
  // Passive, not layout, for `useElementSize`'s reason: `dockRef` is on this
  // component's next sibling, attached only after its layout effects.
  useEffect(() => {
    const el = dockRef.current;
    if (el) setRendered(Math.round(el.getBoundingClientRect().height));
  }, [dockRef, dockHeight, column]);

  const previewHeight = useCallback(
    (height: number) => dockRef.current?.style.setProperty(DOCK_HEIGHT_VAR, `${height}px`),
    [dockRef],
  );

  if (column <= 0 || rendered <= 0) return <div className="dock-splitter" aria-hidden="true" />;
  const max = dockMaxHeight(column);
  const value = dockHeight === null ? Math.min(rendered, max) : Math.min(dockHeight, max);

  function toggleMaximise() {
    if (value >= max) {
      // Already at the cap: back to what it was, or the default share when
      // the operator got here another way — a drag, End, or a height chosen on
      // a taller screen that this column cuts down.
      setDockHeight(beforeMaximise.current ?? null);
      beforeMaximise.current = undefined;
      return;
    }
    beforeMaximise.current = dockHeight;
    setDockHeight(max);
  }

  return (
    <PaneSplitter
      className="dock-splitter"
      axis="y"
      grow={-1}
      value={value}
      min={DOCK_MIN_HEIGHT}
      max={max}
      step={DOCK_RESIZE_STEP}
      label="Resize properties"
      controls={dockId}
      onPreview={previewHeight}
      onCommit={(height) => {
        beforeMaximise.current = undefined;
        setDockHeight(height);
      }}
      onDoubleClick={toggleMaximise}
    />
  );
}
