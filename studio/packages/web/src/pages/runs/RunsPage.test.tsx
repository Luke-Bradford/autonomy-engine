import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { renderWithRouter } from '../../testing/renderWithRouter';
import { ROUTES } from '../../routes';
import userEvent from '@testing-library/user-event';
import {
  computeRunCost,
  rollupFromAggregates,
  RunStatusSchema,
  type PipelineCostAggregates,
  type RunSummary,
} from '@autonomy-studio/shared';
import { RunsPage } from './RunsPage';
import { runStatusLabel } from './runStatus';
import * as runsApi from '../../api/runs';
import * as pipelinesApi from '../../api/pipelines';
import * as triggersApi from '../../api/triggers';
import { ApiError } from '../../api/client';
import { createPipelinesStore } from '../../stores/pipelinesStore';

// Mock the whole api/runs network surface (matching the ConnectionsPage test
// convention of stubbing every network fn of the module, so no real call ever
// escapes to a partially-mocked module).
// #1206 — the app shell loads its build identity and update status on EVERY
// mount, so any suite that renders it makes two network attempts unless they are
// stubbed. Shared rather than hand-rolled here: this is the fourth file to need
// the same pair, which is the pattern the guard in `vitest.setup.ts` exists to
// stop repeating.
vi.mock('../../api/version', async () =>
  (await import('../../testing/apiModuleMocks')).versionModuleMock(),
);

vi.mock('../../api/runs', async (importActual) => ({
  ...(await importActual<typeof import('../../api/runs')>()),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  getRunEvents: vi.fn(),
  // #1206 — the Watch cases navigate to the run detail route, which loads R1
  // (`getRunDetail`) and the diagnostics list. The detail read REJECTS, which is
  // what the unmocked call already did: the page then falls back to `getRun`
  // above, the path these tests have always exercised.
  getRunDetail: vi.fn().mockRejectedValue(new Error('run detail not stubbed')),
  getRunDiagnostics: vi.fn().mockResolvedValue([]),
}));

// U26's pickers each reach the network. Triggers get the same whole-module stub
// the runs API gets; pipelines come in through the store seam below instead, so
// the page is exercised against the REAL store with an injected fetch.
vi.mock('../../api/triggers', async (importActual) => ({
  ...(await importActual<typeof import('../../api/triggers')>()),
  listTriggers: vi.fn(),
}));

/**
 * #931 — `api/pipelines` is PARTIALLY mocked, unlike the two above: the pipeline
 * LIST still comes through the store seam against the real module (see the note
 * above `storeWith`), and only the cost read is stubbed. A whole-module stub
 * would take the store's fetch out of the test too, and every existing
 * `?pipeline=` test would then exercise a page whose picker was never wired.
 */
vi.mock('../../api/pipelines', async (importActual) => ({
  ...(await importActual<typeof import('../../api/pipelines')>()),
  getPipelineCost: vi.fn(),
  // #1206 — the page's pipeline filter lists pipelines on mount; unmocked that
  // reached a real `fetch`. Empty is the honest default for a suite whose
  // fixtures are runs, not pipelines.
  listPipelines: vi.fn().mockResolvedValue([]),
}));

const listMock = vi.mocked(runsApi.listRuns);
const triggersMock = vi.mocked(triggersApi.listTriggers);
const costMock = vi.mocked(pipelinesApi.getPipelineCost);

/** A pipeline rollup in the shape the bounded SQL aggregate really produces. */
function rollup(over: Partial<PipelineCostAggregates> = {}) {
  return rollupFromAggregates({
    responseCount: 2,
    pricedResponseCount: 2,
    unpricedResponseCount: 0,
    totalCostEstimate: 2.5,
    inputTokens: 10,
    outputTokens: 20,
    inputReportedResponseCount: 2,
    outputReportedResponseCount: 2,
    runCount: 2,
    incompleteRunCount: 0,
    ...over,
  });
}

