import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter, RouterProvider, createMemoryRouter } from 'react-router';

/**
 * Render a page component that is normally mounted by the router.
 *
 * Since U2 the pages call `useNavigate()`, which THROWS outside a router
 * context ("useNavigate() may be used only in the context of a <Router>") — so
 * every page test that renders a page in isolation needs an ancestor router.
 * `MemoryRouter` is the right one here: these tests exercise a page's own
 * behaviour, not routing, so they want a router that exists and goes nowhere,
 * with no `window.location` involvement and nothing to clean up between cases.
 *
 * Tests that assert on NAVIGATION (where a click lands) should not use this —
 * they should mount the real `ROUTES` under `createMemoryRouter`, as
 * `routes.test.tsx` does, so the destination is the real route.
 */
export function renderWithRouter(ui: ReactElement, initialPath = '/'): RenderResult {
  return render(<MemoryRouter initialEntries={[initialPath]}>{ui}</MemoryRouter>);
}

/**
 * `renderWithRouter` under a DATA router, for a page that holds navigation
 * with `useBlocker` (#1396's unsaved-changes guard), which throws under a
 * `MemoryRouter`. Separate rather than a change to `renderWithRouter`, because
 * several tests `rerender` inside a `MemoryRouter`, and a `RouterProvider` root
 * would remount their whole tree on that rerender.
 *
 * Returns the router too, so a test can navigate and watch the guard hold it.
 */
export function renderWithDataRouter(
  ui: ReactElement,
  initialPath = '/',
): RenderResult & { router: ReturnType<typeof createMemoryRouter> } {
  const router = createMemoryRouter([{ path: '*', element: ui }], {
    initialEntries: [initialPath],
  });
  return { ...render(<RouterProvider router={router} />), router };
}
