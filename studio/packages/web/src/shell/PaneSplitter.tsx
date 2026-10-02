import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

interface PaneSplitterProps {
  /** The resized element's committed size along `axis`, in px. */
  value: number;
  /** Bounds of `value`, in px — reported on the ARIA range and enforced. */
  min: number;
  max: number;
  /** The keyboard increment, in px. */
  step: number;
  /** Accessible name, e.g. "Resize navigation pane". */
  label: string;
  /**
   * `x` resizes a width (a vertical divider, dragged sideways — the nav pane);
   * `y` resizes a height (a horizontal divider, dragged up and down — #1475's
   * property dock).
   */
  axis?: 'x' | 'y';
  /**
   * Whether moving the divider right/down GROWS the value (`1`) or shrinks it
   * (`-1`). The nav pane sits LEFT of its divider, so dragging right widens it;
   * the property dock sits BELOW its divider, so dragging UP makes it taller.
   */
  grow?: 1 | -1;
  /** `pane-splitter` (the nav pane), `dock-splitter` or `toolbox-splitter` (#1475). */
  className: string;
  /**
   * Transient size during a pointer drag. The owner writes it straight onto
   * its own custom property, bypassing React — see the note on the drag
   * handlers below.
   */
  onPreview: (value: number) => void;
  /** The final size, to be stored and persisted. */
  onCommit: (value: number) => void;
  /** #1475 — the "maximise" double-click, where the owner offers one. */
  onDoubleClick?: () => void;
  /** Id of the element this resizes. */
  controls: string;
}

/** Pointer travel below this is a click, not a drag (`drag` in `PaneSplitter`). */
const DRAG_THRESHOLD_PX = 3;

/**
 * A draggable divider: between the secondary pane and the workspace (U3), and
 * between the canvas and its property dock and Activities toolbox (#1475 OR27).
 *
 * ARIA-wise this is a WINDOW SPLITTER: `role="separator"` that is focusable and
 * reports a value. The spec's accessibility criteria call for a
 * keyboard-operable splitter specifically, so the arrow keys are not a
 * courtesy — they are the requirement, and the pointer drag is the alternative.
 *
 * DRAG PATH — deliberately does NOT go through React state. A pointer drag
 * fires `pointermove` at the display's refresh rate; routing each one through
 * the store would re-render the owner (the whole shell, or the whole editor)
 * ~60 times a second and, if the store persisted on every set, write to
 * `localStorage` just as often — synchronous main-thread I/O per frame. Instead
 * the move handler hands the size to `onPreview`, which sets the owner's CSS
 * custom property directly on its element, and only `pointerup` commits to the
 * store.
 *
 * The hazard is NOT that a re-render mid-drag snaps the element back: React
 * writes an inline style key only when the PROP changes, so a re-render
 * carrying the same value leaves an out-of-band write alone (browser-verified).
 * It is the opposite — a preview that never reaches a commit is never
 * reconciled by ANY later render, so the element would keep a size the store
 * has never heard of, indefinitely. `endDrag` running on every exit is what
 * rules that out: pointer capture guarantees a `pointerup` or a
 * `pointercancel`, and both commit any drag that previewed. Hence
 * `onPointerCancel` below is load-bearing, not defensive.
 *
 * The keyboard path takes the opposite route — straight to `onCommit`, never
 * `onPreview` — because a keyboard step is already a discrete, committed
 * action, and a preview-only step would be reverted by the very next render.
 */
export function PaneSplitter({
  value,
  min,
  max,
  step,
  label,
  axis = 'x',
  grow = 1,
  className,
  onPreview,
  onCommit,
  onDoubleClick,
  controls,
}: PaneSplitterProps) {
  /**
   * Drag origin, and the latest previewed size. Null when not dragging.
   * `moved` is whether the pointer has crossed `DRAG_THRESHOLD_PX`: a press
   * that does not must preview and commit NOTHING. Otherwise a click stores the
   * size it happened to render at — for the dock, that turns its
   * viewport-relative default into a fixed px value — and so does a
   * double-click, whose hand rarely holds perfectly still.
   */
  const drag = useRef<{ start: number; startValue: number; latest: number; moved: boolean } | null>(
    null,
  );

  /** Rounded because the value becomes a px track; a non-finite input keeps the current value. */
  const clamp = (next: number) =>
    Number.isFinite(next) ? Math.round(Math.min(max, Math.max(min, next))) : value;
  const coord = (event: PointerEvent<HTMLDivElement>) =>
    axis === 'x' ? event.clientX : event.clientY;

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    // Primary button only: a right-click would otherwise start a drag that no
    // `pointerup` on this element ever ends.
    if (event.button !== 0) return;
    drag.current = { start: coord(event), startValue: value, latest: value, moved: false };
    // Optional-called: jsdom implements no pointer capture. That is what lets
    // `PaneSplitter.test.tsx` drive the non-primary-button and pointercancel
    // branches, which a real-browser drag never reaches.
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state) return;
    // Measured from the drag ORIGIN rather than accumulated per event, so a
    // dropped move event cannot make the size drift from the pointer.
    const travel = coord(event) - state.start;
    if (!state.moved && Math.abs(travel) < DRAG_THRESHOLD_PX) return;
    state.moved = true;
    state.latest = clamp(state.startValue + grow * travel);
    onPreview(state.latest);
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (state.moved) onCommit(state.latest);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // The arrows MOVE THE DIVIDER on its own axis; `grow` turns that into a
    // larger or smaller value. Home/End are the bounds, whichever way round.
    const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    const forward = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    const next = {
      [back]: value - grow * step,
      [forward]: value + grow * step,
      Home: min,
      End: max,
    }[event.key];
    if (next === undefined) return;
    // Home/End would otherwise scroll the workspace out from under the user.
    event.preventDefault();
    // A step that cannot move commits nothing. Committing the bound would
    // overwrite a preference the bound does not own: the dock's ceiling is the
    // CURRENT column's, so End on a laptop must not cut down for good a height
    // the operator chose on a taller screen.
    if (clamp(next) === value) return;
    // Clamped here as well as in the store: stepping past a bound must stop the
    // REPORTED value too, or `aria-valuenow` keeps counting while the pane sits
    // still — a control that lies about its own state.
    onCommit(clamp(next));
  }

  return (
    <div
      className={className}
      role="separator"
      // The ORIENTATION of the divider, not of the drag: a width splitter is a
      // vertical line.
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
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
      onDoubleClick={onDoubleClick}
    />
  );
}
