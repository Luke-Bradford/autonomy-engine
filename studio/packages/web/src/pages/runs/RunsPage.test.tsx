import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Run } from '@autonomy-studio/shared';
import { RunsPage } from './RunsPage';
import * as runsApi from '../../api/runs';
import * as router from '../../router';

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
    render(<RunsPage />);
    expect(await screen.findByText(/No runs yet/i)).toBeInTheDocument();
  });

  it('renders a run row with its status', async () => {
    listMock.mockResolvedValue([run({ id: 'run_abc', status: 'success' })]);
    render(<RunsPage />);
    expect(await screen.findByText('run_abc')).toBeInTheDocument();
    expect(screen.getByText('success')).toBeInTheDocument();
  });

  it('Watch navigates to the run detail route', async () => {
    listMock.mockResolvedValue([run({ id: 'run_abc' })]);
    const navSpy = vi.spyOn(router, 'navigate').mockImplementation(() => {});
    render(<RunsPage />);
    const btn = await screen.findByLabelText('Watch run run_abc');
    await userEvent.click(btn);
    expect(navSpy).toHaveBeenCalledWith('/runs/run_abc');
  });

  it('surfaces a load error', async () => {
    listMock.mockRejectedValue(new Error('nope'));
    render(<RunsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
  });
});
