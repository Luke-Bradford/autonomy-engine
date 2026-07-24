import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaneSplitter } from './PaneSplitter';
import {
  PANE_DEFAULT_WIDTH,
  PANE_MAX_WIDTH,
  PANE_MIN_WIDTH,
  PANE_RESIZE_STEP,
} from '../stores/uiStore';

/**
 * The splitter's KEYBOARD half — a spec accessibility criterion in its own
 * right ("keyboard-operable splitter") — plus the pointer BRANCHES that a real
 * browser drag never reaches.
 *
 * The happy-path drag belongs in `e2e/shell-pane.spec.ts`, where a real browser
 * moves a real pointer and the resulting layout is measured; simulating that
 * here would mostly be testing the simulation. But the guards around it —
 * a non-primary button, and a cancelled drag — are unreachable from that spec
 * (Playwright's drag uses the primary button and always ends with `pointerup`),
 * so a mutation check found all three surviving. jsdom dispatches pointer
 * events fine; it only lacks the CAPTURE API, which the component
 * optional-calls precisely so these cases are reachable.
 */
function renderSplitter(width = PANE_DEFAULT_WIDTH) {
  const onCommit = vi.fn();
  const onPreview = vi.fn();
  render(
    <PaneSplitter width={width} onCommit={onCommit} onPreview={onPreview} controls="pane-id" />,
  );
  return { onCommit, onPreview, splitter: screen.getByRole('separator') };
}

describe('PaneSplitter', () => {
  it('exposes itself as a focusable, labelled vertical separator', () => {
    const { splitter } = renderSplitter(300);
    expect(splitter).toHaveAttribute('aria-orientation', 'vertical');
    expect(splitter).toHaveAttribute('aria-controls', 'pane-id');
    expect(splitter).toHaveAccessibleName();
    // A separator is only in the tab order when it is OPERABLE; that is exactly
    // what distinguishes a window splitter from a decorative rule.
    expect(splitter).toHaveAttribute('tabindex', '0');
  });

  /**
   * The value is reported on the ARIA range attributes, not just applied to the
   * layout. Without them a screen-reader user gets "separator" and no idea
   * whether their arrow key did anything.
   */
  it('reports the current width and its bounds', () => {
    const { splitter } = renderSplitter(300);
    expect(splitter).toHaveAttribute('aria-valuenow', '300');
    expect(splitter).toHaveAttribute('aria-valuemin', String(PANE_MIN_WIDTH));
    expect(splitter).toHaveAttribute('aria-valuemax', String(PANE_MAX_WIDTH));
  });

  it.each([
    ['{ArrowRight}', PANE_DEFAULT_WIDTH + PANE_RESIZE_STEP],
    ['{ArrowLeft}', PANE_DEFAULT_WIDTH - PANE_RESIZE_STEP],
  ])('commits a %s step', async (key, expected) => {
    const user = userEvent.setup();
    const { onCommit, splitter } = renderSplitter();
    splitter.focus();
    await user.keyboard(key);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it.each([
    ['{Home}', PANE_MIN_WIDTH],
    ['{End}', PANE_MAX_WIDTH],
  ])('jumps to a bound on %s', async (key, expected) => {
    const user = userEvent.setup();
    const { onCommit, splitter } = renderSplitter(300);
    splitter.focus();
    await user.keyboard(key);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(expected);
  });

  /**
   * Keyboard steps CLAMP rather than running past the bound. Stepping below the
   * minimum would otherwise persist an out-of-range width that the store then
   * clamps on the way back in, so the pane would stop moving while the reported
   * `aria-valuenow` kept counting down — a control that lies about its state.
   */
  it.each([
    ['{ArrowLeft}', PANE_MIN_WIDTH, PANE_MIN_WIDTH],
    ['{ArrowRight}', PANE_MAX_WIDTH, PANE_MAX_WIDTH],
  ])('clamps %s at the bound', async (key, from, expected) => {
    const user = userEvent.setup();
    const { onCommit, splitter } = renderSplitter(from);
    splitter.focus();
    await user.keyboard(key);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(expected);
  });

  /**
   * A keyboard step goes STRAIGHT to the committed store, never through the
   * transient preview path. `onPreview` writes the CSS variable directly on the
   * shell element, behind React's back; if a keyboard step used it too, the
   * next render would restore the store's width and the pane would snap back.
   */
  it('does not use the transient preview path for keyboard steps', async () => {
    const user = userEvent.setup();
    const { onPreview, splitter } = renderSplitter();
    splitter.focus();
    await user.keyboard('{ArrowRight}');
    expect(onPreview).not.toHaveBeenCalled();
  });

  /**
   * Home/End must `preventDefault`, or the browser ALSO scrolls the workspace
   * to top/bottom while the pane resizes — two unrelated things happening from
   * one key press.
   */
  it.each(['Home', 'End'])('prevents the default scroll on %s', (key) => {
    const { splitter } = renderSplitter(300);
    // `fireEvent`, not `userEvent`: the return value of `dispatchEvent` is the
    // only way to observe that the default was prevented, and `userEvent` does
    // not surface it.
    const notPrevented = fireEvent.keyDown(splitter, { key });
    expect(notPrevented).toBe(false);
  });

  /**
   * A non-primary press must not begin a drag. A right-click starts no gesture
   * the browser will finish — there is no `pointerup` on this element to end
   * it — so without the guard the splitter would be left mid-drag and the next
   * pointer move over it would resize the pane with no button held down.
   */
  it('ignores a non-primary button press', () => {
    const { onPreview, onCommit, splitter } = renderSplitter();
    fireEvent.pointerDown(splitter, { button: 2, clientX: 100 });
    fireEvent.pointerMove(splitter, { clientX: 160 });
    expect(onPreview).not.toHaveBeenCalled();
    fireEvent.pointerUp(splitter, { clientX: 160 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  /**
   * A cancelled drag (pointer lost to a system gesture, or dragged off-window)
   * still commits the width reached, and — the part that matters — CLEARS the
   * drag state. Without the `pointercancel` handler the drag would never end,
   * so a later stray move would keep resizing the pane.
   */
  it('commits and ends the drag on pointercancel', () => {
    const { onPreview, onCommit, splitter } = renderSplitter();
    fireEvent.pointerDown(splitter, { button: 0, clientX: 100 });
    fireEvent.pointerMove(splitter, { clientX: 160 });
    expect(onPreview).toHaveBeenLastCalledWith(300);

    fireEvent.pointerCancel(splitter, { clientX: 160 });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(300);

    // The drag is over: a further move must not preview anything.
    onPreview.mockClear();
    fireEvent.pointerMove(splitter, { clientX: 400 });
    expect(onPreview).not.toHaveBeenCalled();
  });

  it('ignores keys it does not handle', async () => {
    const user = userEvent.setup();
    const { onCommit, splitter } = renderSplitter();
    splitter.focus();
    await user.keyboard('{ArrowUp}a{Enter}');
    expect(onCommit).not.toHaveBeenCalled();
  });
});
