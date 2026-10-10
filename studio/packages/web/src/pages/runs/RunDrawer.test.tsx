import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RunDrawer, RUN_DRAWER_LABEL } from './RunDrawer';
import { RUN_DRAWER_PUSH_MIN } from './runDrawerFrame';

const original = window.innerWidth;

function resizeTo(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  window.dispatchEvent(new Event('resize'));
}

afterEach(() => resizeTo(original));

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
  });
});
