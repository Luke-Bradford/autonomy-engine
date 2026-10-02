import { useCallback, type RefObject } from 'react';
import { useStore } from 'zustand';
import { PaneSplitter } from '../../shell/PaneSplitter';
import { useElementSize } from './useElementSize';
import {
  PROBLEMS_MIN_WIDTH,
  PROBLEMS_RESIZE_STEP,
  problemsMaxWidth,
  uiStore,
} from '../../stores/uiStore';

/** The custom property the Problems column's width reads (`index.css`). */
export const PROBLEMS_WIDTH_VAR = '--problems-width';

interface ProblemsSplitterProps {
  /** `.property-dock__body`, which holds the properties and Problems and carries the property. */
  bodyRef: RefObject<HTMLElement | null>;
  problemsId: string;
}

/**
 * #1475 OR27 — the divider between the properties and the Problems column:
 * drag it or arrow-key it. Problems sits RIGHT of it, so dragging left widens
 * it (`grow={-1}`).
 *
 * The cap is half the dock body (`problemsMaxWidth`), so the properties never
 * lose more than half the dock to the list beside them. Like the dock's, it
 * belongs to the container and is never stored: the value reported is the
 * stored width under the cap, which is what the CSS draws. It watches the
 * BODY's width, which a drag of this divider does not change.
 *
 * Until the body has been measured — and whenever it is `hidden` with the
 * folded dock — it draws only its empty track, as `DockSplitter` does, so no
 * key can clamp against a maximum taken from a zero-width body.
 */
export function ProblemsSplitter({ bodyRef, problemsId }: ProblemsSplitterProps) {
  const width = useStore(uiStore, (s) => s.problemsWidth);
  const setWidth = useStore(uiStore, (s) => s.setProblemsWidth);
  const body = useElementSize(bodyRef, 'width');

  const preview = useCallback(
    (next: number) => bodyRef.current?.style.setProperty(PROBLEMS_WIDTH_VAR, `${next}px`),
    [bodyRef],
  );

  if (body <= 0) return <div className="problems-splitter" aria-hidden="true" />;
  const max = problemsMaxWidth(body);
  return (
    <PaneSplitter
      className="problems-splitter"
      grow={-1}
      value={Math.min(width, max)}
      min={PROBLEMS_MIN_WIDTH}
      max={max}
      step={PROBLEMS_RESIZE_STEP}
      label="Resize problems"
      controls={problemsId}
      onPreview={preview}
      onCommit={setWidth}
    />
  );
}
