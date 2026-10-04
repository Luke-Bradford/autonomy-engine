import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { expectAccessibleNameContainsText } from '../../testing/accessibleName';
import { renderWithDataRouter, renderWithRouter } from '../../testing/renderWithRouter';
import { dayOf } from '../../lib/displayTime';
import { dayRangeBounds } from './runFilters';
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
import { RUNS_PAGE_SIZE } from '../../api/runs';
import {
  RUNS_LIVE_FAILING_LABEL,
  RUNS_LIVE_POLL_MS,
  RUNS_LIVE_UPDATING_LABEL,
} from './useRunsLive';
import * as pipelinesApi from '../../api/pipelines';
import * as triggersApi from '../../api/triggers';
import { ApiError } from '../../api/client';
import { createPipelinesStore } from '../../stores/pipelinesStore';
import {
  createUiStore,
  RUN_GRID_COLUMN_WIDTHS,
  RUN_GRID_HIDDEN_STORAGE_KEY,
  RUN_GRID_RESIZE_STEP,
  RUNS_LIVE_STORAGE_KEY,
} from '../../stores/uiStore';

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
  listRunAnnotations: vi.fn(),
  getRun: vi.fn(),
  getRunEvents: vi.fn(),
  // #1206 — the row-link cases navigate to the run detail route, which loads R1
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
    triggeredByKind: 'manual',
    parentPipelineName: null,
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
    debug: false,
    annotations: [],
    triggerName: 'Every morning',
    activities: null,
    rowsWritten: null,
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
  vi.mocked(runsApi.listRunAnnotations).mockResolvedValue([]);
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

  /**
   * #1484 — the Activities and Rows-written columns, each under its OWN header
   * (`cellUnder` fails if a `<th>` and its `<td>` drift apart). The glyphs are
   * hidden from assistive tech, which reads the counts in words.
   */
  it("shows each run's activity counts and rows written under their headers", async () => {
    listMock.mockResolvedValue(
      pageOf([
        run({
          id: 'run_abc',
          status: 'failure',
          activities: { succeeded: 8, failed: 1, skipped: 2, reused: 0, unfinished: 0 },
          rowsWritten: 1092,
        }),
      ]),
    );
    renderWithRouter(<RunsPage />);
    const row = (await screen.findByText('run_abc')).closest('tr') as HTMLElement;
    const activities = cellUnder(row, 'Activities');
    expect(within(activities).getByText('8 ✓ · 1 ✗ · 2 skipped')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    expect(within(activities).getByText('8 succeeded, 1 failed, 2 skipped')).toHaveClass(
      'visually-hidden',
    );
    expect(cellUnder(row, 'Rows written')).toHaveTextContent('1,092');
    expect(cellUnder(row, 'Rows written')).toHaveAttribute(
      'title',
      "Rows this run's successful activities wrote",
    );
  });

  /** #1484 — a child run names its caller's pipeline and links that run. */
  it('a child run names the pipeline that called it, linking the calling run', async () => {
    listMock.mockResolvedValue(
      pageOf([
        run({
          id: 'run_child',
          parentRunId: 'run_parent_1234',
          parentPipelineName: 'Orchestrator',
        }),
        run({ id: 'run_unnamed', parentRunId: 'run_parent_5678', parentPipelineName: null }),
        run({ id: 'run_top' }),
      ]),
    );
    renderWithRouter(<RunsPage />);
    const rowOf = async (id: string) => (await screen.findByText(id)).closest('tr') as HTMLElement;
    const named = within(cellUnder(await rowOf('run_child'), 'Parent')).getByRole('link');
    expect(named).toHaveTextContent(/^Orchestrator$/);
    expect(named).toHaveAccessibleName('Orchestrator, parent run run_parent_1234');
    expect(named).toHaveAttribute(
      'href',
      expect.stringContaining('/monitor/runs/run_parent_1234') as unknown as string,
    );
    // No name for this viewer: the short id, and still the link.
    expect(
      within(cellUnder(await rowOf('run_unnamed'), 'Parent')).getByRole('link'),
    ).toHaveTextContent(/^ent_5678$/);
    expect(cellUnder(await rowOf('run_top'), 'Parent')).toHaveTextContent(/^—$/);
  });

  it('shows the annotations of the version a run bound once the column is turned on', async () => {
    const data = new Map<string, string>([[RUN_GRID_HIDDEN_STORAGE_KEY, '[]']]);
    const ui = createUiStore({
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
    });
    listMock.mockResolvedValue(
      pageOf([
        run({ id: 'run_tagged', annotations: ['finance', 'nightly'] }),
        run({ id: 'run_bare' }),
      ]),
    );
    renderWithRouter(<RunsPage ui={ui} />);
    const tagged = cellUnder(
      (await screen.findByText('run_tagged')).closest('tr') as HTMLElement,
      'Annotations',
    );
    expect(tagged).toHaveTextContent(/^finance, nightly$/);
    expect(
      cellUnder((await screen.findByText('run_bare')).closest('tr') as HTMLElement, 'Annotations'),
    ).toHaveTextContent(/^—$/);
  });

  it('draws the em-dash in both new columns when the server has no figure', async () => {
    listMock.mockResolvedValue(pageOf([run({ id: 'run_abc', status: 'queued' })]));
    renderWithRouter(<RunsPage />);
    const row = (await screen.findByText('run_abc')).closest('tr') as HTMLElement;
    expect(cellUnder(row, 'Activities')).toHaveTextContent('—No activity counts');
    expect(cellUnder(row, 'Rows written')).toHaveTextContent(/^—$/);
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

  /*
     RS6, carried by #1484's Triggered by cell — the row says a run is a rerun
     from failed. The source id rides in the cell's title, NOT as a link: two
     reruns of one run would otherwise put two identically named "Source run …"
     links on the page, and the row itself already reaches the detail page's own
     lineage link.
  */
  it('says which runs are reruns from failed, and names the source run', async () => {
    listMock.mockResolvedValue(
      pageOf([
        run({ id: 'run_rerun', triggerId: null, rerunOf: 'run_source', triggeredByKind: 'rerun' }),
        run({ id: 'run_source', status: 'failure' }),
      ]),
    );
    renderWithRouter(<RunsPage />);
    const rerunType = cellUnder(
      (await screen.findByText('run_rerun')).closest('tr') as HTMLElement,
      'Triggered by',
    );
    expect(rerunType).toHaveTextContent('Rerun from failed');
    expect(rerunType.title).toContain('run_source');
    expect(within(rerunType).queryByRole('link')).toBeNull();

    const sourceType = cellUnder(
      screen.getByText('run_source').closest('tr') as HTMLElement,
      'Triggered by',
    );
    expect(sourceType).toHaveTextContent('Fire now');
    expect(sourceType.title).toBe('');
  });

  it('the Run ID link navigates to the run detail route', async () => {
    listMock.mockResolvedValue(pageOf([run({ id: 'run_abc' })]));
    vi.mocked(runsApi.getRun).mockResolvedValue({ id: 'run_abc' } as never);
    const router = createMemoryRouter(ROUTES, { initialEntries: ['/monitor/runs'] });
    render(<RouterProvider router={router} />);

    await userEvent.click(await screen.findByRole('link', { name: 'Open run run_abc' }));

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

  it('says what started each run, and names the trigger when there is one', async () => {
    listMock.mockResolvedValue(
      pageOf([
        run({ id: 'run_t', triggerName: 'Every morning' }),
        run({ id: 'run_m', triggerId: null, triggerName: null, triggeredByKind: 'editor' }),
      ]),
    );
    renderWithRouter(<RunsPage />);
    // #1484 — what started it, then the trigger's name when there is one.
    const triggered = cellUnder(
      (await screen.findByText('run_t')).closest('tr') as HTMLElement,
      'Triggered by',
    );
    expect(triggered).toHaveTextContent('Fire now · Every morning');
    // No trigger: the kind alone, never a manufactured name or a dangling `·`.
    const editor = cellUnder(
      screen.getByText('run_m').closest('tr') as HTMLElement,
      'Triggered by',
    );
    expect(editor).toHaveTextContent(/^Editor run$/);
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
   * #1484 — what started a run is a SERVER-side axis now (`?kind=`), so the
   * client-side origin tabs are gone and a stale `?tab=` link is simply ignored.
   */
  it('has no origin tabs, and a stale ?tab= link lists every run unfiltered', async () => {
    listMock.mockResolvedValue(pageOf([run({ id: 'run_a', triggeredByKind: 'editor' })]));
    renderWithRouter(<RunsPage />, '/monitor/runs?tab=child');
    await screen.findByText('run_a');
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith({}, undefined, expect.anything(), RUNS_PAGE_SIZE);
  });

  /**
   * U10 owns turning the row action into a REAL link (the Shell section says so
   * explicitly). An anchor with an href is hoverable, copyable and
   * middle-clickable; the `useNavigate()` button it replaced was none of those.
   */
  it('renders the row action as a link with a real href', async () => {
    listMock.mockResolvedValue(pageOf([run({ id: 'run_abc' })]));
    renderWithRouter(<RunsPage />);
    const link = await screen.findByRole('link', { name: 'Open run run_abc' });
    expect(link).toHaveAttribute('href', expect.stringContaining('run_abc') as unknown as string);
    expectAccessibleNameContainsText(link);
  });

  /**
   * #1484 OR35 M1 — the whole ROW is the way in, not only its Run ID link.
   * Mounted on the real route table so a navigation lands somewhere observable.
   */
  describe('the row is a link', () => {
    function mountList() {
      // A plain cell's text to click: the Pipeline cell's name is a link of its own.
      listMock.mockResolvedValue(
        pageOf([run({ id: 'run_abc', pipelineName: 'Nightly', rowsWritten: 4321 })]),
      );
      vi.mocked(runsApi.getRun).mockResolvedValue({ id: 'run_abc' } as never);
      const router = createMemoryRouter(ROUTES, { initialEntries: ['/monitor/runs'] });
      render(<RouterProvider router={router} />);
      return router;
    }

    it('a click anywhere on the row opens the run', async () => {
      const router = mountList();
      await userEvent.click(await screen.findByText('4,321'));
      expect(router.state.location.pathname).toBe('/monitor/runs/run_abc');
    });

    it("the pipeline's name opens the version that ran, not the run", async () => {
      const router = mountList();
      await userEvent.click(await screen.findByRole('link', { name: 'Nightly v3' }));
      expect(router.state.location.pathname).toBe('/author/pipelines/pipe_1');
      expect(router.state.location.search).toBe('?version=3');
    });

    it('a click on the copy button does not navigate', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        configurable: true,
      });
      const router = mountList();
      await userEvent.click(await screen.findByRole('button', { name: 'Copy run id run_abc' }));
      expect(router.state.location.pathname).toBe('/monitor/runs');
    });

    function select(node: Node): void {
      const range = document.createRange();
      range.selectNodeContents(node);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    }

    it('a click that ends a text selection IN the row does not navigate', async () => {
      const router = mountList();
      const cell = await screen.findByText('4,321');
      select(cell);
      fireEvent.click(cell);
      expect(router.state.location.pathname).toBe('/monitor/runs');
      window.getSelection()?.removeAllRanges();
    });

    it('a selection elsewhere on the page does not disable the row', async () => {
      const router = mountList();
      const cell = await screen.findByText('4,321');
      select(screen.getByRole('heading', { name: 'Runs' }));
      fireEvent.click(cell);
      expect(router.state.location.pathname).toBe('/monitor/runs/run_abc');
      window.getSelection()?.removeAllRanges();
    });

    it('a middle or modified click opens it in a new tab instead', async () => {
      const open = vi.spyOn(window, 'open').mockReturnValue(null);
      const router = mountList();
      const cell = await screen.findByText('4,321');
      // jsdom's user-event does not raise `auxclick` for a middle button, so it
      // is dispatched as the browser would.
      fireEvent(cell, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
      fireEvent.click(cell, { shiftKey: true });
      expect(open).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenCalledWith(
        expect.stringContaining('/monitor/runs/run_abc'),
        '_blank',
        'noopener',
      );
      expect(router.state.location.pathname).toBe('/monitor/runs');
    });
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
    expect(listMock).toHaveBeenCalledWith({}, undefined, expect.anything(), RUNS_PAGE_SIZE);
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
      RUNS_PAGE_SIZE,
    );
  });

  it('writes a chosen status to the URL and refetches with it', async () => {
    renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs');
    await screen.findByText(/No runs yet/i);
    listMock.mockClear();

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'failure');

    expect(listMock).toHaveBeenCalledWith(
      { status: 'failure' },
      undefined,
      expect.anything(),
      RUNS_PAGE_SIZE,
    );
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
    expect(listMock).toHaveBeenCalledWith({}, undefined, expect.anything(), RUNS_PAGE_SIZE);
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
   * U26 — the ANNOTATION axis. Its options come from the server's run
   * annotations; the chosen one rides the URL as `?annotation=` and reaches the
   * list request, and an unknown one keeps the sibling orphan guard.
   */
  it('offers the run annotations, and a chosen one reaches the URL and the request', async () => {
    vi.mocked(runsApi.listRunAnnotations).mockResolvedValue(['finance', 'nightly']);
    renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs');
    await screen.findByText(/No runs yet/i);
    const select = screen.getByLabelText<HTMLSelectElement>('Annotation');
    await screen.findByRole('option', { name: 'nightly' });
    listMock.mockClear();

    await userEvent.selectOptions(select, 'nightly');

    // The filters are read from the URL alone (no state mirror), so the request
    // carrying it is the URL carrying it.
    expect(listMock).toHaveBeenCalledWith(
      { annotation: 'nightly' },
      undefined,
      expect.anything(),
      RUNS_PAGE_SIZE,
    );
    expect(select.value).toBe('nightly');
  });

  it('shows a filtered-but-unknown annotation as a disabled option, not as "All annotations"', async () => {
    renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs?annotation=retired');
    await screen.findByText(/No runs match these filters/i);
    expect(listMock).toHaveBeenCalledWith(
      { annotation: 'retired' },
      undefined,
      expect.anything(),
      RUNS_PAGE_SIZE,
    );
    const select = screen.getByLabelText<HTMLSelectElement>('Annotation');
    expect(select.value).toBe('retired');
    expect(screen.getByRole('option', { name: /retired/ })).toBeDisabled();
  });

  it('keeps the list when the annotation options cannot load', async () => {
    vi.mocked(runsApi.listRunAnnotations).mockRejectedValue(new Error('down'));
    renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs');
    await screen.findByText(/No runs yet/i);
    expect(screen.getByLabelText<HTMLSelectElement>('Annotation').value).toBe('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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
       below it — which it is not, under ANY of the filters or the tab. */
    /* #1484 — one dense line, and the caveats are the `?` button's
       description rather than a paragraph on the page. */
    it('says the figure covers every run of the pipeline, not the rows on screen', async () => {
      renderWithRouter(
        <RunsPage store={storeWith(pipeline('pl_1', 'Reports'))} />,
        '/monitor/runs?pipeline=pl_1&status=failure',
      );
      const section = await screen.findByRole('region', { name: 'Lifetime spend' });
      expect(section).toHaveTextContent(/^Lifetime spend \$2\.50/);
      expect(section).not.toHaveTextContent(/not just the runs listed below/);
      await userEvent.hover(within(section).getByRole('button', { name: 'About lifetime spend' }));
      const tip = await screen.findByRole('tooltip');
      expect(tip).toHaveTextContent(/Across all 2 runs, every version/);
      expect(tip).toHaveTextContent(/not just the runs listed below/);
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
    expect(listMock).toHaveBeenLastCalledWith({}, undefined, expect.anything(), RUNS_PAGE_SIZE);
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
    // The ROLE, not the label alone: the grid's Status header is named "Status" too.
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'failure');

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
   * #1083 — the page renders ONE page of runs and extends it on demand, and
   * every filter is asked of the server on each page (#1484), so no surface
   * here describes only the rows that happen to be loaded.
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
      expect(listMock).toHaveBeenLastCalledWith({}, 'cur_1', expect.anything(), RUNS_PAGE_SIZE);
      // The walk ended, so the control goes: a button that did nothing would
      // make the end of the history indistinguishable from a stalled load.
      expect(screen.queryByRole('button', { name: 'Load older runs' })).not.toBeInTheDocument();
    });

    /* #1484 — the reason the origin axis moved to the server: an older page is
       asked for under the SAME kind filter, so a filtered list is never just
       the matching subset of the pages that happened to be loaded. */
    it('asks for an older page under the same kind filter', async () => {
      listMock.mockResolvedValue(pageOf([run({ id: 'run_1', triggeredByKind: 'call' })], 'cur_1'));
      renderWithRouter(<RunsPage store={storeWith()} />, '/monitor/runs?kind=call');
      await screen.findByText('run_1');
      listMock.mockResolvedValue(pageOf([run({ id: 'run_2', triggeredByKind: 'call' })]));
      await userEvent.click(screen.getByRole('button', { name: 'Load older runs' }));
      await screen.findByText('run_2');
      expect(listMock).toHaveBeenLastCalledWith(
        { kind: 'call' },
        'cur_1',
        expect.anything(),
        RUNS_PAGE_SIZE,
      );
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

  describe('#1484 — the one-row filter bar', () => {
    it('the Triggered by menu writes a canonical ?kind= and asks the server for it', async () => {
      const { router } = renderWithDataRouter(<RunsPage store={storeWith()} />, '/monitor/runs');
      await screen.findByText(/No runs yet/i);
      const menu = () => screen.getByRole('button', { name: /^Triggered by:/ });
      expect(menu()).toHaveTextContent('Triggered by: All');

      await userEvent.click(menu());
      await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Webhook' }));
      expect(router.state.location.search).toBe('?kind=webhook');
      await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Schedule' }));
      // Canonical: vocabulary order, whatever order they were picked in.
      expect(router.state.location.search).toBe('?kind=schedule%2Cwebhook');
      expect(listMock).toHaveBeenLastCalledWith(
        { kind: 'schedule,webhook' },
        undefined,
        expect.anything(),
        RUNS_PAGE_SIZE,
      );
      expect(menu()).toHaveTextContent('Triggered by: 2 kinds');

      await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Schedule' }));
      await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Webhook' }));
      // Nothing picked is the unfiltered list, which is the param's absence.
      expect(router.state.location.search).toBe('');
    });

    it('searches 300ms after typing stops: the first write pushes, refinements replace', async () => {
      const { router } = renderWithDataRouter(<RunsPage store={storeWith()} />, '/monitor/runs');
      await screen.findByText(/No runs yet/i);
      const box = screen.getByRole('searchbox', { name: 'Search runs' });

      await userEvent.type(box, 'ord');
      // Not yet, and not 150ms later either: one request per word, not per letter.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(router.state.location.search).toBe('');
      await vi.waitFor(() => expect(router.state.location.search).toBe('?q=ord'));
      expect(router.state.historyAction).toBe('PUSH');
      await vi.waitFor(() =>
        expect(listMock).toHaveBeenLastCalledWith(
          { q: 'ord' },
          undefined,
          expect.anything(),
          RUNS_PAGE_SIZE,
        ),
      );

      await userEvent.type(box, 'ers ');
      await vi.waitFor(() => expect(router.state.location.search).toBe('?q=orders'));
      expect(router.state.historyAction).toBe('REPLACE');
      // The trailing space being typed is the operator's, not overwritten.
      expect(box).toHaveValue('orders ');

      await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
      expect(router.state.location.search).toBe('');
      expect(box).toHaveValue('');
    });

    it('Started offers one day or a range of days, each clearing the other time bounds', async () => {
      const { router } = renderWithDataRouter(
        <RunsPage store={storeWith()} />,
        '/monitor/runs?since=24h',
      );
      await screen.findByText(/No runs match these filters/i);
      const started = () => screen.getByLabelText('Started');

      await userEvent.selectOptions(started(), 'on');
      const today = dayOf(Date.now(), 'local');
      expect(new URLSearchParams(router.state.location.search).get('on')).toBe(today);
      expect(router.state.location.search).not.toContain('since');
      // A calendar pick is one change event carrying the whole day.
      fireEvent.change(await screen.findByLabelText('Day'), { target: { value: '2026-01-15' } });
      expect(router.state.location.search).toBe('?on=2026-01-15');
      const bounds = dayRangeBounds({ on: '2026-01-15' }, 'local');
      await vi.waitFor(() =>
        expect(listMock).toHaveBeenLastCalledWith(
          bounds,
          undefined,
          expect.anything(),
          RUNS_PAGE_SIZE,
        ),
      );

      // Clearing the day keeps the picker on "On a day" with its input in place,
      // and the bound leaves the request: the list is no longer narrowed by it.
      fireEvent.change(screen.getByLabelText('Day'), { target: { value: '' } });
      expect(started()).toHaveValue('on');
      expect(screen.getByLabelText('Day')).toHaveValue('');
      await vi.waitFor(() =>
        expect(listMock).toHaveBeenLastCalledWith({}, undefined, expect.anything(), RUNS_PAGE_SIZE),
      );
      // The day is still a filter param, so it can still be cleared in one click.
      expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();

      await userEvent.selectOptions(started(), 'range');
      const params = new URLSearchParams(router.state.location.search);
      expect(params.get('on')).toBeNull();
      expect(params.get('to')).toBe(today);
      expect(await screen.findByLabelText('From day')).toHaveValue(params.get('from'));

      await userEvent.selectOptions(started(), '7d');
      expect(router.state.location.search).toBe('?since=7d');
    });

    it('reads a day range from the URL and asks the server for its epoch bounds', async () => {
      renderWithRouter(
        <RunsPage store={storeWith()} />,
        '/monitor/runs?from=2026-01-01&to=2026-01-31&since=1h',
      );
      await screen.findByText(/No runs match these filters/i);
      // The days win over a relative window in the same URL: one time bound,
      // the one the picker shows.
      expect(screen.getByLabelText('Started')).toHaveValue('range');
      expect(listMock).toHaveBeenCalledWith(
        dayRangeBounds({ from: '2026-01-01', to: '2026-01-31' }, 'local'),
        undefined,
        expect.anything(),
        RUNS_PAGE_SIZE,
      );
    });

    it('bounds the day in the viewer’s display zone, and asks again when it changes', async () => {
      const data = new Map<string, string>();
      const ui = createUiStore({
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => void data.set(key, value),
      });
      ui.getState().setDisplayTimeZone('America/New_York');
      renderWithRouter(<RunsPage store={storeWith()} ui={ui} />, '/monitor/runs?on=2026-10-04');
      await screen.findByText(/No runs match these filters/i);
      expect(listMock).toHaveBeenLastCalledWith(
        { from: String(Date.UTC(2026, 9, 4, 4)), to: String(Date.UTC(2026, 9, 5, 4)) },
        undefined,
        expect.anything(),
        RUNS_PAGE_SIZE,
      );
      act(() => ui.getState().setDisplayTimeZone('UTC'));
      await vi.waitFor(() =>
        expect(listMock).toHaveBeenLastCalledWith(
          { from: String(Date.UTC(2026, 9, 4)), to: String(Date.UTC(2026, 9, 5)) },
          undefined,
          expect.anything(),
          RUNS_PAGE_SIZE,
        ),
      );
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
 * Its rules are every filter's, and the interesting one is that the view is a VIEW:
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

  /**
   * #1016 — the lane key is a URL param under `?view=`'s rules: absent means
   * pipeline, the default clears the param, and unrecognised falls back.
   */
  it('reads the lane key from ?group=, and writes it back', async () => {
    listMock.mockResolvedValue(
      pageOf([run({ id: 'run_t', annotations: ['nightly ops'], startedAt: 1, finishedAt: 2 })]),
    );
    const router = createMemoryRouter(ROUTES, {
      initialEntries: ['/monitor/runs?view=timeline&group=annotation'],
    });
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole('heading', { name: 'nightly ops' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'By annotation' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await userEvent.click(screen.getByRole('button', { name: 'By pipeline' }));
    expect(router.state.location.search).toBe('?view=timeline');
    expect(await screen.findByRole('heading', { name: 'Nightly report' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'By annotation' }));
    expect(router.state.location.search).toBe('?view=timeline&group=annotation');

    // A view setting, not a filter: switching to List and back keeps it.
    await userEvent.click(screen.getByRole('button', { name: 'List' }));
    await userEvent.click(screen.getByRole('button', { name: 'Timeline' }));
    expect(await screen.findByRole('heading', { name: 'nightly ops' })).toBeInTheDocument();
  });

  it('falls back to pipeline lanes for an unrecognised ?group=', async () => {
    renderWithRouter(<RunsPage />, '/monitor/runs?view=timeline&group=colour');
    expect(await screen.findByRole('heading', { name: 'Alpha' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'By pipeline' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

/**
 * #1484 OR35 M1 — the column picker and column widths. Each case injects its
 * OWN ui store, so a choice made here never leaks into another case through the
 * `uiStore` singleton.
 */
describe('#1484 — runs grid columns', () => {
  /* Its OWN storage, never `createUiStore(undefined)`: an explicit `undefined`
     takes the factory's DEFAULT, the ambient `localStorage`. That is an inert
     stub on some Node versions and a working store on others (CI's), where one
     case's hidden column or width was read back by the next. */
  const freshUi = () => {
    const data = new Map<string, string>();
    return createUiStore({
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
    });
  };
  async function renderGrid(path = '/') {
    const ui = freshUi();
    listMock.mockResolvedValue(pageOf([run({ id: 'run_abc', status: 'success' })]));
    renderWithRouter(<RunsPage ui={ui} />, path);
    // The pipeline's name is on both views; the run id only in the grid's.
    await screen.findAllByText(/Nightly report/);
    return ui;
  }
  const headers = () =>
    within(screen.getByRole('table'))
      .getAllByRole('columnheader')
      .map((h) => h.getAttribute('aria-label'));

  it('draws every column but Annotations by default, each header named by its label alone', async () => {
    await renderGrid();
    expect(headers()).toEqual([
      'Pipeline',
      'Status',
      'Triggered by',
      'Started',
      'Duration',
      'Activities',
      'Rows written',
      'Cost',
      'Run ID',
      'Parent',
    ]);
    // The resize handle inside the header must not join its accessible name.
    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeInTheDocument();
  });

  it('hides a column from the header AND every row, and stores the choice', async () => {
    const ui = await renderGrid();
    await userEvent.click(screen.getByRole('button', { name: /Columns/ }));
    await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Cost' }));
    expect(ui.getState().runsGridHidden).toEqual(['cost', 'annotations']);
    expect(headers()).not.toContain('Cost');
    const row = screen.getByText('run_abc').closest('tr') as HTMLElement;
    // Header and cells stay in step: the cell under Run ID is still the run id.
    expect(within(row).getAllByRole('cell')).toHaveLength(9);
    expect(cellUnder(row, 'Run ID')).toHaveTextContent('run_abc');
  });

  it('will not hide a required column, or the column the grid is sorted by', async () => {
    await renderGrid('/?sort=duration');
    await userEvent.click(screen.getByRole('button', { name: /Columns/ }));
    for (const name of ['Pipeline', 'Run ID', 'Duration']) {
      expect(await screen.findByRole('menuitemcheckbox', { name })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    }
    expect(screen.getByRole('menuitemcheckbox', { name: 'Started' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('draws a hidden column while the grid is sorted by it, keeping the choice', async () => {
    const ui = freshUi();
    ui.getState().setRunsGridHidden(['duration', 'cost']);
    listMock.mockResolvedValue(pageOf([run({ id: 'run_abc' })]));
    renderWithRouter(<RunsPage ui={ui} />, '/?sort=duration');
    await screen.findByText('run_abc');
    expect(headers()).toContain('Duration');
    expect(headers()).not.toContain('Cost');
    expect(ui.getState().runsGridHidden).toEqual(['duration', 'cost']);
  });

  it('sizes each column from the stored width, else its default', async () => {
    const ui = freshUi();
    ui.getState().setRunsGridWidth('status', 140);
    listMock.mockResolvedValue(pageOf([run({ id: 'run_abc' })]));
    const { container } = renderWithRouter(<RunsPage ui={ui} />);
    await screen.findByText('run_abc');
    const col = (id: string) => container.querySelector(`col.runs-grid__col--${id}`);
    expect(col('status')).toHaveStyle({ width: '140px' });
    expect(col('cost')).toHaveStyle({ width: `${RUN_GRID_COLUMN_WIDTHS.cost.default}px` });
  });

  it('resizes a column from the keyboard, and a double-click returns it to its default', async () => {
    const ui = await renderGrid();
    const handle = screen.getByRole('separator', { name: 'Resize Status column' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    const widened = RUN_GRID_COLUMN_WIDTHS.status.default + RUN_GRID_RESIZE_STEP;
    expect(ui.getState().runsGridWidths).toEqual({ status: widened });
    expect(handle).toHaveAttribute('aria-valuenow', String(widened));
    fireEvent.doubleClick(handle);
    expect(ui.getState().runsGridWidths).toEqual({});
  });

  it('a click on the resize handle does not sort the column', async () => {
    await renderGrid();
    const calls = listMock.mock.calls.length;
    // A CLICK, which is what would bubble to the sort button were the handle
    // inside it; a key press never reaches the button's click either way.
    await userEvent.click(screen.getByRole('separator', { name: 'Resize Status column' }));
    expect(screen.getByRole('columnheader', { name: 'Status' })).not.toHaveAttribute('aria-sort');
    expect(listMock.mock.calls.length).toBe(calls);
  });

  it('Reset columns returns to the default columns at their default widths', async () => {
    const ui = await renderGrid();
    act(() => {
      ui.getState().setRunsGridWidth('status', 200);
      ui.getState().setRunsGridHidden(['cost', 'activities']);
    });
    await userEvent.click(screen.getByRole('button', { name: /Columns/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Reset columns' }));
    expect(ui.getState().runsGridHidden).toEqual(['annotations']);
    expect(ui.getState().runsGridWidths).toEqual({});
    expect(headers()).toHaveLength(10);
    expect(document.querySelector('col.runs-grid__col--status')).toHaveStyle({
      width: `${RUN_GRID_COLUMN_WIDTHS.status.default}px`,
    });
  });

  it('offers no column picker on the Timeline, which has no columns', async () => {
    await renderGrid('/?view=timeline');
    expect(screen.queryByRole('button', { name: /Columns/ })).not.toBeInTheDocument();
  });
});

/**
 * #1484 OR35 M1 — Live mode and the page size. Only `Date` and the interval
 * timers are faked (`RunDetailPage.test.tsx`'s recipe): faking `setTimeout`
 * too would stall Testing Library's `findBy*` polling.
 */
describe('#1484 — runs list Live mode and page size', () => {
  const NOW = 1_700_000_065_000;
  const freshUi = (seed: Record<string, string> = {}) => {
    const data = new Map<string, string>(Object.entries(seed));
    return createUiStore({
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
    });
  };
  const liveUi = () => freshUi({ [RUNS_LIVE_STORAGE_KEY]: 'true' });
  const tick = (ms: number) => {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  };
  const durationOf = (runId: string) =>
    cellUnder(screen.getByText(runId).closest('tr') as HTMLElement, 'Duration');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.getSelection()?.removeAllRanges();
  });

  it('does not poll while Live is off — the list is a snapshot until Refresh', async () => {
    listMock.mockResolvedValue(pageOf([run({ id: 'run_old00001', status: 'success' })]));
    renderWithRouter(<RunsPage ui={freshUi()} />);
    await screen.findByText('run_old00001');
    tick(15_000);
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(RUNS_LIVE_UPDATING_LABEL)).not.toBeInTheDocument();
  });

  it('shows a new run without Refresh while Live is on, and says it is updating', async () => {
    listMock.mockResolvedValue(pageOf([run({ id: 'run_old00001', status: 'success' })]));
    renderWithRouter(<RunsPage ui={liveUi()} />);
    await screen.findByText('run_old00001');
    expect(screen.getByText(RUNS_LIVE_UPDATING_LABEL)).toBeInTheDocument();

    listMock.mockResolvedValue(
      pageOf([run({ id: 'run_new00002' }), run({ id: 'run_old00001', status: 'success' })]),
    );
    tick(RUNS_LIVE_POLL_MS);
    expect(await screen.findByText('run_new00002')).toBeInTheDocument();
    expect(listMock).toHaveBeenLastCalledWith({}, undefined, expect.anything(), RUNS_PAGE_SIZE);
  });

  it('turning Live on reads at once and is remembered for this viewer', async () => {
    const ui = freshUi();
    listMock.mockResolvedValue(pageOf([run({ id: 'run_old00001', status: 'success' })]));
    renderWithRouter(<RunsPage ui={ui} />);
    await screen.findByText('run_old00001');
    listMock.mockResolvedValue(pageOf([run({ id: 'run_new00002' })]));

    fireEvent.click(screen.getByRole('button', { name: 'Live' }));
    expect(await screen.findByText('run_new00002')).toBeInTheDocument();
    expect(ui.getState().runsLive).toBe(true);
  });

  it('counts an unfinished run up while live, and freezes it while paused', async () => {
    listMock.mockResolvedValue(pageOf([run({ id: 'run_live0001', startedAt: NOW - 65_000 })]));
    renderWithRouter(<RunsPage ui={liveUi()} />);
    await screen.findByText('run_live0001');
    expect(durationOf('run_live0001')).toHaveTextContent('1m 05s so far');
    tick(2_000);
    expect(durationOf('run_live0001')).toHaveTextContent('1m 07s so far');

    // Select text in the rows: the list pauses, and the count stops with it —
    // the page would no longer hear the run finish.
    const range = document.createRange();
    range.selectNodeContents(screen.getByText('Nightly report'));
    act(() => {
      document.getSelection()?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(screen.getByText('paused while text is selected')).toBeInTheDocument();
    // Held where it was — not rewound to when the list was read (1m 05s).
    expect(durationOf('run_live0001')).toHaveTextContent('1m 07s so far');
    const calls = listMock.mock.calls.length;
    tick(RUNS_LIVE_POLL_MS * 2);
    expect(durationOf('run_live0001')).toHaveTextContent('1m 07s so far');
    expect(listMock).toHaveBeenCalledTimes(calls);
  });

  it('pauses while the container holding the rows is scrolled down, and resumes at the top', async () => {
    listMock.mockResolvedValue(pageOf([run({ id: 'run_old00001', status: 'success' })]));
    const { container } = renderWithRouter(<RunsPage ui={liveUi()} />);
    await screen.findByText('run_old00001');
    const calls = listMock.mock.calls.length;

    Object.defineProperty(container, 'scrollTop', { value: 240, configurable: true });
    fireEvent.scroll(container);
    expect(screen.getByText('paused while scrolled down')).toBeInTheDocument();
    tick(RUNS_LIVE_POLL_MS * 2);
    expect(listMock).toHaveBeenCalledTimes(calls);

    Object.defineProperty(container, 'scrollTop', { value: 0, configurable: true });
    fireEvent.scroll(container);
    expect(screen.getByText(RUNS_LIVE_UPDATING_LABEL)).toBeInTheDocument();
    // Resuming reads at once rather than a whole interval later.
    expect(listMock).toHaveBeenCalledTimes(calls + 1);
  });

  it('is paused from the start when it mounts already scrolled down (#1527)', async () => {
    // Something holding the list kept its scroll across the mount; no scroll
    // event will arrive to say so.
    Object.defineProperty(document.body, 'scrollTop', { value: 240, configurable: true });
    try {
      listMock.mockResolvedValue(pageOf([run({ id: 'run_old00001', status: 'success' })]));
      renderWithRouter(<RunsPage ui={liveUi()} />);
      await screen.findByText('run_old00001');
      expect(screen.getByText('paused while scrolled down')).toBeInTheDocument();
      tick(RUNS_LIVE_POLL_MS * 2);
      expect(listMock).toHaveBeenCalledTimes(1);
    } finally {
      // The prototype's getter answers again once the own property is gone.
      delete (document.body as { scrollTop?: number }).scrollTop;
    }
  });

  it('a failed live read keeps the rows, says so, and stops the count', async () => {
    listMock.mockResolvedValueOnce(pageOf([run({ id: 'run_live0001', startedAt: NOW - 65_000 })]));
    renderWithRouter(<RunsPage ui={liveUi()} />);
    await screen.findByText('run_live0001');
    listMock.mockRejectedValueOnce(new Error('server down'));
    tick(RUNS_LIVE_POLL_MS);
    expect(await screen.findByRole('alert')).toHaveTextContent('Live update failed: server down');
    expect(screen.getByText(RUNS_LIVE_FAILING_LABEL)).toBeInTheDocument();
    // The page cannot hear this run finish now, so its duration stops counting.
    const held = durationOf('run_live0001').textContent;
    tick(3_000);
    expect(durationOf('run_live0001').textContent).toBe(held);
  });

  it('pauses while the tab is hidden', async () => {
    listMock.mockResolvedValue(pageOf([run({ id: 'run_old00001', status: 'success' })]));
    renderWithRouter(<RunsPage ui={liveUi()} />);
    await screen.findByText('run_old00001');
    const calls = listMock.mock.calls.length;
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    tick(RUNS_LIVE_POLL_MS * 2);
    expect(listMock).toHaveBeenCalledTimes(calls);
    visibility.mockReturnValue('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // Waking reads at once.
    expect(listMock).toHaveBeenCalledTimes(calls + 1);
  });

  it('pauses for a selection that starts above the rows and ends in them', async () => {
    listMock.mockResolvedValue(pageOf([run({ id: 'run_old00001', status: 'success' })]));
    renderWithRouter(<RunsPage ui={liveUi()} />);
    await screen.findByText('run_old00001');
    const selection = document.getSelection()!;
    act(() => {
      selection.setBaseAndExtent(
        screen.getByRole('heading', { name: 'Runs' }),
        0,
        screen.getByText('run_old00001'),
        0,
      );
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(screen.getByText('paused while text is selected')).toBeInTheDocument();
  });

  it('reads the chosen page size, and remembers it for this viewer', async () => {
    vi.useRealTimers();
    const ui = freshUi();
    listMock.mockResolvedValue(pageOf([run({ id: 'run_old00001', status: 'success' })]));
    renderWithRouter(<RunsPage ui={ui} />);
    await screen.findByText('run_old00001');

    await userEvent.selectOptions(screen.getByLabelText('Runs per page'), '100');
    expect(listMock).toHaveBeenLastCalledWith({}, undefined, expect.anything(), 100);
    expect(ui.getState().runsPageSize).toBe(100);
  });
});
