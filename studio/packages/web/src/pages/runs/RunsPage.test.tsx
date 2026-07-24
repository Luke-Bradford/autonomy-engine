import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { renderWithRouter } from '../../testing/renderWithRouter';
import userEvent from '@testing-library/user-event';
import type { Run } from '@autonomy-studio/shared';
import { RunsPage } from './RunsPage';
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

function run(overrides: Partial<Run> = {}): Run {
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
   * Asserted through a REAL router rather than a spy on the old module-level
   * `navigate`: the destination is proved by the route that actually matched,
   * so a wrong path — including the pre-U2 `/runs/:id` shape, which no longer
   * exists — fails here instead of passing against a mock that agrees with
   * itself.
   */
  it('Watch navigates to the run detail route', async () => {
    listMock.mockResolvedValue([run({ id: 'run_abc' })]);
    const router = createMemoryRouter(
      [
        { path: '/monitor/runs', element: <RunsPage /> },
        { path: '/monitor/runs/:runId', element: <div>detail for run_abc</div> },
      ],
      { initialEntries: ['/monitor/runs'] },
    );
    render(<RouterProvider router={router} />);

    await userEvent.click(await screen.findByLabelText('Watch run run_abc'));

    expect(await screen.findByText('detail for run_abc')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/monitor/runs/run_abc');
  });

  it('surfaces a load error', async () => {
    listMock.mockRejectedValue(new Error('nope'));
    renderWithRouter(<RunsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
  });
});
