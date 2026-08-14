import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HubRail } from './HubRail';
import { HUBS } from './hubs';
import { createUiStore } from '../stores/uiStore';
import { renderWithRouter } from '../testing/renderWithRouter';
import * as versionApi from '../api/version';

// `HubRail` now also mounts `VersionBadge`, which fires a real `getVersion()`
// (and thus `fetch('/api/version')`) on every render. None of the cases below
// are about the version badge — mocked here so the suite stays a deterministic
// unit test rather than an unmocked network attempt in jsdom on every render.
beforeEach(() => {
  vi.spyOn(versionApi, 'getVersion').mockResolvedValue({
    version: '2026.07.30',
    commit: 'e93ebf8',
    builtAt: '2026-07-30T09:12:44.000Z',
    arch: 'arm64',
  });
});

afterEach(() => {
  document.documentElement.style.colorScheme = '';
  vi.restoreAllMocks();
});

function renderRail(path: string) {
  return renderWithRouter(<HubRail store={createUiStore(undefined)} />, path);
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
    /* Scoped to the hub LIST, not the whole rail. The foot carries links of its
       own now (#1094's Settings gear), and an unscoped query would fold them
       into this list — turning "the rail's hubs are exactly `HUBS`" into "the
       rail's links are exactly `HUBS`", which is a different and wrong claim.
       Scoping keeps the invariant about hubs, where it belongs. */
    const list = screen.getByRole('list');
    const links = within(list).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('aria-label'))).toEqual(HUBS.map((h) => h.label));
  });

  /* The foot's link is deliberately NOT a hub — see `HubRail.tsx`. Pinned here
     because the invariant above can no longer see it: it must exist, and it
     must stay out of `HUBS`. */
  it('reaches Settings from the foot without making it a hub', () => {
    renderRail('/');
    /* No `#` — the test router is a MEMORY router, so hrefs are plain paths;
       the hash comes from `createHashRouter` in the real app. */
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(HUBS.map((h) => h.label)).not.toContain('Settings');
  });

  it('leaves every hub unlit on /settings', () => {
    renderRail('/settings');
    expect(activeLabels()).toEqual([]);
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
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
    renderWithRouter(<HubRail store={store} />, '/');

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