/** #931 — a run that billed nothing, which is the honest default for a fixture
 * that is not about money: zero metered exchanges reads as "No billed exchange",
 * never as `$0.00`. Tests that ARE about the column override it. */
const noSpend = computeRunCost([]);

/** A priced metered payload, in the shape `computeRunCost` folds. */
function metered(fields: { cost: number }) {
  return {
    payload: {
      type: 'activity.metered' as const,
      runId: 'run_1',
      nodeId: 'n1',
      attemptId: 'n1#1',
      provider: 'anthropic_api',
      model: 'claude-opus-4-8',
      meteringStatus: 'metered' as const,
      inputTokens: 10,
      outputTokens: 20,
      inUnitPrice: 5,
      outUnitPrice: 5,
      priceTableVersion: 'v1',
      costEstimate: fields.cost,
    },
  };
}

/**
 * The cell under a named column header. Indexed off the HEADER rather than a
 * fixed position, so it also pins the thing that actually breaks when a column is
 * inserted: a `<th>` and its `<td>` landing in different columns. Scoping matters
 * here for a second reason — the Duration cell carries its own "so far" marker
 * (`formatRunDuration`), so a row-wide query for it is ambiguous by construction.
 */
function cellUnder(row: HTMLElement, header: string): HTMLElement {
  const table = row.closest('table') as HTMLElement;
  const index = within(table)
    .getAllByRole('columnheader')
    .findIndex((h) => h.textContent === header);
  expect(index).toBeGreaterThanOrEqual(0);
  return within(row).getAllByRole('cell')[index] as HTMLElement;
}

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    cost: noSpend,
    id: 'run_1',
    ownerId: 'local',
    pipelineVersionId: 'pv_1',
    pipelineId: 'pipe_1',
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

/**
 * #1083 — `listRuns` answers a `{ items, nextCursor }` page. Every mock goes
 * through this rather than hand-writing the envelope, so a test states WHICH
 * runs come back and, where it matters, whether an older page exists.
 * `nextCursor` defaults to `null` — "this is the whole list" is what almost
 * every case here means, and it is what keeps a tab count a complete count.
 */
function pageOf(items: RunSummary[], nextCursor: string | null = null) {
  return { items, nextCursor };
}

