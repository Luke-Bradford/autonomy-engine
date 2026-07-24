import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { LEGACY_REDIRECTS, ROUTES } from './routes';
import { HUBS } from './shell/hubs';
import { uiStore } from './stores/uiStore';

// The pages behind these routes talk to the network / a WebSocket. Stub both so
// the route tree (the only thing under test here) resolves without real I/O.
// The run row is built INSIDE the factory: `vi.mock` is hoisted above every
// top-level binding, so a shared const would be in its temporal dead zone here.
vi.mock('./api/runs', async (importActual) => ({
  ...(await importActual<typeof import('./api/runs')>()),
  listRuns: vi.fn().mockResolvedValue([]),
  getRunEvents: vi.fn().mockResolvedValue([]),
  getRun: vi.fn((runId: string) =>
    Promise.resolve({
      id: runId,
      ownerId: 'local',
      pipelineVersionId: 'pv_1',
      triggerId: null,
      parentRunId: null,
      params: {},
      status: 'running',
      leaseUntil: null,
      heartbeatAt: null,
      queuedAt: null,
      triggerContext: null,
      rerunOf: null,
      startedAt: 1,
      finishedAt: null,
    }),
  ),
}));
vi.mock('./pages/runs/useRunStream', async (importActual) => ({
  ...(await importActual<typeof import('./pages/runs/useRunStream')>()),
  useRunStream: vi.fn().mockReturnValue({ events: [], phase: 'connecting', error: undefined }),
}));
vi.mock('./api/connections', async (importActual) => ({
  ...(await importActual<typeof import('./api/connections')>()),
  listConnections: vi.fn().mockResolvedValue([]),
}));
vi.mock('./api/pipelines', async (importActual) => ({
  ...(await importActual<typeof import('./api/pipelines')>()),
  listPipelines: vi.fn().mockResolvedValue([]),
  listPipelineVersions: vi.fn().mockResolvedValue([]),
}));
vi.mock('./api/triggers', async (importActual) => ({
  ...(await importActual<typeof import('./api/triggers')>()),
  listTriggers: vi.fn().mockResolvedValue([]),
}));

/** Mount the REAL route tree at a path, exactly as the hash router would. */
function renderAt(initialPath: string) {
  const router = createMemoryRouter(ROUTES, { initialEntries: [initialPath] });
  const view = render(<RouterProvider router={router} />);
  return { router, ...view };
}

/** Wait for a redirecting route to settle, then report where it landed. */
async function landedAt(initialPath: string): Promise<string> {
  const { router } = renderAt(initialPath);
  await waitFor(() => expect(router.state.location.pathname).not.toBe(initialPath));
  return router.state.location.pathname;
}

beforeEach(() => {
  uiStore.getState().setThemeMode('dark');
});
afterEach(() => {
  vi.clearAllMocks();
  uiStore.getState().setThemeMode('dark');
});

