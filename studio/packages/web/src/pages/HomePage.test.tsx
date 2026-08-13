import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { RunSummary } from '@autonomy-studio/shared';
import { HomePage, HOME_RECENT_RUNS } from './HomePage';
import { listRuns } from '../api/runs';
import { runStatusLabel } from './runs/runStatus';
import { runDetailPath } from './runs/runPath';

vi.mock('../api/runs', async (importActual) => ({
  ...(await importActual<typeof import('../api/runs')>()),
  listRuns: vi.fn(),
}));

const listRunsMock = vi.mocked(listRuns);

afterEach(() => {
  vi.clearAllMocks();
});

function runRow(over: Partial<RunSummary> = {}): RunSummary {
  return {
    id: 'run_1',
    ownerId: 'local',
    pipelineVersionId: 'pv_1',
    triggerId: null,
    parentRunId: null,
    params: {},
    status: 'success',
    leaseUntil: null,
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_060_000,
    pipelineId: 'pl_1',
    pipelineName: 'Nightly report',
    pipelineVersion: 3,
    triggerName: null,
    cost: { kind: 'none' },
    ...over,
  } as RunSummary;
}

/** Home is rendered inside a router because every run row is a `Link`. */
function renderHome() {
  const router = createMemoryRouter([{ path: '/', element: <HomePage /> }], {
    initialEntries: ['/'],
  });
  return render(<RouterProvider router={router} />);
}

describe('HomePage', () => {
  it('renders the newest runs with pipeline name, version and status', async () => {
    listRunsMock.mockResolvedValue({
      items: [
        runRow({ id: 'run_new', pipelineName: 'Nightly report', pipelineVersion: 3 }),
        runRow({ id: 'run_old', pipelineName: 'Digest', pipelineVersion: 1, status: 'queued' }),
      ],
      nextCursor: null,
    });
    renderHome();

    expect(await screen.findByText('Nightly report v3')).toBeInTheDocument();
    expect(screen.getByText('Digest v1')).toBeInTheDocument();
    // `queued` deliberately, and it is the only status that makes this
    // assertion mean anything: its LABEL is "queued (slot)" while its enum
    // value is "queued", so rendering `r.status` raw fails here. Asserted with
    // `success`/`failure` — where label and value coincide — the test passes
    // with the shared vocabulary bypassed entirely, which is how it was first
    // written and what the mutation pass caught.
    expect(screen.getByText(runStatusLabel('queued'))).toBeInTheDocument();
    expect(screen.queryByText('queued')).not.toBeInTheDocument();

    // Server order is the rendered order — Home imposes none of its own.
    const links = screen.getAllByRole('link');
    const runLinks = links.filter((a) => a.getAttribute('href')?.includes('/runs/'));
    expect(runLinks[0]).toHaveAttribute('href', expect.stringContaining('run_new'));
  });

  it('links each row to that run’s detail route', async () => {
    listRunsMock.mockResolvedValue({ items: [runRow({ id: 'run_abc' })], nextCursor: null });
    renderHome();

    const link = await screen.findByRole('link', { name: /Nightly report v3/ });
    // Through the shared builder, not a literal path — `runDetailPath` is the
    // one place a run-detail URL is constructed, and it encodes the id.
    expect(link.getAttribute('href')).toContain(runDetailPath('run_abc'));
  });

  it('says the workspace has no runs only when the first page really returned none', async () => {
    listRunsMock.mockResolvedValue({ items: [], nextCursor: null });
    renderHome();

    expect(await screen.findByText(/No runs yet/)).toBeInTheDocument();
  });

  it('renders NEITHER rows nor the empty state while the first page is still loading', async () => {
    // The guard against manufacturing an absent fact: a pending load is not the
    // same claim as "this workspace has no runs", and defaulting the list to
    // `[]` would render the second while the first is true.
    listRunsMock.mockReturnValue(new Promise(() => {}));
    renderHome();

    expect(screen.getByText('Loading runs…')).toBeInTheDocument();
    expect(screen.queryByText(/No runs yet/)).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: '' })).not.toHaveClass('recent-runs');
  });

  it('surfaces a failed load instead of showing an empty workspace', async () => {
    listRunsMock.mockRejectedValue(new Error('boom'));
    renderHome();

    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(screen.queryByText(/No runs yet/)).not.toBeInTheDocument();
  });

  it('fetches exactly ONE page, asking for its own size and no cursor', async () => {
    listRunsMock.mockResolvedValue({
      items: [runRow(), runRow({ id: 'run_2', pipelineName: 'Digest', pipelineVersion: 1 })],
      // A server that says there ARE older runs. Home must still not walk:
      // it renders a prefix and offers no way to extend it.
      nextCursor: 'cur_1',
    });
    renderHome();
    await screen.findByText('Nightly report v3');

    expect(listRunsMock).toHaveBeenCalledTimes(1);
    // The ARGUMENTS matter, not just the count — a reader that fetched page two
    // once would satisfy a bare call-count assertion.
    const [filters, cursor, , pageSize] = listRunsMock.mock.calls[0]!;
    expect(filters).toEqual({});
    expect(cursor).toBeUndefined();
    expect(pageSize).toBe(HOME_RECENT_RUNS);
    expect(screen.queryByRole('button', { name: /older|more/i })).not.toBeInTheDocument();
  });

  it('still signposts the other hubs', async () => {
    listRunsMock.mockResolvedValue({ items: [], nextCursor: null });
    renderHome();

    for (const label of ['Author', 'Monitor', 'Manage']) {
      expect(await screen.findByRole('link', { name: label })).toBeInTheDocument();
    }
    // One `h2`, so `getByRole('heading', {name: 'Home'})` stays unambiguous.
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
  });
});
