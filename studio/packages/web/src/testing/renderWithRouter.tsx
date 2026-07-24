import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

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