describe('route tree', () => {
  it('renders the Home hub at /', async () => {
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
  });

  it.each([
    ['/author', '/author/pipelines'],
    ['/monitor', '/monitor/runs'],
    ['/manage', '/manage/connections'],
  ])('redirects the %s hub index to its default child %s', async (from, to) => {
    expect(await landedAt(from)).toBe(to);
  });

  /**
   * A hub index that redirected by PUSHING would trap the user: Back from the
   * default child returns to the index, which immediately bounces forward again.
   * Asserting the history depth is the only way to see the difference.
   */
  it('redirects hub indexes by REPLACE, so Back is not a trap', async () => {
    const router = createMemoryRouter(ROUTES, { initialEntries: ['/', '/monitor'] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(router.state.location.pathname).toBe('/monitor/runs'));

    await router.navigate(-1);
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it.each([
    ['/author/pipelines', 'Pipelines'],
    ['/monitor/runs', 'Runs'],
    ['/manage/connections', 'Connections'],
    ['/manage/triggers', 'Triggers'],
  ])('renders %s', async (path, heading) => {
    renderAt(path);
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
  });

  it('renders the run detail page at /monitor/runs/:runId', async () => {
    renderAt('/monitor/runs/run_42');
    expect(await screen.findByText('run_42')).toBeInTheDocument();
  });

  /**
   * `useParams` returns params ALREADY decoded. The pre-U2 router sliced the raw
   * hash and called `decodeURIComponent` by hand; carrying that call into the
   * route wrapper would decode TWICE.
   *
   * The id here is chosen to make that difference visible. A plain id, or even
   * `run x`, is idempotent under a second decode and would let the bug through.
   * `run%20x` — an id whose own characters include a percent escape — encodes to
   * `run%2520x`; one decode restores `run%20x`, a second would collapse it to
   * `run x`. Verified against this react-router version rather than assumed.
   *
   * (Real ids are `run_` + a nanoid, whose alphabet is `A-Za-z0-9_-`, so nothing
   * in production needs escaping at all. This guards the wrapper's contract, not
   * a live hazard.)
   */
  it('decodes :runId exactly once', async () => {
    renderAt(`/monitor/runs/${encodeURIComponent('run%20x')}`);
    expect(await screen.findByText('run%20x')).toBeInTheDocument();
  });

  /**
   * React Router REUSES a route's component instance when only a param
   * changes, so `RunDetailRoute` renders the page with `key={runId}` to force a
   * remount. Without it the previous run's state stays mounted under the new
   * id — proved here with the load error, which is the state a user would
   * actually see leak: run_a fails, run_b succeeds, and a non-remounted page
   * would still be showing run_a's error alongside run_b's data.
   */
  it('remounts the run detail page when the run id changes', async () => {
    const getRun = vi.mocked((await import('./api/runs')).getRun);
    getRun.mockImplementation((runId: string) =>
      runId === 'run_a'
        ? Promise.reject(new Error('run_a exploded'))
        : Promise.resolve({ id: runId } as never),
    );

    const router = createMemoryRouter(ROUTES, { initialEntries: ['/monitor/runs/run_a'] });
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('run_a exploded');

    await router.navigate('/monitor/runs/run_b');

    expect(await screen.findByText('run_b')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('run_a exploded')).not.toBeInTheDocument());
  });

  it('sends an unknown path to Home', async () => {
    expect(await landedAt('/nope/not/a/route')).toBe('/');
  });

  /**
   * U3r — route compatibility for the MVP's pre-hub paths.
   *
   * The expected pairs are written out here rather than derived from
   * `LEGACY_REDIRECTS`, in the same spirit as the e2e specs' hard-coded hub
   * list: a test that maps over the very table it is checking agrees with
   * itself no matter what the table says. The completeness case below then
   * pins the two together, so a redirect added to the SSOT cannot slip through
   * untested.
   *
   * Each case asserts the landing path AND that the destination actually
   * RENDERED its page. Path-only would pass if the target route were deleted
   * (the catch-all would quietly absorb it); render-only would pass if the
   * redirect went to the right page by the wrong path.
   */
  const LEGACY_CASES = [
    ['/connections', '/manage/connections', 'Connections'],
    ['/pipelines', '/author/pipelines', 'Pipelines'],
    ['/triggers', '/manage/triggers', 'Triggers'],
    ['/runs', '/monitor/runs', 'Runs'],
  ] as const;

  it.each(LEGACY_CASES)('redirects the legacy path %s to %s', async (from, to, heading) => {
    const { router } = renderAt(from);
    await waitFor(() => expect(router.state.location.pathname).toBe(to));
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
  });

  /** Every redirect declared in the SSOT is covered by a case above. */
  it('exercises every legacy redirect the route tree declares', () => {
    expect(LEGACY_REDIRECTS.map((r) => `${r.from} -> ${r.to}`).sort()).toEqual(
      LEGACY_CASES.map(([from, to]) => `${from} -> ${to}`).sort(),
    );
  });

  /**
   * The sharp case the catch-all got wrong: an old `#/runs/:id` bookmark must
   * reach THAT run, not Home. Both halves are asserted — the id has to survive
   * into the path and out the other side into the page.
   */
  it('redirects a legacy run-detail path, keeping the run id', async () => {
    const { router } = renderAt('/runs/run_42');
    await waitFor(() => expect(router.state.location.pathname).toBe('/monitor/runs/run_42'));
    expect(await screen.findByText('run_42')).toBeInTheDocument();
  });

  /**
   * The redirect re-ENCODES the id on its way out.
   *
   * `useParams` hands back a decoded id, and react-router does not re-encode a
   * string `to`, so interpolating the raw param would ship a half-decoded path
   * that the destination then decodes a SECOND time. `run%20x` makes that
   * visible: it encodes to `run%2520x`, one decode restores `run%20x`, and a
   * second would collapse it to `run x`. A plain id would be idempotent under
   * the extra decode and let the bug through.
   */
  it('re-encodes the run id exactly once on the way through', async () => {
    const id = 'run%20x';
    const { router } = renderAt(`/runs/${encodeURIComponent(id)}`);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/monitor/runs/${encodeURIComponent(id)}`),
    );
    expect(await screen.findByText(id)).toBeInTheDocument();
  });

  /**
   * Same history-trap reasoning as the hub indexes: a legacy path that PUSHED
   * its redirect would leave the dead URL sitting in history, so Back from the
   * new path returns to it and is bounced straight forward again.
   */
  it('redirects legacy paths by REPLACE, so Back is not a trap', async () => {
    const router = createMemoryRouter(ROUTES, { initialEntries: ['/', '/runs'] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(router.state.location.pathname).toBe('/monitor/runs'));

    await router.navigate(-1);
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  /**
   * `/runs/` must reach the runs list, and must do so by matching the STATIC
   * `runs` route — this react-router version strips a trailing slash when
   * matching, and a dynamic segment does not match empty.
   *
   * The matched route pattern is asserted, not just the landing path, because
   * `LegacyRunRedirect`'s empty-id guard also sends you to `/monitor/runs`:
   * both worlds produce the same destination, so a destination-only assertion
   * could not tell them apart and would pass whichever route matched.
   */
  it('matches a trailing-slash legacy path on the static route, not :runId', async () => {
    const router = createMemoryRouter(ROUTES, { initialEntries: ['/runs/'] });
    render(<RouterProvider router={router} />);

    const matched = router.state.matches.at(-1)?.route.path;
    expect(matched).toBe('runs');

    await waitFor(() => expect(router.state.location.pathname).toBe('/monitor/runs'));
  });

  /**
   * The rail renders from `HUBS` and the routes are declared separately, so the
   * two can drift into a dead rail link. Every hub path must resolve to a real
   * route (either directly, or via its index redirect) — never the catch-all.
   */
  it('every hub in the rail SSOT resolves to a real route', async () => {
    for (const hub of HUBS) {
      const router = createMemoryRouter(ROUTES, { initialEntries: [hub.path] });
      render(<RouterProvider router={router} />);
      await waitFor(() => expect(router.state.navigation.state).toBe('idle'));
      // Home resolves to itself; the others must reach their own subtree.
      const landed = router.state.location.pathname;
      expect(landed === hub.path || landed.startsWith(`${hub.path}/`)).toBe(true);
    }
  });
});
