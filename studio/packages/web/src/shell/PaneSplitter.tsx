import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import {
  PANE_MAX_WIDTH,
  PANE_MIN_WIDTH,
  PANE_RESIZE_STEP,
  clampPaneWidth,
} from '../stores/uiStore';

interface PaneSplitterProps {
  /** The pane's committed width, in px. */
  width: number;
  /**
   * Transient width during a pointer drag. The shell writes it straight onto
   * its own `--pane-width` custom property, bypassing React — see the note on
   * the drag handlers below.
   */
  onPreview: (width: number) => void;
  /** The final width, to be stored and persisted. */
  onCommit: (width: number) => void;
  /** Id of the pane this resizes. */
  controls: string;
}

/**
 * The draggable divider between the secondary pane and the workspace.
 *
 * ARIA-wise this is a WINDOW SPLITTER: `role="separator"` that is focusable and
 * reports a value. The spec's accessibility criteria call for a
 * keyboard-operable splitter specifically, so the arrow keys are not a
 * courtesy — they are the requirement, and the pointer drag is the alternative.
 *
 * DRAG PATH — deliberately does NOT go through React state. A pointer drag
 * fires `pointermove` at the display's refresh rate; routing each one through
 * the store would re-render the whole shell (rail included) ~60 times a second
 * and, if the store persisted on every set, write to `localStorage` just as
 * often — synchronous main-thread I/O per frame. Instead the move handler hands
 * the width to `onPreview`, which sets the CSS custom property directly on the
 * shell element, and only `pointerup` commits to the store. The one consequence
 * worth knowing: mid-drag the store and the DOM disagree, so anything that
 * re-renders `AppShell` during a drag would snap the pane back to the committed
 * width. Nothing does today (a captured pointer means no other input is live).
 *
 * The keyboard path takes the opposite route — straight to `onCommit`, never
 * `onPreview` — because a keyboard step is already a discrete, committed
 * action, and a preview-only step would be reverted by the very next render.
 */
export function PaneSplitter({ width, onPreview, onCommit, controls }: PaneSplitterProps) {
  /** Drag origin, and the latest previewed width. Null when not dragging. */
  const drag = useRef<{ startX: number; startWidth: number; latest: number } | null>(null);

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    // Primary button only: a right-click would otherwise start a drag that no
    // `pointerup` on this element ever ends.
    if (event.button !== 0) return;
    drag.current = { startX: event.clientX, startWidth: width, latest: width };
    // Optional-called: jsdom implements no pointer capture, and a future unit
    // test that simulates a drag should fail on its assertion, not here.
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state) return;
    // The pane grows to the RIGHT of the rail, so rightward pointer travel is a
    // wider pane. Measured from the drag ORIGIN rather than accumulated per
    // event, so a dropped move event cannot make the width drift from the
    // pointer.
    state.latest = clampPaneWidth(state.startWidth + (event.clientX - state.startX));
    onPreview(state.latest);
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onCommit(state.latest);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = {
      ArrowLeft: width - PANE_RESIZE_STEP,
      ArrowRight: width + PANE_RESIZE_STEP,
      Home: PANE_MIN_WIDTH,
      End: PANE_MAX_WIDTH,
    }[event.key];
    if (next === undefined) return;
    // Home/End would otherwise scroll the workspace out from under the user.
    event.preventDefault();
    // Clamped here as well as in the store: stepping past a bound must stop the
    // REPORTED value too, or `aria-valuenow` keeps counting while the pane sits
    // still — a control that lies about its own state.
    onCommit(clampPaneWidth(next));
  }

  return (
    <div
      className="pane-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize navigation pane"
      aria-controls={controls}
      aria-valuenow={width}
      aria-valuemin={PANE_MIN_WIDTH}
      aria-valuemax={PANE_MAX_WIDTH}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      /* Pointer capture makes a lost pointer (dragged off-window, or cancelled
         by a system gesture) fire `pointercancel` rather than `pointerup`.
         Without this the drag state would never clear and the next move would
         resume a drag the user had abandoned. */
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
    />
  );
}
