import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { renderWithRouter } from '../../testing/renderWithRouter';
import { ROUTES } from '../../routes';
import userEvent from '@testing-library/user-event';
import { RunStatusSchema, type RunSummary } from '@autonomy-studio/shared';
import { RunsPage } from './RunsPage';
import { runStatusLabel } from './runStatus';
import * as runsApi from '../../api/runs';
import * as triggersApi from '../../api/triggers';
import { createPipelinesStore } from '../../stores/pipelinesStore';

// Mock the whole api/runs network surface (matching the ConnectionsPage test
// convention of stubbing every network fn of the module, so no real call ever
// escapes to a partially-mocked module).
vi.mock('../../api/runs', async (importActual) => ({
  ...(await importActual<typeof import('../../api/runs')>()),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  getRunEvents: vi.fn(),
}));

// U26's pickers each reach the network. Triggers get the same whole-module stub
// the runs API gets; pipelines come in through the store seam below instead, so
// the page is exercised against the REAL store with an injected fetch.
vi.mock('../../api/triggers', async (importActual) => ({
  ...(await importActual<typeof import('../../api/triggers')>()),
  listTriggers: vi.fn(),
}));

const listMock = vi.mocked(runsApi.listRuns);
const triggersMock = vi.mocked(triggersApi.listTriggers);

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: 'run_1',
    ownerId: 'local',
    pipelineVersionId: 'pv_1',
    triggerId: 'trg_1',
    parentRunId: null,
    params: {},
    status: 'running',
    leaseUntil: null,
    heartbeatAt: null,
    queuedAt: null,
    triggerContext: null,
    rerunOf: null,
    startedAt: 1_700_000_000_000,
    finishedAt: null,
    // R2 — the joined names the list renders.
    pipelineName: 'Nightly report',
    pipelineVersion: 3,
    triggerName: 'Every morning',
    ...overrides,
  };
}

