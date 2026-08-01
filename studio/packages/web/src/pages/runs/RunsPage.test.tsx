import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { renderWithRouter } from '../../testing/renderWithRouter';
import { ROUTES } from '../../routes';
import userEvent from '@testing-library/user-event';
import { RunStatusSchema, type RunSummary } from '@autonomy-studio/shared';
import { RunsPage } from './RunsPage';
import { runStatusLabel } from './runStatus';
import * as runsApi from '../../api/runs';

// Mock the whole api/runs network surface (matching the ConnectionsPage test
// convention of stubbing every network fn of the module, so no real call ever
// escapes to a partially-mocked module).
vi.mock('../../api/runs', async (importActual) => ({
  ...(await importActual<typeof import('../../api/runs')>()),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  getRunEvents: vi.fn(),
}));

const listMock = vi.mocked(runsApi.listRuns);

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
    pipelineId: 'pl_1',
    pipelineName: 'Nightly report',
    pipelineVersion: 3,
    triggerName: 'Every morning',
    ...overrides,
  };
}

beforeEach(() => {
  listMock.mockResolvedValue([]);
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
    expect(screen.getByText('success')).toBeInTheDocument();
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
    for (const status of RunStatusSchema.options) {
      expect(screen.getByText(runStatusLabel(status)), `no cell for ${status}`).toBeInTheDocument();
    }
    expect(screen.getByText('queued (slot)')).toBeInTheDocument();
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
    expect(await screen.findByText('waiting')).toBeInTheDocument();
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
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
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
});
