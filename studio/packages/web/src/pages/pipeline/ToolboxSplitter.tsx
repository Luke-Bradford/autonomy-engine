import { useCallback, type RefObject } from 'react';
import { useStore } from 'zustand';
import { PaneSplitter } from '../../shell/PaneSplitter';
import {
  TOOLBOX_MAX_WIDTH,
  TOOLBOX_MIN_WIDTH,
  TOOLBOX_RESIZE_STEP,
  uiStore,
} from '../../stores/uiStore';

/** The custom property `.canvas-grid`'s toolbox track reads (`index.css`). */
export const TOOLBOX_WIDTH_VAR = '--toolbox-width';

interface ToolboxSplitterProps {
  /** `.canvas-grid`, whose first track is the toolbox. */
  gridRef: RefObject<HTMLElement | null>;
  toolboxId: string;
}

/**
 * #1475 OR27 — the divider between the Activities toolbox and the canvas:
 * drag it or arrow-key it, 140–360px, persisted per viewer.
 *
 * The bounds are fixed (unlike the dock's, which belong to its column), so
 * this is the nav pane's splitter on a different element: the drag previews
 * onto the grid's custom property and only the release commits to `uiStore`
 * (`PaneSplitter` says why).
 *
 * Folded to the rail there is nothing to size, so it draws only its empty
 * track, `aria-hidden` — the grid keeps its three tracks and the canvas edge
 * moves only by the toolbox's own change of width.
 */
export function ToolboxSplitter({ gridRef, toolboxId }: ToolboxSplitterProps) {
  const width = useStore(uiStore, (s) => s.toolboxWidth);
  const setWidth = useStore(uiStore, (s) => s.setToolboxWidth);
  const collapsed = useStore(uiStore, (s) => s.toolboxCollapsed);
  const preview = useCallback(
    (next: number) => gridRef.current?.style.setProperty(TOOLBOX_WIDTH_VAR, `${next}px`),
    [gridRef],
  );

  if (collapsed) return <div className="toolbox-splitter" aria-hidden="true" />;
  return (
    <PaneSplitter
      className="toolbox-splitter"
      value={width}
      min={TOOLBOX_MIN_WIDTH}
      max={TOOLBOX_MAX_WIDTH}
      step={TOOLBOX_RESIZE_STEP}
      label="Resize activities"
      controls={toolboxId}
      onPreview={preview}
      onCommit={setWidth}
    />
  );
}
