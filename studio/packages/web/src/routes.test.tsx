import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { LEGACY_REDIRECTS, ROUTES } from './routes';
import { HUBS } from './shell/hubs';
import { PANE_ELEMENT_ID } from './shell/SecondaryPane';
import { pipelinesStore } from './stores/pipelinesStore';
import { PANE_DEFAULT_WIDTH, uiStore } from './stores/uiStore';

// The pages behind these routes talk to the network / a WebSocket. Stub both so
// the route tree (the only thing under test here) resolves without real I/O.
// The run row is built INSIDE the factory: `vi.mock` is hoisted above every
// top-level binding, so a shared const would be in its temporal dead zone here.
// The Git page loads its connection on mount. Unmocked, `getWorkspaceGit`
// would reach a real `fetch` in jsdom — and the "every hub section renders"
// walk below mounts it for real, so this is load-bearing, not decoration.
// `null` is the honest default here: no repo connected.
vi.mock('./api/workspaceGit', async (importActual) => ({
  ...(await importActual<typeof import('./api/workspaceGit')>()),
  getWorkspaceGit: vi.fn().mockResolvedValue(null),
}));

vi.mock('./api/runs', async (importActual) => ({
  ...(await importActual<typeof import('./api/runs')>()),
  // #1083 — the paged envelope, not a bare array. `usePagedList` spreads
  // `page.items`, so a stale `[]` here throws inside the hook rather than
  // rendering an empty list.
  listRuns: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  getRunEvents: vi.fn().mockResolvedValue([]),
  // #1065 — the run detail page's diagnostics section loads on mount, so it
  // needs a resolved default here for the same reason as the rest of this
  // factory: unmocked it reaches a real `fetch` in jsdom.
  getRunDiagnostics: vi.fn().mockResolvedValue([]),
  // The run detail page reads R1 (`getRunDetail`), which resolves the run AND
  // the version doc its node overlay needs.
  getRunDetail: vi.fn((runId: string) =>
    Promise.resolve({
      pipelineVersion: {
        id: 'pv_1',
        nodes: [],
        edges: [],
        containers: [],
      },
      run: {
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
      },
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
// #1115 — the Datasets page loads on mount, and the walk over `HUBS` below
// mounts it for real, so this is load-bearing rather than decoration.
vi.mock('./api/datasets', async (importActual) => ({
  ...(await importActual<typeof import('./api/datasets')>()),
  listDatasets: vi.fn().mockResolvedValue([]),
  // #996 M9 — the detail page resolves both on mount. `getDataset` echoes the
  // id so the one-decode case below can read it off the rendered heading.
  getDataset: vi.fn((id: string) =>
    Promise.resolve({
      id,
      resourceId: 'res_ds',
      ownerId: 'local',
      name: id,
      kind: 'table',
      connectionId: 'conn_1',
      config: {},
      columns: [],
      parameters: [],
      createdAt: 1,
      updatedAt: 1,
    } as never),
  ),
  getDatasetReferences: vi.fn().mockResolvedValue({ references: [], dynamic: [] }),
}));
// This suite MOUNTS every hub section for real (see the walk over `HUBS`
// below), so a page that loads on mount reaches a real `fetch` in jsdom
// unless its api module is mocked here.
vi.mock('./api/workspaceAudit', async (importActual) => ({
  ...(await importActual<typeof import('./api/workspaceAudit')>()),
  fetchWorkspaceAuditPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
}));
vi.mock('./api/secrets', async (importActual) => ({
  ...(await importActual<typeof import('./api/secrets')>()),
  listSecrets: vi.fn().mockResolvedValue([]),
}));
vi.mock('./api/pipelines', async (importActual) => ({
  ...(await importActual<typeof import('./api/pipelines')>()),
  listPipelines: vi.fn().mockResolvedValue([]),
  listPipelineVersions: vi.fn().mockResolvedValue([]),
  getPipeline: vi.fn((id: string) =>
    Promise.resolve({
      id,
      resourceId: `res_${id}`,
      ownerId: 'local',
      name: `Pipeline ${id}`,
      concurrency: null,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
    }),
  ),
  // Same class as `getWorkspaceGit` above, missed when the canvas route gained
  // a publish state: mounting `PipelineCanvas` calls `readPublishState`, which
  // calls this. Unmocked it reached a real `fetch` under jsdom on every canvas
  // case, and `PipelineCanvas` swallows the rejection by design — so the only
  // symptom was an unexplained network attempt. `null` is honest rather than
  // convenient: nothing is published in this workspace.
  getActivePipelineVersion: vi.fn().mockResolvedValue(null),
}));
vi.mock('./api/triggers', async (importActual) => ({
  ...(await importActual<typeof import('./api/triggers')>()),
  listTriggers: vi.fn().mockResolvedValue([]),
}));

/**
 * #985 / #969 — warm the two `React.lazy` chunks BEFORE any case renders.
 *
 * The canvas heading assertion below was racing a cold dynamic `import()`.
 * `routes.tsx` pulls `PipelineCanvasRoute` from `PipelineCanvasRoute.lazy.ts`,
 * which is `lazy(() => import('./PipelineCanvasRoute.js'))`, and `AppShell`
 * renders the outlet under `<Suspense fallback={null}>`. So until that chunk
 * resolves, `<main class="content">` contains LITERALLY NOTHING.
 *
 * That empty `<main class="content" />` is exactly what #985 reported, and it
 * is what identifies the cause rather than merely being consistent with it: if
 * the mocked `getPipeline` were still pending, the route renders
 * `<p class="page-hint">Loading pipeline…</p>` (`PipelineCanvasRoute.tsx`), so
 * main would NOT be empty. The Suspense fallback is the only state in this
 * tree that paints an empty main, and the mock resolves on a microtask, so the
 * chunk is the only thing the 5s `asyncUtilTimeout` can actually be waiting on.
 *
 * The chunk is expensive: ~28k lines under `pages/pipeline/` plus
 * `@xyflow/react` + `@xyflow/system` (~4MB), transformed and evaluated per
 * fork. And the canvas case does not even pay it alone — the run-detail case
 * above it mounts `RunDetailPage`, which starts `RunGraph.lazy`'s import and
 * never awaits it, so the two compete. Both are warmed here for that reason;
 * they are the only two `React.lazy` modules in the app.
 *
 * MODULE SCOPE, deliberately NOT `beforeAll`. `packages/web/vitest.config.ts`
 * raises `testTimeout` to 20s but sets no `hookTimeout`, so hooks keep
 * vitest's 10s default — and #969 measured this very work at 10,389ms. Putting
 * it in a hook would swap one flaky TEST for a flaky FILE, since a hook
 * timeout fails every case in it. A top-level await runs during collection,
 * under no hook budget.
 *
 * Both specifiers resolve to the same absolute file as the ones the `.lazy`
 * wrappers use (`src/pages/author/PipelineCanvasRoute.tsx` and
 * `src/pages/runs/RunGraph.tsx`), and Vite keys its module registry by resolved
 * id, so this populates the same cache entry rather than a parallel one.
 *
 * WHAT THIS DOES NOT DO, stated because the obvious check misleads: it does not
 * make the test faster. Measured on an idle box, canvas case alone (`-t`), with
 * `node_modules/.vite` deleted first so the transform cache was genuinely cold:
 * 429ms with the pre-warm, 396ms without. On an idle machine the chunk load is
 * a small part of that case and pre-warming costs slightly more than it saves.
 *
 * The claim is about the BUDGET, not the speed. On an idle machine this import
 * is fast; #985's evidence is that under full-suite contention it exceeded 5s,
 * and the only reachable amplifier of that size is that web's forks share ONE
 * Vite transform server, which serialises when several forks demand this graph
 * at once — a condition a single-file run cannot reproduce, and it was not
 * reproduced here. Moving the wait to collection does not shorten it; it moves
 * it somewhere no deadline applies, so the assertion can no longer lose the
 * race however long it takes.
 */
await import('./pages/author/PipelineCanvasRoute.js');
await import('./pages/runs/RunGraph.js');

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

/**
 * The routed PAGE, excluding the shell chrome around it.
 *
 * Since U3 the command bar renders a breadcrumb, whose deepest crumb for a run
 * detail route is the run id — the same text the page shows. An unscoped
 * `findByText('run_42')` then matches two elements and THROWS, so every
 * id-in-the-page assertion below is scoped to the workspace.
 */
function page() {
  return within(screen.getByRole('main'));
}

/**
 * A router's initial matches, WITHOUT rendering.
 *
 * Rendering is not neutral here: RTL's `render` wraps in `act()`, which flushes
 * effects, so a `<Navigate>` redirect completes inside the call and
 * `router.state.matches` afterwards describes the DESTINATION. Reading the
 * router's own initial state is the only way to see which route a path actually
 * matched.
 */
function initialMatches(initialPath: string) {
  return createMemoryRouter(ROUTES, { initialEntries: [initialPath] }).state.matches;
}

beforeEach(() => {
  uiStore.getState().setThemeMode('dark');
  // Same hazard, second singleton: both Author surfaces read the list from
  // `pipelinesStore`, and `ROUTES` offers no injection seam for it. A case that
  // leaves it in `error` (or holding a list) would otherwise hand that state to
  // every later case in this file — `ensureFresh` skips a failed load, so the
  // leak would present as a silently missing fetch rather than as a failure.
  //
  // `beforeEach`, not `afterEach`: with vitest's default `sequence.hooks:'stack'`
  // an `afterEach` here runs BEFORE RTL's `cleanup()`, so it would write to a
  // store that still-mounted components are subscribed to — a React update
  // outside `act`.
  pipelinesStore.setState({ status: 'idle', pipelines: [], error: null });
});
afterEach(() => {
  vi.clearAllMocks();
  uiStore.getState().setThemeMode('dark');
  // The shell reads the pane slice from the SINGLETON, so a case that resizes
  // or collapses it would otherwise hand its state to the next one.
  uiStore.getState().setPaneWidth(PANE_DEFAULT_WIDTH);
  uiStore.getState().setPaneCollapsed(false);
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
    ['/manage/datasets', 'Datasets'],
    ['/manage/secrets', 'Secrets'],
    ['/manage/triggers', 'Triggers'],
    ['/manage/git', 'Git'],
  ])('renders %s', async (path, heading) => {
    renderAt(path);
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
  });

  it('renders the run detail page at /monitor/runs/:runId', async () => {
    renderAt('/monitor/runs/run_42');
    expect(await page().findByText('run_42')).toBeInTheDocument();
  });

  /**
   * U4 — the canvas has an address. Before it, the open pipeline was local
   * state inside `PipelinesPage`, so this path matched nothing and the
   * catch-all sent it to Home.
   */
  it('renders the canvas at /author/pipelines/:pipelineId', async () => {
    renderAt('/author/pipelines/pl_42');
    // The canvas heading is the pipeline's NAME, resolved by the route from
    // the server — proving the param reached a real fetch, not just a match.
    expect(await page().findByRole('heading', { name: 'Pipeline pl_42' })).toBeInTheDocument();
    // The publish-state mock is load-bearing, not decoration: without this the
    // mount would reach a real `fetch` under jsdom and nothing would say so,
    // because the caller swallows the rejection. Assert it was actually used.
    const getActivePipelineVersion = vi.mocked(
      (await import('./api/pipelines')).getActivePipelineVersion,
    );
    await waitFor(() =>
      expect(getActivePipelineVersion).toHaveBeenCalledWith('pl_42', expect.any(AbortSignal)),
    );
  });

  it('renders the dataset detail page at /manage/datasets/:datasetId', async () => {
    renderAt('/manage/datasets/ds_42');
    expect(await page().findByRole('heading', { name: 'ds_42' })).toBeInTheDocument();
  });

  /** Same one-decode contract as `:runId`; see the note on that case. */
  it('decodes :datasetId exactly once', async () => {
    renderAt(`/manage/datasets/${encodeURIComponent('ds%20x')}`);
    expect(await page().findByRole('heading', { name: 'ds%20x' })).toBeInTheDocument();
  });

  /** Same one-decode contract as `:runId`; see the note on that case. */
  it('decodes :pipelineId exactly once', async () => {
    renderAt(`/author/pipelines/${encodeURIComponent('pl%20x')}`);
    expect(await page().findByRole('heading', { name: 'Pipeline pl%20x' })).toBeInTheDocument();
  });

  /**
   * `/author/pipelines/` must be the LIST, not an empty-id canvas. Read from
   * the router's initial state rather than after `render()`: RTL flushes a
   * redirect inside `act()`, so a post-render read would describe wherever it
   * ended up — and `pipelines` is the name of the parent route either way.
   */
  it('matches a trailing slash as the pipelines index, not as a pipeline id', () => {
    const matched = initialMatches('/author/pipelines/').at(-1);
    expect(matched?.params).not.toHaveProperty('pipelineId');
  });

  /**
   * The canvas holds an UNSAVED graph per pipeline, and React Router reuses a
   * route component instance when only a param changes — so `key` is what stops
   * one pipeline's edits appearing under another's id. Proved through the load
   * error, the state a user would actually see leak.
   */
  it('remounts the canvas when the pipeline id changes', async () => {
    const getPipeline = vi.mocked((await import('./api/pipelines')).getPipeline);
    getPipeline.mockImplementation((id: string) =>
      id === 'pl_a'
        ? Promise.reject(new Error('pl_a exploded'))
        : Promise.resolve({ id, name: 'Pipeline B' } as never),
    );

    const router = createMemoryRouter(ROUTES, { initialEntries: ['/author/pipelines/pl_a'] });
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('pl_a exploded');

    await router.navigate('/author/pipelines/pl_b');

    expect(await page().findByRole('heading', { name: 'Pipeline B' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('pl_a exploded')).not.toBeInTheDocument());
  });

  /**
   * #761 — a failed list load must not outlive the failure it describes.
   *
   * This case lives HERE, against the real `ROUTES`, because the premise it rests
   * on is a fact about the SHELL: the pane renders beside the `<Outlet/>`, not
   * inside it, so it survives a navigation the routed page does not. A fixture
   * could reproduce that shape — a layout route with the pane in the parent
   * element — but then the shape being relied on is the fixture's rather than the
   * app's. Note the SIBLING-routes shape, which is what
   * `FactoryResources.test.tsx` already uses, would NOT do: it remounts the pane,
   * so a mount-time retry satisfies it and it cannot tell the fix from the bug.
   *
   * Navigation is driven through the router rather than by clicking, because a
   * failed FIRST load leaves the tree empty, so there is no row to click.
   */
  it('recovers a FAILED pipelines load when the route changes under the persistent pane', async () => {
    const listPipelines = vi.mocked((await import('./api/pipelines')).listPipelines);
    listPipelines.mockRejectedValueOnce(new Error('request failed (502)'));

    const router = createMemoryRouter(ROUTES, { initialEntries: ['/author/pipelines'] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(listPipelines).toHaveBeenCalledTimes(1));
    expect(await screen.findAllByText('request failed (502)')).not.toHaveLength(0);

    // Same hub, so the pane stays MOUNTED across this navigation — the whole
    // point of the case. The list page unmounts with the `<Outlet/>`, which is
    // why the banner assertion below is unambiguous afterwards.
    await router.navigate('/author/pipelines/pl_1');

    await waitFor(() => expect(listPipelines).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('request failed (502)')).not.toBeInTheDocument());
  });

  /**
   * #761 — and the SAME-PATH case, which is the one the bug report described
   * ("two client-side navigations to the same route did not clear it") and the
   * one a user hits first: after a failed FIRST load the tree is empty, so the
   * pane's group header — which points at the path already showing — is the only
   * link left to click.
   *
   * This is why the pane's effect is keyed on `location.key` rather than
   * `pathname`: a fresh history entry for the same path changes the former and
   * not the latter. Keyed on `pathname`, that click was inert and the pane stayed
   * broken with its most obvious affordance doing nothing.
   */
  it('recovers a FAILED pipelines load when re-navigating to the SAME path', async () => {
    const listPipelines = vi.mocked((await import('./api/pipelines')).listPipelines);
    listPipelines.mockRejectedValueOnce(new Error('request failed (502)'));

    const router = createMemoryRouter(ROUTES, { initialEntries: ['/author/pipelines'] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(listPipelines).toHaveBeenCalledTimes(1));
    expect(await screen.findAllByText('request failed (502)')).not.toHaveLength(0);

    await router.navigate('/author/pipelines');

    expect(router.state.location.pathname).toBe('/author/pipelines');
    await waitFor(() => expect(listPipelines).toHaveBeenCalledTimes(2));
  });

  /**
   * The other half of the guard: recovery is inert while the server is healthy,
   * so wiring it to every route entry does not turn navigation into request
   * volume. Without this, `retryIfFailed` could be `refresh` and #761's test
   * above would still pass.
   */
  it('does NOT refetch the pipelines list on navigation when the last load succeeded', async () => {
    const api = await import('./api/pipelines');
    const listPipelines = vi.mocked(api.listPipelines);
    /* Self-contained on purpose: the canvas case above installs a
       `getPipeline.mockImplementation`, and `vi.clearAllMocks()` clears CALLS but
       not implementations — so without this, `pl_1` resolves under that case's
       stub and this one's heading assertion depends on test order. */
    vi.mocked(api.getPipeline).mockImplementation((id: string) =>
      Promise.resolve({ id, name: `Pipeline ${id}` } as never),
    );

    const router = createMemoryRouter(ROUTES, { initialEntries: ['/author/pipelines'] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(listPipelines).toHaveBeenCalledTimes(1));

    await router.navigate('/author/pipelines/pl_1');
    await page().findByRole('heading', { name: 'Pipeline pl_1' });

    expect(listPipelines).toHaveBeenCalledTimes(1);
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
    expect(await page().findByText('run%20x')).toBeInTheDocument();
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
    const getRunDetail = vi.mocked((await import('./api/runs')).getRunDetail);
    getRunDetail.mockImplementation((runId: string) =>
      runId === 'run_a'
        ? Promise.reject(new Error('run_a exploded'))
        : Promise.resolve({
            run: { id: runId },
            pipelineVersion: { id: 'pv_1', nodes: [], edges: [], containers: [] },
          } as never),
    );

    const router = createMemoryRouter(ROUTES, { initialEntries: ['/monitor/runs/run_a'] });
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('run_a exploded');

    await router.navigate('/monitor/runs/run_b');

    expect(await page().findByText('run_b')).toBeInTheDocument();
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
    expect(await page().findByText('run_42')).toBeInTheDocument();
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
    expect(await page().findByText(id)).toBeInTheDocument();
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
   * legacy `runs` route — this react-router version strips a trailing slash when
   * matching, and a dynamic segment does not match empty.
   *
   * The matched route pattern is asserted, not just the landing path, because
   * `LegacyRunRedirect`'s empty-id guard also sends you to `/monitor/runs`:
   * both worlds produce the same destination, so a destination-only assertion
   * could not tell them apart and would pass whichever route matched.
   *
   * Read from `initialMatches` — i.e. BEFORE rendering. The first cut of this
   * test rendered and then read `router.state.matches`, which was vacuous:
   * `render` flushes the `<Navigate>` redirect inside `act()`, so it was
   * describing the DESTINATION route, which was also called `runs`. It would
   * have passed just as happily if `/runs/` had matched `:runId`. U3's route
   * restructure — `:runId` moving under `runs`, leaving an index route with no
   * `path` as the deepest destination match — is what exposed it.
   */
  it('matches a trailing-slash legacy path on the static route, not :runId', async () => {
    expect(initialMatches('/runs/').at(-1)?.route.path).toBe('runs');
    // ...and a real legacy id still takes the dynamic route, which is the other
    // half of the discrimination this test exists for.
    expect(initialMatches('/runs/run_42').at(-1)?.route.path).toBe('runs/:runId');

    expect(await landedAt('/runs/')).toBe('/monitor/runs');
  });

  /**
   * U3 nested `:runId` UNDER `runs` (it was a sibling) so the breadcrumb can
   * read Monitor › Runs › run_42 with a linkable middle crumb. The URLs are
   * meant to be byte-identical either way — this pins that they are, at the
   * matching level rather than only through a rendered page.
   */
  it('keeps the monitor run URLs unchanged by the nesting', () => {
    expect(initialMatches('/monitor/runs').map((m) => m.route.path)).toEqual([
      '/',
      'monitor',
      'runs',
      undefined,
    ]);
    expect(initialMatches('/monitor/runs/run_42').map((m) => m.route.path)).toEqual([
      '/',
      'monitor',
      'runs',
      ':runId',
    ]);
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

/**
 * U3 — the shell chrome, wired to the REAL route tree.
 *
 * `routeHandle.test.ts` covers the pure logic against hand-built matches, which
 * is a stub that agrees with itself. This half is the counterweight: the actual
 * `ROUTES`, mounted, producing an actual pane and breadcrumb.
 */
describe('shell chrome over the real route tree', () => {
  const trail = () => within(screen.getByRole('navigation', { name: 'Breadcrumb' }));

  it.each([
    ['/', ['Home']],
    ['/author/pipelines', ['Author', 'Pipelines']],
    ['/monitor/runs', ['Monitor', 'Runs']],
    ['/author/pipelines/pl_42', ['Author', 'Pipelines', 'pl_42']],
    ['/monitor/runs/run_42', ['Monitor', 'Runs', 'run_42']],
    ['/manage/connections', ['Manage', 'Connections']],
    ['/manage/datasets', ['Manage', 'Datasets']],
    ['/manage/secrets', ['Manage', 'Secrets']],
    ['/manage/triggers', ['Manage', 'Triggers']],
    ['/manage/git', ['Manage', 'Git']],
  ])('breadcrumbs %s as %j', async (path, expected) => {
    renderAt(path);
    await waitFor(() =>
      expect(
        trail()
          .getAllByRole('listitem')
          .map((li) => li.textContent),
      ).toEqual(expected),
    );
  });

  /**
   * The pane's presence is hub-driven: Home declares no sections, so it must
   * render no pane AT ALL rather than an empty box, and no toggle for it.
   */
  it('renders no pane and no pane toggle on Home', async () => {
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: /sections$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /navigation pane/i })).toBeNull();
  });

  it("renders the active hub's pane, with its sections", async () => {
    renderAt('/manage/triggers');
    const pane = await screen.findByRole('navigation', { name: 'Manage sections' });
    expect(
      within(pane)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Connections', 'Datasets', 'Secrets', 'Triggers', 'Git']);
    expect(screen.getByRole('separator')).toHaveAttribute('aria-controls', pane.id);
  });

  /**
   * Every section the pane offers must actually RENDER as a hub+section trail.
   *
   * Since section crumbs read their label from `HUBS` via `sectionLabel()`,
   * the two can no longer disagree — but that only removes the drift, not the
   * wiring risk: a section route that forgot its `handle` entirely, or sat
   * under the wrong hub, still produces the wrong trail. This walks the SSOT
   * and mounts each one for real.
   */
  it('gives every hub section a breadcrumb with the SAME label', async () => {
    for (const hub of HUBS) {
      for (const section of hub.sections) {
        renderAt(section.path);
        await waitFor(() =>
          expect(
            trail()
              .getAllByRole('listitem')
              .map((li) => li.textContent),
          ).toEqual([hub.label, section.label]),
        );
        screen.getByRole('navigation', { name: `${hub.label} sections` });
        cleanup();
      }
    }
  });

  /**
   * The pane's WIDTH mechanism, as far as jsdom can see it.
   *
   * `--pane-width` is an inline custom property, so it is readable here even
   * though jsdom resolves no `grid-template-columns`. What it is NOT is the
   * collapse mechanism: the shell's pane column is `auto`, sized by the pane
   * ELEMENT, so "no pane on this hub" and "the user collapsed it" both reclaim
   * their space by the element not being a grid item — not by any value
   * written here. That is why the width stays put across a collapse, and why
   * the reclaimed track is measured in `e2e/shell-pane.spec.ts` instead.
   */
  function paneWidthVar() {
    return document
      .querySelector<HTMLElement>('.app-shell')!
      .style.getPropertyValue('--pane-width');
  }

  it('publishes the stored width for the pane to consume', async () => {
    uiStore.getState().setPaneWidth(300);
    renderAt('/manage/connections');
    expect(await screen.findByRole('heading', { name: 'Connections' })).toBeInTheDocument();
    expect(paneWidthVar()).toBe('300px');
    expect(document.getElementById(PANE_ELEMENT_ID)).toBeVisible();
  });

  /** No pane ELEMENT at all — nothing to size, nothing to occupy the column. */
  it('renders no pane element on a hub with no pane', async () => {
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(document.getElementById(PANE_ELEMENT_ID)).toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('hides the pane and its splitter on collapse, keeping the width', async () => {
    const user = userEvent.setup();
    uiStore.getState().setPaneWidth(300);
    renderAt('/manage/connections');
    expect(await screen.findByRole('heading', { name: 'Connections' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hide navigation pane' }));
    // `display: none` takes it out of the grid, which is what frees the column.
    expect(document.getElementById(PANE_ELEMENT_ID)).not.toBeVisible();
    // The splitter goes with it: a resize handle for a pane that is not on
    // screen is a focusable control with nothing to do.
    expect(screen.queryByRole('separator')).toBeNull();
    // The width is REMEMBERED, not zeroed — that is what expanding restores.
    expect(paneWidthVar()).toBe('300px');

    await user.click(screen.getByRole('button', { name: 'Show navigation pane' }));
    expect(document.getElementById(PANE_ELEMENT_ID)).toBeVisible();
    expect(paneWidthVar()).toBe('300px');
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });

  /**
   * Collapsing while focus is INSIDE the pane must not strand it on a hidden
   * element — Tab would then restart from the top of the document. Focus goes
   * to the control that caused the collapse.
   *
   * Driven with a direct `.focus()` + `fireEvent.click`, not `userEvent.click`:
   * a real Chromium click focuses the button first, which would mask the bug.
   * Safari does not, which is the browser this guard exists for.
   */
  it('returns focus to the toggle when collapsing from inside the pane', async () => {
    renderAt('/manage/connections');
    expect(await screen.findByRole('heading', { name: 'Connections' })).toBeInTheDocument();

    const triggersLink = screen.getByRole('link', { name: 'Triggers' });
    triggersLink.focus();
    expect(triggersLink).toHaveFocus();

    const toggle = screen.getByRole('button', { name: 'Hide navigation pane' });
    fireEvent.click(toggle);

    expect(screen.getByRole('button', { name: 'Show navigation pane' })).toHaveFocus();
  });

  /**
   * `sections[0]` is documented as the hub's landing page, and the route tree's
   * index redirect is a separate literal. Two literals that must agree is
   * exactly the drift the rail-vs-routes test above already guards for hubs —
   * this is the same guard one level down. Without it the pane's first entry
   * could quietly stop being the page the rail takes you to.
   */
  it('lands each hub on its own first section', async () => {
    for (const hub of HUBS.filter((h) => h.sections.length > 0)) {
      expect(await landedAt(hub.path)).toBe(hub.sections[0]!.path);
      cleanup();
    }
  });
});
