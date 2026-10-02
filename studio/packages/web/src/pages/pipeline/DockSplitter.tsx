import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useStore } from 'zustand';
import { PaneSplitter } from '../../shell/PaneSplitter';
import { useElementSize } from './useElementSize';
import {
  DOCK_MIN_HEIGHT,
  DOCK_MIN_WIDTH,
  DOCK_RESIZE_STEP,
  dockMaxHeight,
  dockMaxWidth,
  uiStore,
  type DockPosition,
} from '../../stores/uiStore';

/** The custom property `.property-dock`'s height reads (`index.css`). */
export const DOCK_HEIGHT_VAR = '--dock-height';
/** #1475 OR27 — the right-hand dock's width (`index.css`). */
export const DOCK_WIDTH_VAR = '--dock-width';

/**
 * What differs between the two places the dock can sit: the dimension that is
 * resized, its bounds, its preference and its custom property. A bottom dock
 * sits BELOW its divider and a right-hand one to its RIGHT, so in both,
 * dragging toward the canvas grows it (`grow={-1}`).
 */
const AXES = {
  bottom: {
    axis: 'y',
    size: 'height',
    min: DOCK_MIN_HEIGHT,
    maxFor: dockMaxHeight,
    cssVar: DOCK_HEIGHT_VAR,
  },
  right: {
    axis: 'x',
    size: 'width',
    min: DOCK_MIN_WIDTH,
    maxFor: dockMaxWidth,
    cssVar: DOCK_WIDTH_VAR,
  },
} as const;

interface DockSplitterProps {
  /** `.canvas-main`, the column the canvas and the dock share. */
  columnRef: RefObject<HTMLElement | null>;
  /** `.property-dock`, the element this resizes. */
  dockRef: RefObject<HTMLElement | null>;
  dockId: string;
  /**
   * Which edge of the canvas the dock is on. The owner KEYS this component by
   * it, so a drag or a maximise in one position can never be finished in the
   * other — a height committed as a width.
   */
  position: DockPosition;
}

/**
 * #1475 OR27 — the divider between the canvas and its property dock: drag it,
 * arrow-key it, or double-click it to maximise the dock and again to put it
 * back.
 *
 * Written for the bottom dock, whose HEIGHT it sizes; for a right-hand dock
 * every "height" below reads as width, through `AXES`.
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
export function DockSplitter({ columnRef, dockRef, dockId, position }: DockSplitterProps) {
  const { axis, size, min, maxFor, cssVar } = AXES[position];
  const dockSize = useStore(uiStore, (s) => (position === 'right' ? s.dockWidth : s.dockHeight));
  const setDockSize = useStore(uiStore, (s) =>
    position === 'right' ? s.setDockWidth : s.setDockHeight,
  );
  const column = useElementSize(columnRef, size);
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
    if (el) setRendered(Math.round(el.getBoundingClientRect()[size]));
  }, [dockRef, dockSize, column, size]);

  const previewSize = useCallback(
    (next: number) => dockRef.current?.style.setProperty(cssVar, `${next}px`),
    [dockRef, cssVar],
  );

  const className = position === 'right' ? 'dock-splitter dock-splitter--right' : 'dock-splitter';
  if (column <= 0 || rendered <= 0) return <div className={className} aria-hidden="true" />;
  const max = maxFor(column);
  const value = dockSize === null ? Math.min(rendered, max) : Math.min(dockSize, max);

  function toggleMaximise() {
    if (value >= max) {
      // Already at the cap: back to what it was, or the default share when
      // the operator got here another way — a drag, End, or a height chosen on
      // a taller screen that this column cuts down.
      setDockSize(beforeMaximise.current ?? null);
      beforeMaximise.current = undefined;
      return;
    }
    beforeMaximise.current = dockSize;
    setDockSize(max);
  }

  return (
    <PaneSplitter
      className={className}
      axis={axis}
      grow={-1}
      value={value}
      min={min}
      max={max}
      step={DOCK_RESIZE_STEP}
      label="Resize properties"
      controls={dockId}
      onPreview={previewSize}
      onCommit={(next) => {
        beforeMaximise.current = undefined;
        setDockSize(next);
      }}
      onDoubleClick={toggleMaximise}
    />
  );
}