beforeEach(() => {
  listMock.mockResolvedValue(pageOf([]));
  triggersMock.mockResolvedValue([]);
  costMock.mockResolvedValue(rollup());
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
    listMock.mockResolvedValue(pageOf([run({ id: 'run_abc', status: 'success' })]));
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
  /**
   * #931 (U27 slice 2) — the Cost column. Asserted against the ROW, not the page:
   * the table header carries the same word, so a page-wide query would pass with
   * the cell deleted.
   */
  it('states what a run cost, from the same authority the detail page uses', async () => {
    listMock.mockResolvedValue(
      pageOf([
        run({ id: 'run_abc', status: 'success', cost: computeRunCost([metered({ cost: 0.03 })]) }),
      ]),
    );
    renderWithRouter(<RunsPage />);
    const cost = cellUnder(
      (await screen.findByText('run_abc')).closest('tr') as HTMLElement,
      'Cost',
    );
    expect(cost).toHaveTextContent('$0.03');
    expect(cost).not.toHaveTextContent(/so far/);
  });

  it('a run that billed nothing says so, rather than showing $0.00', async () => {
    listMock.mockResolvedValue(pageOf([run({ id: 'run_abc', status: 'success' })]));
    renderWithRouter(<RunsPage />);
    const cost = cellUnder(
      (await screen.findByText('run_abc')).closest('tr') as HTMLElement,
      'Cost',
    );
    expect(cost).toHaveTextContent('No billed exchange');
    expect(cost).not.toHaveTextContent('$0.00');
  });

  it("marks a LIVE run's figure as spend-so-far, visibly rather than on hover", async () => {
    listMock.mockResolvedValue(
      pageOf([
        run({ id: 'run_abc', status: 'running', cost: computeRunCost([metered({ cost: 0.03 })]) }),
      ]),
    );
    renderWithRouter(<RunsPage />);
    const cost = cellUnder(
      (await screen.findByText('run_abc')).closest('tr') as HTMLElement,
      'Cost',
    );
    expect(cost).toHaveTextContent('$0.03 so far');
    /* VISIBLE, not demoted to the title — the title carries the sentence, the
       cell carries the qualifier. */
    expect(cost.querySelector('.run-cost-unsettled')?.textContent).toBe(' so far');
    expect(cost.title).toContain('has not settled');
  });

  /*
     `costCell` is pinned as a pure function in `costColumn.test.ts`; this pins
     the WIRING of its third input. `cost` and `status` are both proved above by
     cells that would visibly change, but `rerunOf` reaches the operator only
     through the title — so a `RunCostCell` that never forwarded it (or forwarded
     a hardcoded null) would pass every other test on this page, and the caveat
     that keeps a rerun from reading as inexplicably cheap would just be absent.
  */
  it("forwards a rerun's identity, so its figure says it is only the INCREMENT", async () => {
    listMock.mockResolvedValue(
      pageOf([
        run({
          id: 'run_abc',
          status: 'success',
          rerunOf: 'run_source',
          cost: computeRunCost([metered({ cost: 0.03 })]),
        }),
      ]),
    );
    renderWithRouter(<RunsPage />);
    const cost = cellUnder(
      (await screen.findByText('run_abc')).closest('tr') as HTMLElement,
      'Cost',
    );
    expect(cost).toHaveTextContent('$0.03');
    expect(cost.title).toContain('run_source');
    expect(cost.title).toMatch(/re-executed only from the failure onward/);
  });

  it('Watch navigates to the run detail route', async () => {
    listMock.mockResolvedValue(pageOf([run({ id: 'run_abc' })]));
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
      pageOf(RunStatusSchema.options.map((status, i) => run({ id: `run_${i}`, status }))),
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
    listMock.mockResolvedValue(pageOf([run({ id: 'run_parked', status: 'waiting' })]));
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
    listMock.mockResolvedValue(
      pageOf([
        run({ id: 'run_abc', pipelineVersionId: 'pv_opaque', pipelineName: 'Nightly report' }),
      ]),
    );
    renderWithRouter(<RunsPage />);
    expect(await screen.findByText(/Nightly report/)).toBeInTheDocument();
    expect(screen.getByText('v3')).toBeInTheDocument();
    expect(screen.queryByText('pv_opaque')).not.toBeInTheDocument();
    // Not lost, just demoted: the opaque key stays reachable as the cell title.
    expect(screen.getByTitle('pv_opaque')).toBeInTheDocument();
  });

  it('names the trigger, and em-dashes a run that has none', async () => {
    listMock.mockResolvedValue(
      pageOf([
        run({ id: 'run_t', triggerName: 'Every morning' }),
        run({ id: 'run_m', triggerId: null, triggerName: null }),
      ]),
    );
    renderWithRouter(<RunsPage />);
    expect(await screen.findByText('Every morning')).toBeInTheDocument();
    // Scoped to the trigger-less run's own TRIGGER cell: an unscoped `—` search
    // would also match the Duration column, and pass even if the trigger cell
    // rendered nothing at all.
    const manualRow = screen.getByRole('row', { name: /run_m/ });
    expect(within(manualRow).getAllByRole('cell')[2]).toHaveTextContent('—');
  });

  it('renders a finished run duration, and marks an unfinished one "so far"', async () => {
    listMock.mockResolvedValue(
      pageOf([
        run({ id: 'run_done', status: 'success', startedAt: 1_000, finishedAt: 8_000 }),
        run({ id: 'run_live', status: 'running', startedAt: 1_000, finishedAt: null }),
      ]),
    );
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
    listMock.mockResolvedValue(
      pageOf([
        run({ id: 'run_trig', triggerId: 'trg_1', parentRunId: null }),
        run({ id: 'run_manual', triggerId: null, parentRunId: null, triggerName: null }),
        run({ id: 'run_child', triggerId: null, parentRunId: 'run_trig', triggerName: null }),
      ]),
    );
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
    listMock.mockResolvedValue(
      pageOf([
        run({ id: 'run_trig', triggerId: 'trg_1', parentRunId: null }),
        run({ id: 'run_trig2', triggerId: 'trg_1', parentRunId: null }),
        run({ id: 'run_child', triggerId: null, parentRunId: 'run_trig', triggerName: null }),
      ]),
    );
    renderWithRouter(<RunsPage />);
    await screen.findByText('run_trig');
    expect(screen.getByRole('tab', { name: /^All/ })).toHaveTextContent('3');
    expect(screen.getByRole('tab', { name: /Triggered/ })).toHaveTextContent('2');
    expect(screen.getByRole('tab', { name: /Child/ })).toHaveTextContent('1');
    expect(screen.getByRole('tab', { name: /Manual/ })).toHaveTextContent('0');
  });

  it('says so when a tab has no runs, rather than showing an empty table', async () => {
    listMock.mockResolvedValue(pageOf([run({ id: 'run_trig', triggerId: 'trg_1' })]));
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
    listMock.mockResolvedValue(
      pageOf([
        run({ id: 'run_trig', triggerId: 'trg_1', parentRunId: null }),
        run({ id: 'run_manual', triggerId: null, parentRunId: null, triggerName: null }),
      ]),
    );
    renderWithRouter(<RunsPage />, '/monitor/runs?tab=manual');
    expect(await screen.findByText('run_manual')).toBeInTheDocument();
    expect(screen.queryByText('run_trig')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Manual/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('falls back to All on an unrecognised ?tab, rather than showing nothing', async () => {
    listMock.mockResolvedValue(pageOf([run({ id: 'run_trig', triggerId: 'trg_1' })]));
    renderWithRouter(<RunsPage />, '/monitor/runs?tab=not-a-tab');
    expect(await screen.findByText('run_trig')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true');
  });

  /**
   * And WRITTEN back, so the filtered view is linkable and Back undoes it. `all`
   * is expressed by the param's ABSENCE — one canonical URL per view.
   */
  it('writes the selected tab to the URL, and clears it for All', async () => {
    listMock.mockResolvedValue(pageOf([run({ id: 'run_trig', triggerId: 'trg_1' })]));
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
    listMock.mockResolvedValue(pageOf([run({ id: 'run_abc' })]));
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
    // #1083 — the FIRST page, so the cursor argument is `undefined`. Asserted
    // rather than waved through with `expect.anything()`: a first request that
    // carried a cursor would resume mid-list, which is exactly the bug a
    // stale-cursor regression produces.
    expect(listMock).toHaveBeenCalledWith({}, undefined, expect.anything());
  });

  it('reads every axis out of the URL and asks the SERVER for it', async () => {
    renderWithRouter(
      <RunsPage store={storeWith(pipeline('pl_1', 'Reports'))} />,
      '/monitor/runs?status=failure&pipeline=pl_1&trigger=trg_1&since=24h',
    );
    await screen.findByText(/No runs match these filters/i);
    expect(listMock).toHaveBeenCalledWith(
      { status: 'failure', pipelineId: 'pl_1', triggerId: 'trg_1', since: '24h' },
      undefined,
      expect.anything(),
    );
  });

  it('writes a chosen status to the URL and refetches with it', async () => {
    renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs');
    await screen.findByText(/No runs yet/i);
    listMock.mockClear();

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'failure');

    expect(listMock).toHaveBeenCalledWith({ status: 'failure' }, undefined, expect.anything());
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
    expect(listMock).toHaveBeenCalledWith({}, undefined, expect.anything());
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
   * #931 (U27 slice 2) — the pipeline-level rollup. `GET /api/pipelines/:id/cost`
   * had no web caller at all before this; what these pin is the CONTRACT between
   * the filter and that request, and the honesty rules the figure travels with.
   * The five-way reading itself is `pipelineCostSummary`'s suite, not re-asserted
   * through a mock here.
   */
  describe('pipeline spend', () => {
    const spend = () => screen.getByRole('region', { name: 'Lifetime spend' });

    it('asks for the filtered pipeline’s lifetime spend and states it', async () => {
      renderWithRouter(
        <RunsPage store={storeWith(pipeline('pl_1', 'Reports'))} />,
        '/monitor/runs?pipeline=pl_1',
      );
      expect(await screen.findByRole('region', { name: 'Lifetime spend' })).toBeInTheDocument();
      expect(costMock).toHaveBeenCalledWith('pl_1', expect.anything());
      expect(within(spend()).getByText('$2.50')).toBeInTheDocument();
    });

    /* The sentence that stops the figure being read as the total of the rows
       below it — which it is not, under ANY of the four filters or the tab. */
    it('says the figure covers every run of the pipeline, not the rows on screen', async () => {
      renderWithRouter(
        <RunsPage store={storeWith(pipeline('pl_1', 'Reports'))} />,
        '/monitor/runs?pipeline=pl_1&status=failure',
      );
      const section = await screen.findByRole('region', { name: 'Lifetime spend' });
      expect(section).toHaveTextContent(/Across all 2 runs, every version/);
      expect(section).toHaveTextContent(/not just the runs listed below/);
    });

    it('does not fetch or render it when no pipeline is selected', async () => {
      renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs');
      await screen.findByText(/No runs yet/i);
      expect(costMock).not.toHaveBeenCalled();
      expect(screen.queryByRole('region', { name: 'Lifetime spend' })).not.toBeInTheDocument();
    });

    /* The placement rule: it sits outside the rows guard, because an all-time
       figure is MOST informative exactly when the filtered list is empty. */
    it('survives a filter that matches no runs', async () => {
      listMock.mockResolvedValue(pageOf([]));
      renderWithRouter(
        <RunsPage store={storeWith(pipeline('pl_1', 'Reports'))} />,
        '/monitor/runs?pipeline=pl_1&status=failure',
      );
      await screen.findByText(/No runs match these filters/i);
      expect(within(spend()).getByText('$2.50')).toBeInTheDocument();
    });

    /* A 404 is the SAME state the run list handles silently (an unowned or
       deleted id), and the picker already marks it "(unavailable)". Shouting
       here would make one URL both handled and broken. */
    it('says nothing at all when the pipeline is not this owner’s', async () => {
      costMock.mockRejectedValue(new ApiError(404, 'pipeline pl_gone not found'));
      renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs?pipeline=pl_gone');
      await screen.findByText(/No runs match these filters/i);
      expect(screen.queryByRole('region', { name: 'Lifetime spend' })).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByText(/Lifetime spend unavailable/)).not.toBeInTheDocument();
    });

    /* Any other failure is disclosed — but as a hint, not a second alert beside
       the run list's own. A figure that failed to load must not look like a
       pipeline that spent nothing. */
    it('discloses a real failure quietly, without a second alert', async () => {
      costMock.mockRejectedValue(new ApiError(500, 'database is locked'));
      renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs?pipeline=pl_1');
      expect(await screen.findByText(/Lifetime spend unavailable/)).toHaveTextContent(
        'database is locked',
      );
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('re-fetches the rollup on Refresh, so one button freshens the whole page', async () => {
      renderWithRouter(
        <RunsPage store={storeWith(pipeline('pl_1', 'Reports'))} />,
        '/monitor/runs?pipeline=pl_1',
      );
      await screen.findByRole('region', { name: 'Lifetime spend' });
      costMock.mockClear();
      costMock.mockResolvedValue(rollup({ totalCostEstimate: 9 }));

      await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

      expect(costMock).toHaveBeenCalledWith('pl_1', expect.anything());
      expect(await within(spend()).findByText('$9.00')).toBeInTheDocument();
    });

    /* Stamped with the pipeline it answers for. Without that, switching pipelines
       leaves the previous one's money under the new one's name — briefly, but
       long enough to be read as this pipeline's spend. */
    it('never shows one pipeline’s spend under another', async () => {
      const store = storeWith(pipeline('pl_1', 'Reports'), pipeline('pl_2', 'Backups'));
      renderWithRouter(<RunsPage store={store} />, '/monitor/runs?pipeline=pl_1');
      await within(await screen.findByRole('region', { name: 'Lifetime spend' })).findByText(
        '$2.50',
      );

      let release: (r: ReturnType<typeof rollup>) => void = () => undefined;
      costMock.mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      await userEvent.selectOptions(screen.getByLabelText('Pipeline'), 'pl_2');

      expect(screen.queryByText('$2.50')).not.toBeInTheDocument();
      await act(async () => {
        release(rollup({ totalCostEstimate: 4 }));
      });
      expect(within(spend()).getByText('$4.00')).toBeInTheDocument();
    });
  });

  /**
   * The filter pane must survive its own emptiness — if it rendered only when
   * rows exist, the control that clears the filter would vanish exactly when it
   * is needed, leaving the URL as the only way out.
   */
  it('keeps the pane reachable when the filter matches nothing, and Clear restores the list', async () => {
    listMock.mockResolvedValue(pageOf([]));
    renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs?status=failure');
    await screen.findByText(/No runs match these filters/i);

    listMock.mockResolvedValue(pageOf([run({ id: 'run_back' })]));
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(await screen.findByText('run_back')).toBeInTheDocument();
    expect(listMock).toHaveBeenLastCalledWith({}, undefined, expect.anything());
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  /**
   * The rows on screen were fetched under the PREVIOUS filter. Leaving them up
   * while the new request is in flight shows a list that contradicts the
   * controls right above it — briefly, but long enough to be read as the answer,
   * which for a status filter means reading a success as a failure.
   */
  it("never shows the previous filter's rows under the new filter", async () => {
    listMock.mockResolvedValue(pageOf([run({ id: 'run_old' })]));
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
    listMock.mockResolvedValue(pageOf([run({ id: 'run_here' })]));
    renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs?status=failure');
    expect(await screen.findByText('run_here')).toBeInTheDocument();

    listMock.mockReturnValue(new Promise(() => {}));
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(screen.getByText('run_here')).toBeInTheDocument();
  });

  /**
   * A load can be superseded while it is still in flight, and abort does not
   * fully cover it: a request whose response has already arrived can still
   * resolve after the controller aborts. Without a sequence guard the OLDER
   * answer wins on completion order, so the list silently reverts to a stale
   * snapshot.
   *
   * #1083 — the guard MOVED rather than went away. It used to be this page's own
   * `latestLoad` ref; it is now the single counter inside `usePagedList` (via
   * `useGuardedLoad`). This test stays pointed at the PAGE, so it proves the
   * behaviour survived the move rather than only that the hook has it.
   *
   * THE TRIGGER CHANGED WITH IT, and the reason is worth recording. This used to
   * supersede via a double-Refresh; Refresh is now `disabled` while a request is
   * in flight (the AuditPage rule — `usePagedList` is latest-wins rather than
   * drop-the-new, so a second click would abort and re-issue a request already
   * on its way), which makes that path unreachable through the UI. A FILTER
   * CHANGE is the reachable superseder, and it exercises the same counter.
   */
  it('drops a superseded load that resolves LATE', async () => {
    let resolveFirst: (page: { items: RunSummary[]; nextCursor: string | null }) => void = () => {};
    listMock.mockReturnValueOnce(
      new Promise<{ items: RunSummary[]; nextCursor: string | null }>((resolve) => {
        resolveFirst = resolve;
      }),
    );
    renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs');
    await screen.findByText(/Loading runs/i);

    // A second load — a different filter — which answers first.
    listMock.mockResolvedValue(pageOf([run({ id: 'run_fresh' })]));
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'failure');
    expect(await screen.findByText('run_fresh')).toBeInTheDocument();

    // Now the abandoned first load finally answers. It must be dropped.
    // `act` is what makes this test able to FAIL: without flushing React's
    // update queue the assertion runs before any re-render, so a stale row that
    // WAS applied would still not be in the DOM yet and the test would pass
    // against a missing guard.
    await act(async () => {
      resolveFirst(pageOf([run({ id: 'run_stale' })]));
    });
    expect(screen.queryByText('run_stale')).not.toBeInTheDocument();
    expect(screen.getByText('run_fresh')).toBeInTheDocument();
  });

  /**
   * #1083 — the page renders ONE page of runs and extends it on demand. What is
   * pinned here is the honesty of the surfaces that used to describe a complete
   * list: the origin tab counts and the empty-tab line were a census when every
   * run was fetched, and they must not keep claiming that over a prefix.
   */
  describe('paging (#1083)', () => {
    it('offers Load older runs only while the server says there are older ones', async () => {
      listMock.mockResolvedValue(pageOf([run({ id: 'run_1' })], 'cur_1'));
      renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs');
      await screen.findByText('run_1');
      expect(screen.getByRole('button', { name: 'Load older runs' })).toBeInTheDocument();

      listMock.mockResolvedValue(pageOf([run({ id: 'run_2' })]));
      await userEvent.click(screen.getByRole('button', { name: 'Load older runs' }));

      // APPENDED, not replaced — the reader keeps what they were looking at.
      expect(await screen.findByText('run_2')).toBeInTheDocument();
      expect(screen.getByText('run_1')).toBeInTheDocument();
      expect(listMock).toHaveBeenLastCalledWith({}, 'cur_1', expect.anything());
      // The walk ended, so the control goes: a button that did nothing would
      // make the end of the history indistinguishable from a stalled load.
      expect(screen.queryByRole('button', { name: 'Load older runs' })).not.toBeInTheDocument();
    });

    it('marks a tab count as a LOWER BOUND while older runs remain', async () => {
      listMock.mockResolvedValue(pageOf([run({ id: 'run_1', triggerId: 'trg_1' })], 'cur_1'));
      renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs');
      await screen.findByText('run_1');

      // `1+`, not `1`: one run of this origin has been LOADED, and the workspace
      // may hold more. The bare number would be a census claim over a prefix.
      const tabs = screen.getByRole('tablist');
      expect(within(tabs).getByRole('tab', { name: /Triggered 1\+/ })).toBeInTheDocument();
      expect(within(tabs).getByRole('tab', { name: /Manual 0\+/ })).toBeInTheDocument();

      listMock.mockResolvedValue(pageOf([run({ id: 'run_2', triggerId: 'trg_1' })]));
      await userEvent.click(screen.getByRole('button', { name: 'Load older runs' }));
      await screen.findByText('run_2');

      // The walk is exhausted, so the counts are complete claims again.
      expect(within(tabs).getByRole('tab', { name: /Triggered 2$/ })).toBeInTheDocument();
      expect(within(tabs).getByRole('tab', { name: /Manual 0$/ })).toBeInTheDocument();
    });

    it('scopes the empty-tab line to what has been loaded while older runs remain', async () => {
      listMock.mockResolvedValue(pageOf([run({ id: 'run_1', triggerId: 'trg_1' })], 'cur_1'));
      renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs?tab=manual');
      await screen.findByText(/No manual runs in the runs loaded so far/i);

      listMock.mockResolvedValue(pageOf([run({ id: 'run_2', triggerId: 'trg_1' })]));
      await userEvent.click(screen.getByRole('button', { name: 'Load older runs' }));

      // Once the walk has ended the unqualified sentence is TRUE, and is what
      // the reader should see.
      expect(await screen.findByText(/^No manual runs\.$/i)).toBeInTheDocument();
    });

    it('words a failed OLDER page apart from a failed first one, keeping the loaded runs', async () => {
      listMock.mockResolvedValue(pageOf([run({ id: 'run_1' })], 'cur_1'));
      renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs');
      await screen.findByText('run_1');

      listMock.mockRejectedValue(new Error('network down'));
      await userEvent.click(screen.getByRole('button', { name: 'Load older runs' }));

      expect(
        await screen.findByText(/Could not load older runs: network down/i),
      ).toBeInTheDocument();
      // The history already on screen is real and stays — a failed older page
      // must not cost the reader what they were already looking at.
      expect(screen.getByText('run_1')).toBeInTheDocument();
    });
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
    listMock.mockResolvedValue(pageOf([run({ id: 'run_ok' })]));
    renderWithRouter(<RunsPage store={storeWith()} />);
    expect(await screen.findByText('run_ok')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

/**
 * U29 (#1015) — the List/Timeline switch.
 *
 * Its rules are `?tab=`'s, and the interesting one is that the view is a VIEW:
 * it must not disturb which rows are in scope, and the other URL writers on this
 * page must not disturb it.
 */
describe('U29 runs view toggle', () => {
  beforeEach(() => {
    listMock.mockResolvedValue(
      pageOf([
        run({
          id: 'run_a',
          pipelineId: 'pipe_a',
          pipelineName: 'Alpha',
          startedAt: 1,
          finishedAt: 2,
        }),
      ]),
    );
  });

  it('shows the table by default, and the chart at ?view=timeline', async () => {
    renderWithRouter(<RunsPage />, '/monitor/runs');
    await screen.findByText('run_a');
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Timeline' })).not.toBeInTheDocument();

    cleanup();
    renderWithRouter(<RunsPage />, '/monitor/runs?view=timeline');
    expect(await screen.findByRole('heading', { name: 'Timeline' })).toBeInTheDocument();
    // One panel, one rendering — showing both would put every run id on screen
    // twice and make the table's own row queries ambiguous.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('falls back to the table for an unrecognised ?view=, rather than erroring', async () => {
    renderWithRouter(<RunsPage />, '/monitor/runs?view=gantt-3d');
    await screen.findByText('run_a');
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('writes the view to the URL, and clears the param for the default', async () => {
    const router = createMemoryRouter(ROUTES, { initialEntries: ['/monitor/runs'] });
    render(<RouterProvider router={router} />);
    await screen.findByText('run_a');

    await userEvent.click(screen.getByRole('button', { name: 'Timeline' }));
    expect(router.state.location.search).toBe('?view=timeline');

    await userEvent.click(screen.getByRole('button', { name: 'List' }));
    // The default is the param's ABSENCE — one canonical URL per view.
    expect(router.state.location.search).toBe('');
  });

  /**
   * The view survives a FILTER change. `clearFilters` deletes only
   * `RUN_FILTER_PARAMS` and every other writer copies `searchParams`, so this
   * holds today for free — which is exactly why it is worth pinning: nothing in
   * the code says it, and a future writer that rebuilds the params from scratch
   * would silently throw the operator back to the table.
   */
  it('keeps the view when a filter changes', async () => {
    const router = createMemoryRouter(ROUTES, {
      initialEntries: ['/monitor/runs?view=timeline'],
    });
    render(<RouterProvider router={router} />);
    await screen.findByRole('heading', { name: 'Timeline' });

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'failure');

    expect(router.state.location.search).toContain('view=timeline');
    expect(await screen.findByRole('heading', { name: 'Timeline' })).toBeInTheDocument();
  });
});
