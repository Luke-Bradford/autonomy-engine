import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App';

// The run pages talk to the network / a WebSocket; stub both so App's routing
// (the only thing under test here) renders without real I/O.
vi.mock('./api/runs', async (importActual) => ({
  ...(await importActual<typeof import('./api/runs')>()),
  listRuns: vi.fn().mockResolvedValue([]),
  getRunEvents: vi.fn().mockResolvedValue([]),
  getRun: vi.fn().mockResolvedValue({
    id: 'run_42',
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
    startedAt: 1,
    finishedAt: null,
  }),
}));
vi.mock('./pages/runs/useRunStream', async (importActual) => ({
  ...(await importActual<typeof import('./pages/runs/useRunStream')>()),
  useRunStream: vi.fn().mockReturnValue({ events: [], phase: 'connecting', error: undefined }),
}));

beforeEach(() => {
  window.location.hash = '';
});
afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = '';
});

describe('App routing', () => {
  it('renders the Runs list at #/runs', async () => {
    window.location.hash = '#/runs';
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Runs' })).toBeInTheDocument();
  });

  it('renders the run detail view at #/runs/:id and keeps Runs nav active', async () => {
    window.location.hash = '#/runs/run_42';
    render(<App />);
    // The detail heading carries the run id.
    expect(await screen.findByText('run_42')).toBeInTheDocument();
    const runsNav = screen.getByRole('link', { name: 'Runs' });
    expect(runsNav).toHaveAttribute('aria-current', 'page');
  });
});
