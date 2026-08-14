import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import App from './App';
import { ROUTES } from './routes';
import { uiStore } from './stores/uiStore';
import { AppThemeProvider } from './theme/AppThemeProvider';

// Routing itself is covered by `routes.test.tsx`; what is under test HERE is
// the composition — that `App` hosts the real route tree, and that the shell it
// renders shares one store with the theme provider wrapping it. The network
// stubs exist only so the landed page mounts without real I/O.
vi.mock('./api/connections', async (importActual) => ({
  ...(await importActual<typeof import('./api/connections')>()),
  listConnections: vi.fn().mockResolvedValue([]),
}));

// #1085 — every case here renders the real route tree at `/`, and Home now
// loads its recent runs on mount. Unmocked that reaches a real `fetch` in
// jsdom, the same hazard `routes.test.tsx` documents for its own stubs. The
// PAGED envelope, not a bare array: `usePagedList` spreads `page.items`.
vi.mock('./api/runs', async (importActual) => ({
  ...(await importActual<typeof import('./api/runs')>()),
  listRuns: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
}));

/**
 * The rail's links, scoped away from the page body. The Home page signposts the
 * same hubs, so an unscoped `getByRole('link', {name: 'Manage'})` is ambiguous
 * there — and silently would have been asserting the wrong element.
 */
function rail() {
  return within(screen.getByRole('navigation', { name: 'Primary' }));
}

/** `App` defaults to the hash router; tests drive the same ROUTES in memory. */
function renderApp(initialPath = '/') {
  return render(<App router={createMemoryRouter(ROUTES, { initialEntries: [initialPath] })} />);
}

beforeEach(() => {
  uiStore.getState().setThemeMode('dark');
});
afterEach(() => {
  vi.restoreAllMocks();
  uiStore.getState().setThemeMode('dark');
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = '';
});

describe('App', () => {
  it('mounts the shell — hub rail plus the routed page', async () => {
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(rail().getByRole('link', { name: 'Monitor' })).toBeInTheDocument();
  });

  /**
   * The rail lives on a LAYOUT route, so a hub change must re-render the outlet
   * and leave the rail's DOM node alone. Asserted by node IDENTITY: "a rail is
   * present afterwards" would hold just as well if `AppShell` were not a layout
   * route and every page rendered its own `HubRail` — which is the design this
   * is here to rule out.
   */
  it('keeps the rail mounted across a hub change', async () => {
    const user = userEvent.setup();
    renderApp('/');

    const railBefore = screen.getByRole('navigation', { name: 'Primary' });
    await user.click(rail().getByRole('link', { name: 'Manage' }));

    expect(await screen.findByRole('heading', { name: 'Connections' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBe(railBefore);
    expect(rail().getByRole('link', { name: 'Manage' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('App theme toggle', () => {
  it('renders a named, keyboard-operable control wired to the ui store', async () => {
    const user = userEvent.setup();
    renderApp();

    const toggle = screen.getByRole('switch', { name: /dark mode/i });
    expect(toggle).toBeChecked();

    await user.click(toggle);
    expect(uiStore.getState().themeMode).toBe('light');
    expect(toggle).not.toBeChecked();

    // Operable from the keyboard alone (Space on a focused switch).
    toggle.focus();
    await user.keyboard('[Space]');
    expect(uiStore.getState().themeMode).toBe('dark');
  });

  /**
   * The composed tree the app actually ships (`AppThemeProvider > App`), on the
   * DEFAULT store both sides fall back to. This is what proves the rail's
   * toggle and the provider are driven by the SAME store — each takes an
   * injectable `store`, so nothing else would catch a future change that
   * injected one into the provider alone and left the toggle moving a store no
   * one renders.
   */
  it('drives the document theme end-to-end from the rendered toggle', async () => {
    const user = userEvent.setup();
    render(
      <AppThemeProvider>
        <App router={createMemoryRouter(ROUTES, { initialEntries: ['/'] })} />
      </AppThemeProvider>,
    );
    expect(document.documentElement.dataset.theme).toBe('dark');

    await user.click(screen.getByRole('switch', { name: /dark mode/i }));

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });
});