beforeEach(() => {
  listMock.mockResolvedValue([]);
  triggersMock.mockResolvedValue([]);
  vi.mocked(runsApi.getRun).mockResolvedValue({} as never);
  vi.mocked(runsApi.getRunEvents).mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe('RunsPage', () => {
  it('shows the empty state after loading', async () => {
    renderWithRouter(<RunsPage />);
    expect(await screen.findByText(/No runs yet/i)).toBeInTheDocument();
  });

  it('renders a run row with its status', async () => {
    listMock.mockResolvedValue([run({ id: 'run_abc', status: 'success' })]);
    renderWithRouter(<RunsPage />);
    expect(await screen.findByText('run_abc')).toBeInTheDocument();
    // Scoped to the TABLE, not the page: U26's status picker offers the same
    // words as options, so a bare page-wide `getByText('success')` now matches
    // the filter control too and would pass with the status CELL deleted.
    expect(within(screen.getByRole('table')).getByText('success')).toBeInTheDocument();
  });

  /**
   * Mounted on the app's REAL `ROUTES`, not a stub tree written here. A stub
   * would only prove this page agrees with itself: rename the actual route to
   * `/monitor/run/:runId` and a hand-written `/monitor/runs/:runId` stub still
   * matches, still renders, still passes. Against `ROUTES`, a moved route
   * fails — which is the whole risk this ticket carries, since every path in
   * the app was rewritten.
   */
  it('Watch navigates to the run detail route', async () => {
    listMock.mockResolvedValue([run({ id: 'run_abc' })]);
    vi.mocked(runsApi.getRun).mockResolvedValue({ id: 'run_abc' } as never);
    const router = createMemoryRouter(ROUTES, { initialEntries: ['/monitor/runs'] });
    render(<RouterProvider router={router} />);

    await userEvent.click(await screen.findByLabelText('Watch run run_abc'));

    // The run detail page renders the id in its heading.
    expect(await screen.findByRole('heading', { name: /run_abc/ })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/monitor/runs/run_abc');
  });

  /**
   * #870 — the list speaks the Monitor's ONE run-status vocabulary.
   *
   * Enumerated from `RunStatusSchema` rather than from a list written here, so
   * a ninth DB status cannot be added and rendered as a bare identifier without
   * this failing — the guard is the module boundary, not any one word.
   */
  it('words every run status through the shared vocabulary', async () => {
    listMock.mockResolvedValue(
      RunStatusSchema.options.map((status, i) => run({ id: `run_${i}`, status })),
    );
    renderWithRouter(<RunsPage />);
    await screen.findByText('run_0');
    // Table-scoped for the same reason as above — the picker speaks the same
    // vocabulary, and this test is about the CELLS.
    const table = within(screen.getByRole('table'));
    for (const status of RunStatusSchema.options) {
      expect(table.getByText(runStatusLabel(status)), `no cell for ${status}`).toBeInTheDocument();
    }
    expect(table.getByText('queued (slot)')).toBeInTheDocument();
  });

  /**
   * The list reads the DB row, which has no park-reason column — so a parked
   * run reads a BARE `waiting` here while the detail page says
   * `waiting (timer)`. Pinned deliberately: one surface knowing more than
   * another is fine; this test is what stops someone "fixing" the asymmetry by
   * inventing a reason the row does not carry.
   */
  it('shows a parked run as a bare `waiting` — the row carries no reason', async () => {
    listMock.mockResolvedValue([run({ id: 'run_parked', status: 'waiting' })]);
    renderWithRouter(<RunsPage />);
    await screen.findByText('run_parked');
    expect(within(screen.getByRole('table')).getByText('waiting')).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    listMock.mockRejectedValue(new Error('nope'));
    renderWithRouter(<RunsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
  });

  /**
   * R2 — the identity column. The list used to render `pipelineVersionId` raw,
   * so every row read `pv_…` and an operator with two pipelines could not tell
   * their runs apart. Asserting the id is ABSENT as text is the half that
   * matters: rendering the name *beside* the opaque id would pass a
   * name-only check while leaving the column just as unreadable.
   */
  it('names the pipeline and its version instead of the raw version id', async () => {
    listMock.mockResolvedValue([
      run({ id: 'run_abc', pipelineVersionId: 'pv_opaque', pipelineName: 'Nightly report' }),
    ]);
    renderWithRouter(<RunsPage />);
    expect(await screen.findByText(/Nightly report/)).toBeInTheDocument();
    expect(screen.getByText('v3')).toBeInTheDocument();
    expect(screen.queryByText('pv_opaque')).not.toBeInTheDocument();
    // Not lost, just demoted: the opaque key stays reachable as the cell title.
    expect(screen.getByTitle('pv_opaque')).toBeInTheDocument();
  });

  it('names the trigger, and em-dashes a run that has none', async () => {
    listMock.mockResolvedValue([
      run({ id: 'run_t', triggerName: 'Every morning' }),
      run({ id: 'run_m', triggerId: null, triggerName: null }),
    ]);
    renderWithRouter(<RunsPage />);
    expect(await screen.findByText('Every morning')).toBeInTheDocument();
    // Scoped to the trigger-less run's own TRIGGER cell: an unscoped `—` search
    // would also match the Duration column, and pass even if the trigger cell
    // rendered nothing at all.
    const manualRow = screen.getByRole('row', { name: /run_m/ });
    expect(within(manualRow).getAllByRole('cell')[2]).toHaveTextContent('—');
  });

  it('renders a finished run duration, and marks an unfinished one "so far"', async () => {
    listMock.mockResolvedValue([
      run({ id: 'run_done', status: 'success', startedAt: 1_000, finishedAt: 8_000 }),
      run({ id: 'run_live', status: 'running', startedAt: 1_000, finishedAt: null }),
    ]);
    vi.spyOn(Date, 'now').mockReturnValue(4_000);
    renderWithRouter(<RunsPage />);
    await screen.findByText('run_done');
    expect(screen.getByText('7s')).toBeInTheDocument();
    expect(screen.getByText('3s so far')).toBeInTheDocument();
  });

  /**
   * U10 — the origin tabs. Every tab is asserted, because the risk is a tab
   * that renders but filters nothing: a no-op filter would still show the
   * triggered run under "Triggered" and pass a single-tab check.
   */
  it('filters the list by run origin, and marks the selected tab', async () => {
    listMock.mockResolvedValue([
      run({ id: 'run_trig', triggerId: 'trg_1', parentRunId: null }),
      run({ id: 'run_manual', triggerId: null, parentRunId: null, triggerName: null }),
      run({ id: 'run_child', triggerId: null, parentRunId: 'run_trig', triggerName: null }),
    ]);
    renderWithRouter(<RunsPage />);
    await screen.findByText('run_trig');

    await userEvent.click(screen.getByRole('tab', { name: /Triggered/ }));
    expect(screen.getByText('run_trig')).toBeInTheDocument();
    expect(screen.queryByText('run_manual')).not.toBeInTheDocument();
    expect(screen.queryByText('run_child')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Triggered/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'false');

    await userEvent.click(screen.getByRole('tab', { name: /Manual/ }));
    expect(screen.getByText('run_manual')).toBeInTheDocument();
    expect(screen.queryByText('run_trig')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /Child/ }));
    expect(screen.getByText('run_child')).toBeInTheDocument();
    expect(screen.queryByText('run_manual')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /^All/ }));
    expect(screen.getByText('run_trig')).toBeInTheDocument();
    expect(screen.getByText('run_manual')).toBeInTheDocument();
    expect(screen.getByText('run_child')).toBeInTheDocument();
  });

  it('counts each tab with the same filter the table applies', async () => {
    listMock.mockResolvedValue([
      run({ id: 'run_trig', triggerId: 'trg_1', parentRunId: null }),
      run({ id: 'run_trig2', triggerId: 'trg_1', parentRunId: null }),
      run({ id: 'run_child', triggerId: null, parentRunId: 'run_trig', triggerName: null }),
    ]);
    renderWithRouter(<RunsPage />);
    await screen.findByText('run_trig');
    expect(screen.getByRole('tab', { name: /^All/ })).toHaveTextContent('3');
    expect(screen.getByRole('tab', { name: /Triggered/ })).toHaveTextContent('2');
    expect(screen.getByRole('tab', { name: /Child/ })).toHaveTextContent('1');
    expect(screen.getByRole('tab', { name: /Manual/ })).toHaveTextContent('0');
  });

  it('says so when a tab has no runs, rather than showing an empty table', async () => {
    listMock.mockResolvedValue([run({ id: 'run_trig', triggerId: 'trg_1' })]);
    renderWithRouter(<RunsPage />);
    await screen.findByText('run_trig');
    await userEvent.click(screen.getByRole('tab', { name: /Manual/ }));
    expect(screen.getByText(/No manual runs/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  /**
   * U10 — the filter tab is a URL slot the Shell section names as this ticket's
   * ("monitor filter tab (U10)"). Read FROM the url on first paint: a link to a
   * filtered view has to arrive filtered, not flash All and then correct itself.
   */
  it('takes the selected tab from the URL', async () => {
    listMock.mockResolvedValue([
      run({ id: 'run_trig', triggerId: 'trg_1', parentRunId: null }),
      run({ id: 'run_manual', triggerId: null, parentRunId: null, triggerName: null }),
    ]);
    renderWithRouter(<RunsPage />, '/monitor/runs?tab=manual');
    expect(await screen.findByText('run_manual')).toBeInTheDocument();
    expect(screen.queryByText('run_trig')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Manual/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('falls back to All on an unrecognised ?tab, rather than showing nothing', async () => {
    listMock.mockResolvedValue([run({ id: 'run_trig', triggerId: 'trg_1' })]);
    renderWithRouter(<RunsPage />, '/monitor/runs?tab=not-a-tab');
    expect(await screen.findByText('run_trig')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true');
  });

  /**
   * And WRITTEN back, so the filtered view is linkable and Back undoes it. `all`
   * is expressed by the param's ABSENCE — one canonical URL per view.
   */
  it('writes the selected tab to the URL, and clears it for All', async () => {
    listMock.mockResolvedValue([run({ id: 'run_trig', triggerId: 'trg_1' })]);
    const router = createMemoryRouter(ROUTES, { initialEntries: ['/monitor/runs'] });
    render(<RouterProvider router={router} />);
    await screen.findByText('run_trig');

    await userEvent.click(screen.getByRole('tab', { name: /Triggered/ }));
    expect(router.state.location.search).toBe('?tab=triggered');

    await userEvent.click(screen.getByRole('tab', { name: /^All/ }));
    expect(router.state.location.search).toBe('');
  });

  /**
   * U10 owns turning the row action into a REAL link (the Shell section says so
   * explicitly). An anchor with an href is hoverable, copyable and
   * middle-clickable; the `useNavigate()` button it replaced was none of those.
   */
  it('renders the row action as a link with a real href', async () => {
    listMock.mockResolvedValue([run({ id: 'run_abc' })]);
    renderWithRouter(<RunsPage />);
    const link = await screen.findByRole('link', { name: 'Watch run run_abc' });
    expect(link).toHaveAttribute('href', expect.stringContaining('run_abc') as unknown as string);
  });
});

/**
 * U26 — the Monitor filter pane.
 *
 * The axes are SERVER-side, so what this file owns is the contract between the
 * controls and the request: which query the page asks for, what it writes to the
 * URL, and what it says when the answer is empty. WHICH rows each axis selects
 * is the repo/route suite's, and is not re-asserted here through a mock.
 */
describe('RunsPage — U26 filter pane', () => {
  function pipeline(id: string, name: string) {
    return { id, ownerId: 'local', name, archivedAt: null, createdAt: 0, updatedAt: 0 };
  }
  function storeWith(...list: ReturnType<typeof pipeline>[]) {
    return createPipelinesStore(() => Promise.resolve(list as never));
  }

  it('sends no filter params at all when nothing is selected', async () => {
    renderWithRouter(<RunsPage store={storeWith()} />);
    await screen.findByText(/No runs yet/i);
    expect(listMock).toHaveBeenCalledWith({}, expect.anything());
  });

  it('reads every axis out of the URL and asks the SERVER for it', async () => {
    renderWithRouter(
      <RunsPage store={storeWith(pipeline('pl_1', 'Reports'))} />,
      '/monitor/runs?status=failure&pipeline=pl_1&trigger=trg_1&since=24h',
    );
    await screen.findByText(/No runs match these filters/i);
    expect(listMock).toHaveBeenCalledWith(
      { status: 'failure', pipelineId: 'pl_1', triggerId: 'trg_1', since: '24h' },
      expect.anything(),
    );
  });

  it('writes a chosen status to the URL and refetches with it', async () => {
    renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs');
    await screen.findByText(/No runs yet/i);
    listMock.mockClear();

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'failure');

    expect(listMock).toHaveBeenCalledWith({ status: 'failure' }, expect.anything());
    expect(await screen.findByText(/No runs match these filters/i)).toBeInTheDocument();
  });

  /**
   * The graceful-degradation rule. The SERVER refuses an out-of-vocabulary
   * `?status=` with a 400, which is right for an API — but a stale link must not
   * land the operator on an error page, so the page drops what it cannot
   * recognise and shows the unfiltered view.
   */
  it('ignores an unrecognised status/window rather than sending or erroring on it', async () => {
    renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs?status=nope&since=forever');
    await screen.findByText(/No runs yet/i);
    expect(listMock).toHaveBeenCalledWith({}, expect.anything());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  /**
   * The orphan-select guard. A `<select>` whose value matches no option renders
   * the FIRST one, so without this the control would read "All pipelines" while
   * the list stayed filtered — the control lying about what is applied.
   */
  it('shows a filtered-but-unknown pipeline as a disabled option, not as "All pipelines"', async () => {
    renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs?pipeline=pl_gone');
    await screen.findByText(/No runs match these filters/i);
    const select = screen.getByLabelText<HTMLSelectElement>('Pipeline');
    expect(select.value).toBe('pl_gone');
    expect(screen.getByRole('option', { name: /pl_gone/ })).toBeDisabled();
  });

  /**
   * The filter pane must survive its own emptiness — if it rendered only when
   * rows exist, the control that clears the filter would vanish exactly when it
   * is needed, leaving the URL as the only way out.
   */
  it('keeps the pane reachable when the filter matches nothing, and Clear restores the list', async () => {
    listMock.mockResolvedValue([]);
    renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs?status=failure');
    await screen.findByText(/No runs match these filters/i);

    listMock.mockResolvedValue([run({ id: 'run_back' })]);
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(await screen.findByText('run_back')).toBeInTheDocument();
    expect(listMock).toHaveBeenLastCalledWith({}, expect.anything());
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  /**
   * The rows on screen were fetched under the PREVIOUS filter. Leaving them up
   * while the new request is in flight shows a list that contradicts the
   * controls right above it — briefly, but long enough to be read as the answer,
   * which for a status filter means reading a success as a failure.
   */
  it("never shows the previous filter's rows under the new filter", async () => {
    listMock.mockResolvedValue([run({ id: 'run_old' })]);
    renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs');
    expect(await screen.findByText('run_old')).toBeInTheDocument();

    // A request that never settles: the page is now mid-flight on the new
    // filter, which is exactly the window this guards.
    listMock.mockReturnValue(new Promise(() => {}));
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'failure');

    expect(screen.queryByText('run_old')).not.toBeInTheDocument();
    expect(screen.getByText(/Loading runs/i)).toBeInTheDocument();
  });

  /**
   * The other half of the same rule: a Refresh asks the SAME question again, so
   * blanking the list to re-answer it identically would be a flash for nothing.
   */
  it('keeps the current rows on screen while a Refresh of the same filter is in flight', async () => {
    listMock.mockResolvedValue([run({ id: 'run_here' })]);
    renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs?status=failure');
    expect(await screen.findByText('run_here')).toBeInTheDocument();

    listMock.mockReturnValue(new Promise(() => {}));
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(screen.getByText('run_here')).toBeInTheDocument();
  });

  /**
   * `filterKey` settles which QUESTION an answer belongs to, but two loads can
   * share a key — a double-Refresh — and abort does not fully cover them: a
   * request whose response has already arrived can still resolve after the
   * controller aborts. Without a sequence guard the OLDER answer wins on
   * completion order, so the list silently reverts to a stale snapshot.
   */
  it('drops a superseded load that resolves LATE under the same filter', async () => {
    let resolveFirst: (rows: RunSummary[]) => void = () => {};
    listMock.mockReturnValueOnce(
      new Promise<RunSummary[]>((resolve) => {
        resolveFirst = resolve;
      }),
    );
    renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs');
    await screen.findByText(/Loading runs/i);

    // A second load of the SAME filter, which answers first.
    listMock.mockResolvedValue([run({ id: 'run_fresh' })]);
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('run_fresh')).toBeInTheDocument();

    // Now the abandoned first load finally answers. It must be dropped.
    // `act` is what makes this test able to FAIL: without flushing React's
    // update queue the assertion runs before any re-render, so a stale row that
    // WAS applied would still not be in the DOM yet and the test would pass
    // against a missing guard.
    await act(async () => {
      resolveFirst([run({ id: 'run_stale' })]);
    });
    expect(screen.queryByText('run_stale')).not.toBeInTheDocument();
    expect(screen.getByText('run_fresh')).toBeInTheDocument();
  });

  it('does not offer Clear when nothing is filtered', async () => {
    renderWithRouter(<RunsPage store={storeWith()} />);
    await screen.findByText(/No runs yet/i);
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  /**
   * "You have no runs" and "none match" call for different things — the Triggers
   * page versus the Clear control — so saying the first when the second is true
   * is not just imprecise, it points the operator at the wrong fix.
   */
  it('distinguishes "no runs at all" from "none match these filters"', async () => {
    const { unmount } = renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs');
    expect(await screen.findByText(/No runs yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/No runs match these filters/i)).not.toBeInTheDocument();
    unmount();

    renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs?since=1h');
    expect(await screen.findByText(/No runs match these filters/i)).toBeInTheDocument();
    expect(screen.queryByText(/No runs yet/i)).not.toBeInTheDocument();
  });

  /**
   * A picker that cannot load is not worth an error banner over the runs the
   * operator came here to read — it degrades to "All triggers".
   */
  it('still lists runs when the trigger picker fails to load', async () => {
    triggersMock.mockRejectedValue(new Error('offline'));
    listMock.mockResolvedValue([run({ id: 'run_ok' })]);
    renderWithRouter(<RunsPage store={storeWith()} />);
    expect(await screen.findByText('run_ok')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
