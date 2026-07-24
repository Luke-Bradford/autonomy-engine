import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { HubRail } from './HubRail';
import { HUBS } from './hubs';
import { createUiStore } from '../stores/uiStore';

afterEach(() => {
  document.documentElement.style.colorScheme = '';
});

function renderRail(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <HubRail store={createUiStore(undefined)} />
    </MemoryRouter>,
  );
}

/** The hub labels the rail currently marks as active, in rail order. */
function activeLabels(): string[] {
  return HUBS.map((h) => h.label).filter(
    (label) => screen.getByRole('link', { name: label }).getAttribute('aria-current') === 'page',
  );
}

describe('HubRail', () => {
  it('renders one named link per hub, in SSOT order', () => {
    renderRail('/');
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.getAttribute('aria-label'))).toEqual(HUBS.map((h) => h.label));
  });

  /**
   * These four cases pin the matching rules the rail RELIES ON. They are
   * written against the rendered rail rather than a path helper of our own,
   * because `NavLink` is what actually decides — so this is also the guard that
   * would catch react-router changing its `isActive` semantics under us.
   */
  it('marks exactly the hub you are in', () => {
    renderRail('/manage/triggers');
    expect(activeLabels()).toEqual(['Manage']);
  });

  it('keeps the hub active on a deep child route', () => {
    renderRail('/monitor/runs/run_42');
    expect(activeLabels()).toEqual(['Monitor']);
  });

  /**
   * Home owns `/`, which every path in the app is prefixed by. A prefix match
   * would light Home up on every route — this is the case that catches it.
   */
  it('does not light Home up on every route', () => {
    renderRail('/author/pipelines');
    expect(activeLabels()).toEqual(['Author']);
  });

  it('matches on a segment boundary, not a bare prefix', () => {
    // A future '/authoring' hub must not be swallowed by '/author'.
    renderRail('/authoring');
    expect(activeLabels()).toEqual([]);
  });

  /**
   * The spec's accessibility criteria forbid a colour-only status. The rail
   * signals "active" on three channels; this pins the one that survives in a
   * greyscale or high-contrast rendering alongside `aria-current` — the class
   * the accent bar hangs off, which is also what swaps the icon to its filled
   * variant.
   */
  it('marks the active hub with a non-colour channel too', () => {
    renderRail('/author/pipelines');
    expect(screen.getByRole('link', { name: 'Author' }).className).toContain(
      'hub-rail__link--active',
    );
    expect(screen.getByRole('link', { name: 'Home' }).className).not.toContain(
      'hub-rail__link--active',
    );
  });

  it('carries the theme toggle, wired to the store it was given', async () => {
    const user = userEvent.setup();
    const store = createUiStore(undefined);
    render(
      <MemoryRouter initialEntries={['/']}>
        <HubRail store={store} />
      </MemoryRouter>,
    );

    const toggle = screen.getByRole('switch', { name: 'Dark mode' });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(store.getState().themeMode).toBe('light');
  });

  it('is keyboard reachable — every hub link takes focus in order', async () => {
    const user = userEvent.setup();
    renderRail('/');

    for (const hub of HUBS) {
      await user.tab();
      expect(screen.getByRole('link', { name: hub.label })).toHaveFocus();
    }
  });
});
