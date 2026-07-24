import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaneSplitter } from './PaneSplitter';
import {
  PANE_DEFAULT_WIDTH,
  PANE_MAX_WIDTH,
  PANE_MIN_WIDTH,
  PANE_RESIZE_STEP,
} from '../stores/uiStore';

/**
 * The splitter's KEYBOARD half, which is a spec accessibility criterion in its
 * own right ("keyboard-operable splitter") and the half jsdom can actually
 * execute: jsdom implements no Pointer Events capture API at all, so a
 * simulated drag here would be testing the simulation. The pointer half is
 * covered in `e2e/shell-pane.spec.ts`, where a real browser drags a real
 * splitter and the grid track is measured afterwards.
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

  it('ignores keys it does not handle', async () => {
    const user = userEvent.setup();
    const { onCommit, splitter } = renderSplitter();
    splitter.focus();
    await user.keyboard('{ArrowUp}a{Enter}');
    expect(onCommit).not.toHaveBeenCalled();
  });
});
