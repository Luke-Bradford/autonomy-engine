import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../stores/uiStore';
import { RunDrawer, RUN_DRAWER_LABEL } from './RunDrawer';
import { RUN_DRAWER_PUSH_MAX_SHARE, RUN_DRAWER_PUSH_MIN } from './runDrawerFrame';

const original = window.innerWidth;

function resizeTo(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  window.dispatchEvent(new Event('resize'));
}

afterEach(() => {
  resizeTo(original);
  vi.restoreAllMocks();
  uiStore.getState().setRunDrawerWidth(null);
});

describe('RunDrawer', () => {
  it('is a named region that pushes the page where the window has room', () => {
    resizeTo(RUN_DRAWER_PUSH_MIN);
    render(
      <RunDrawer onClose={() => {}} returnFocusTo={null}>
        <p>record</p>
      </RunDrawer>,
    );
    const drawer = screen.getByRole('region', { name: RUN_DRAWER_LABEL });
    expect(drawer).toHaveAttribute('data-push');
    expect(drawer).not.toHaveAttribute('aria-modal');
  });

  it('is a non-modal dialog over the page when narrower, and switches on a resize', () => {
    resizeTo(RUN_DRAWER_PUSH_MIN - 1);
    render(
      <RunDrawer onClose={() => {}} returnFocusTo={null}>
        <p>record</p>
      </RunDrawer>,
    );
    const drawer = screen.getByRole('dialog', { name: RUN_DRAWER_LABEL });
    expect(drawer).toHaveAttribute('aria-modal', 'false');
    expect(drawer).not.toHaveAttribute('data-push');

    act(() => resizeTo(RUN_DRAWER_PUSH_MIN));
    expect(screen.getByRole('region', { name: RUN_DRAWER_LABEL })).toBe(drawer);
    expect(drawer).toHaveAttribute('data-push');
    expect(drawer).not.toHaveAttribute('aria-modal');
  });

  it('lies over the page when dragged past half the window, which a push would crush', () => {
    resizeTo(1440);
    uiStore.getState().setRunDrawerWidth(1440 * RUN_DRAWER_PUSH_MAX_SHARE);
    render(
      <RunDrawer onClose={() => {}} returnFocusTo={null}>
        <p>record</p>
      </RunDrawer>,
    );
    expect(screen.getByRole('region', { name: RUN_DRAWER_LABEL })).toBeTruthy();
    act(() => uiStore.getState().setRunDrawerWidth(1440 * RUN_DRAWER_PUSH_MAX_SHARE + 16));
    expect(screen.getByRole('dialog', { name: RUN_DRAWER_LABEL })).not.toHaveAttribute('data-push');
  });

  it('previews a drag on the run page, and puts the kept width back if it closes mid-drag', () => {
    resizeTo(1440);
    uiStore.getState().setRunDrawerWidth(400);
    // jsdom lays nothing out; the splitter shows once the drawer has a width.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 400,
    } as DOMRect);
    const { container, rerender } = render(
      <section className="run-page">
        <RunDrawer onClose={() => {}} returnFocusTo={null}>
          <p>record</p>
        </RunDrawer>
      </section>,
    );
    const page = container.querySelector<HTMLElement>('.run-page')!;
    const splitter = screen.getByRole('separator');
    fireEvent.pointerDown(splitter, { button: 0, clientX: 1000 });
    fireEvent.pointerMove(splitter, { clientX: 960 });
    expect(page.style.getPropertyValue('--run-drawer-width')).toBe('440px');
    expect(screen.getByRole('region', { name: RUN_DRAWER_LABEL })).toBeTruthy();
    // Past half the window it stops pushing mid-drag, not on release.
    fireEvent.pointerMove(splitter, { clientX: 600 });
    expect(screen.getByRole('dialog', { name: RUN_DRAWER_LABEL })).not.toHaveAttribute('data-push');

    // Closed before the drag commits: the page goes back to the kept 400.
    rerender(<section className="run-page" />);
    expect(page.style.getPropertyValue('--run-drawer-width')).toBe('400px');
  });
});
