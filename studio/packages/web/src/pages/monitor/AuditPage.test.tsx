import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceEventRowSchema, type WorkspaceEventRow } from '@autonomy-studio/shared';
import { AuditPage } from './AuditPage';
import * as api from '../../api/workspaceAudit';
import { renderWithRouter } from '../../testing/renderWithRouter';

// Only the network call is mocked. `describeWorkspaceEvent` and
// `WorkspaceEventRowSchema` stay REAL, so what these tests read is the wording
// and the row shape the page actually ships.
vi.mock('../../api/workspaceAudit', async (importActual) => ({
  ...(await importActual<typeof import('../../api/workspaceAudit')>()),
  listWorkspaceAudit: vi.fn(),
}));

const listMock = vi.mocked(api.listWorkspaceAudit);

/** Parsed through the real row schema — a fixture the server could not send is
 *  not a fixture worth asserting page behaviour against. */
function row(seq: number, createdAt: number, payload: unknown): WorkspaceEventRow {
  return WorkspaceEventRowSchema.parse({
    id: `wse_${seq}`,
    ownerId: 'local',
    seq,
    type: (payload as { type: string }).type,
    payload,
    createdAt,
  });
}

const CONNECT = {
  type: 'repo.connected',
  repoUrl: 'https://github.com/acme/flows.git',
  collabBranch: 'studio/main',
  by: 'local',
};

function archived(name: string) {
  return {
    type: 'pipeline.archived',
    resourceId: `res_${name}`,
    name,
    disabledTriggerIds: ['trg_1'],
    by: 'local',
  };
}

function bodyRows() {
  return within(screen.getByRole('table')).getAllByRole('row').slice(1);
}

beforeEach(() => {
  listMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AuditPage (#1075)', () => {
  it('renders the log NEWEST FIRST, reversing the append order the api returns', async () => {
    // Append order: oldest `seq` first, exactly as `GET /api/workspace/audit`
    // returns it (`pageOrder` is `asc(seq), asc(id)`).
    listMock.mockResolvedValue([
      row(0, 1_000, CONNECT),
      row(1, 2_000, archived('First archived')),
      row(2, 3_000, archived('Last archived')),
    ]);

    renderWithRouter(<AuditPage />);

    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    const acts = bodyRows().map((tr) => tr.cells[2].textContent);
    expect(acts).toEqual([
      expect.stringContaining('Archived the pipeline Last archived'),
      expect.stringContaining('Archived the pipeline First archived'),
      expect.stringContaining('Connected the repository https://github.com/acme/flows.git'),
    ]);
  });

  /**
   * `seq` is the log's ordering authority, not the wall clock — the envelope's
   * docblock says so, and the api wrapper's reversal rests on it. A row whose
   * `createdAt` disagrees with its `seq` (a clock step, which SQLite will
   * happily persist) must still render in append order reversed, or the page is
   * silently re-sorting on a field that is not authoritative.
   */
  it('orders by append position, not by the wall clock', async () => {
    listMock.mockResolvedValue([
      row(0, 9_000, archived('Appended first')),
      row(1, 1_000, archived('Appended second')),
    ]);

    renderWithRouter(<AuditPage />);

    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    expect(bodyRows().map((tr) => tr.cells[2].textContent)).toEqual([
      expect.stringContaining('Appended second'),
      expect.stringContaining('Appended first'),
    ]);
  });

  it('attributes each entry to the principal that caused it', async () => {
    listMock.mockResolvedValue([row(0, 1_000, CONNECT)]);

    renderWithRouter(<AuditPage />);

    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    expect(bodyRows()[0].cells[1].textContent).toBe('local');
  });

  it('renders the detail line beneath the act', async () => {
    listMock.mockResolvedValue([row(0, 1_000, CONNECT)]);

    renderWithRouter(<AuditPage />);

    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    expect(bodyRows()[0].cells[2].textContent).toContain('Collaboration branch studio/main.');
  });

  /* An empty log is a real state (a workspace nobody has published, archived or
     imported in), and it is NOT the same as a failed load — the page must not
     render an empty table and leave the reader to guess which it is. */
  it('says nothing has happened yet, rather than rendering an empty table', async () => {
    listMock.mockResolvedValue([]);

    renderWithRouter(<AuditPage />);

    await waitFor(() =>
      expect(screen.getByText(/Nothing has happened to this workspace yet/)).toBeInTheDocument(),
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('reports a failed load as an alert instead of an empty history', async () => {
    listMock.mockRejectedValue(new Error('network down'));

    renderWithRouter(<AuditPage />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load the audit log');
    expect(alert.textContent).toContain('network down');
    // The one thing a failed audit load must never do is read as "nothing has
    // happened" — an absent fact presented as a benign default (#473's shape).
    expect(screen.queryByText(/Nothing has happened to this workspace yet/)).toBeNull();
  });

  it('reloads on demand', async () => {
    listMock.mockResolvedValue([row(0, 1_000, CONNECT)]);
    renderWithRouter(<AuditPage />);
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());

    listMock.mockResolvedValue([row(0, 1_000, CONNECT), row(1, 2_000, archived('Later'))]);
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(bodyRows()).toHaveLength(2));
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  /**
   * The page has no mutations, so it uses `usePolledResource`, whose contract
   * is that the fetcher receives an `AbortSignal` and the load is aborted on
   * unmount. Pinned because the alternative hook (`useGuardedLoad`) has the
   * OPPOSITE drop rule, and swapping them is silent at runtime.
   */
  it('threads an abort signal into the load and aborts it on unmount', async () => {
    listMock.mockResolvedValue([]);
    const { unmount } = renderWithRouter(<AuditPage />);
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    const signal = listMock.mock.calls[0][0];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
    unmount();
    expect(signal!.aborted).toBe(true);
  });
});
