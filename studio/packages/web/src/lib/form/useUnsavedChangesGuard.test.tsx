import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { useUnsavedChangesGuard, type UnsavedChangesGuard } from './useUnsavedChangesGuard';
import { leavesPath } from './leavesPath';

/** Mount the guard in a data router at `/pipelines/p1`, dirty or clean. */
function mountGuard(dirty: boolean, holdRoute?: typeof leavesPath) {
  let latest: UnsavedChangesGuard | null = null;
  function Probe() {
    latest = useUnsavedChangesGuard(dirty, holdRoute === undefined ? {} : { holdRoute });
    return latest.routeHold;
  }
  const router = createMemoryRouter([{ path: '*', element: <Probe /> }], {
    initialEntries: ['/pipelines/p1'],
  });
  render(<RouterProvider router={router} />);
  return { router, guard: () => latest! };
}

describe('useUnsavedChangesGuard — holdRoute: leavesPath (#1396, the pipeline editor)', () => {
  it('holds a dirty page leaving for another path, and Keep stays put', async () => {
    const { router, guard } = mountGuard(true, leavesPath);
    await act(() => router.navigate('/pipelines'));
    expect(guard().confirming).toBe(true);
    expect(router.state.location.pathname).toBe('/pipelines/p1');

    act(() => guard().keep());
    expect(guard().confirming).toBe(false);
    expect(router.state.location.pathname).toBe('/pipelines/p1');
  });

  it('Discard carries on to the held destination', async () => {
    const { router, guard } = mountGuard(true, leavesPath);
    await act(() => router.navigate('/pipelines/p2'));
    expect(guard().confirming).toBe(true);
    act(() => guard().discard());
    await act(async () => {});
    expect(router.state.location.pathname).toBe('/pipelines/p2');
  });

  it('lets a same-path change (search, hash) through: the page and its draft stay mounted', async () => {
    const { router, guard } = mountGuard(true, leavesPath);
    await act(() => router.navigate('/pipelines/p1?tab=json#x'));
    expect(guard().confirming).toBe(false);
    expect(router.state.location.search).toBe('?tab=json');
  });

  it('never holds a clean page', async () => {
    const { router, guard } = mountGuard(false, leavesPath);
    await act(() => router.navigate('/pipelines'));
    expect(guard().confirming).toBe(false);
    expect(router.state.location.pathname).toBe('/pipelines');
  });
});

describe('useUnsavedChangesGuard — default hold (the resource forms)', () => {
  it('still holds every navigation, a same-path one included', async () => {
    const { router, guard } = mountGuard(true);
    await act(() => router.navigate('/pipelines/p1?tab=json'));
    expect(guard().confirming).toBe(true);
    expect(router.state.location.search).toBe('');
  });
});

describe('useUnsavedChangesGuard — a page that goes clean while asking', () => {
  it('drops the prompt and the held navigation (a save landed)', async () => {
    let latest: UnsavedChangesGuard | null = null;
    let setDirty: (dirty: boolean) => void = () => {};
    function Probe() {
      const [dirty, set] = useState(true);
      setDirty = set;
      latest = useUnsavedChangesGuard(dirty, { holdRoute: leavesPath });
      return latest.routeHold;
    }
    const router = createMemoryRouter([{ path: '*', element: <Probe /> }], {
      initialEntries: ['/pipelines/p1'],
    });
    render(<RouterProvider router={router} />);
    await act(() => router.navigate('/pipelines'));
    expect(latest!.confirming).toBe(true);

    act(() => setDirty(false));
    expect(latest!.confirming).toBe(false);
    expect(router.state.location.pathname).toBe('/pipelines/p1');
  });
});

describe('useUnsavedChangesGuard — holdRoute: false (#1476, a form inside the editor)', () => {
  it('registers no blocker, so the page guard beside it still holds the navigation', async () => {
    let page: UnsavedChangesGuard | null = null;
    let form: UnsavedChangesGuard | null = null;
    function Probe() {
      page = useUnsavedChangesGuard(true, { holdRoute: leavesPath });
      // Mounted AFTER the page's: the router consults only the newest blocker,
      // so a `useBlocker(false)` here would wave every navigation through.
      form = useUnsavedChangesGuard(true, { holdRoute: false });
      return (
        <>
          {page.routeHold}
          {form.routeHold}
        </>
      );
    }
    const router = createMemoryRouter([{ path: '*', element: <Probe /> }], {
      initialEntries: ['/pipelines/p1'],
    });
    render(<RouterProvider router={router} />);
    expect(form!.routeHold).toBeNull();
    await act(() => router.navigate('/pipelines'));
    expect(page!.confirming).toBe(true);
    expect(router.state.location.pathname).toBe('/pipelines/p1');
  });
});
