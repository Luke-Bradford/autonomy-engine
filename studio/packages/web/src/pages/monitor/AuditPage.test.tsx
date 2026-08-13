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
  fetchWorkspaceAuditPage: vi.fn(),
}));

const pageMock = vi.mocked(api.fetchWorkspaceAuditPage);

/** One server page. `nextCursor` defaults to "this is the last page" so a test
 *  that says nothing about older entries gets the simple case. */
function page(items: WorkspaceEventRow[], nextCursor: string | null = null) {
  return { items, nextCursor };
}

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

/** The table's data rows (the header row dropped), typed so `.cells` — the
 *  cheapest way to assert a value is in the RIGHT column — is available. */
function bodyRows(): HTMLTableRowElement[] {
  return within(screen.getByRole('table')).getAllByRole('row').slice(1) as HTMLTableRowElement[];
}

beforeEach(() => {
  pageMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AuditPage (#1075)', () => {
  /**
   * #1076 — the page RENDERS the server's order and no longer reverses it. The
   * fixture is therefore descending, as `?order=desc` returns it. A page that
   * kept a client-side reverse would put the oldest row first under a "most
   * recent entry first" caption.
   */
  it('renders the log in the order the server returned it, newest first', async () => {
    pageMock.mockResolvedValue(
      page([
        row(2, 3_000, archived('Last archived')),
        row(1, 2_000, archived('First archived')),
        row(0, 1_000, CONNECT),
      ]),
    );

    renderWithRouter(<AuditPage />);

    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    const acts = bodyRows().map((tr) => tr.cells[2]!.textContent);
    expect(acts).toEqual([
      expect.stringContaining('Archived the pipeline Last archived'),
      expect.stringContaining('Archived the pipeline First archived'),
      expect.stringContaining('Connected the repository https://github.com/acme/flows.git'),
    ]);
  });

  /**
   * `seq` is the log's ordering authority, not the wall clock — the envelope's
   * docblock says so, and the server sorts on it (`pageOrderDesc(seq, id)`). The
   * page must therefore present rows in the order they arrived even when their
   * `createdAt` disagrees, or it is silently re-sorting on a field that is not
   * authoritative. The `When` column still SHOWS `createdAt`; showing it and
   * ordering by it are different things.
   */
  it('orders by append position, not by the wall clock', async () => {
    // Descending by `seq`, as the server sends it — but the wall clocks
    // DISAGREE with that order (a clock step, which SQLite happily persists).
    pageMock.mockResolvedValue(
      page([row(1, 1_000, archived('Appended second')), row(0, 9_000, archived('Appended first'))]),
    );

    renderWithRouter(<AuditPage />);

    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    expect(bodyRows().map((tr) => tr.cells[2]!.textContent)).toEqual([
      expect.stringContaining('Appended second'),
      expect.stringContaining('Appended first'),
    ]);
  });

  it('attributes each entry to the principal that caused it', async () => {
    pageMock.mockResolvedValue(page([row(0, 1_000, CONNECT)]));

    renderWithRouter(<AuditPage />);

    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    expect(bodyRows()[0]!.cells[1]!.textContent).toBe('local');
  });

  it('renders the detail line beneath the act', async () => {
    pageMock.mockResolvedValue(page([row(0, 1_000, CONNECT)]));

    renderWithRouter(<AuditPage />);

    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    expect(bodyRows()[0]!.cells[2]!.textContent).toContain('Collaboration branch studio/main.');
  });

  /* An empty log is a real state (a workspace nobody has published, archived or
     imported in), and it is NOT the same as a failed load — the page must not
     render an empty table and leave the reader to guess which it is. */
  it('says nothing has happened yet, rather than rendering an empty table', async () => {
    pageMock.mockResolvedValue(page([]));

    renderWithRouter(<AuditPage />);

    await waitFor(() =>
      expect(screen.getByText(/Nothing has happened to this workspace yet/)).toBeInTheDocument(),
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('reports a failed load as an alert instead of an empty history', async () => {
    pageMock.mockRejectedValue(new Error('network down'));

    renderWithRouter(<AuditPage />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load the audit log');
    expect(alert.textContent).toContain('network down');
    // The one thing a failed audit load must never do is read as "nothing has
    // happened" — an absent fact presented as a benign default (#473's shape).
    expect(screen.queryByText(/Nothing has happened to this workspace yet/)).toBeNull();
  });

  it('reloads on demand', async () => {
    pageMock.mockResolvedValue(page([row(0, 1_000, CONNECT)]));
    renderWithRouter(<AuditPage />);
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());

    pageMock.mockResolvedValue(page([row(1, 2_000, archived('Later')), row(0, 1_000, CONNECT)]));
    await userEvent.click(screen.getByRole('button', { name: 'Refresh audit log' }));

    await waitFor(() => expect(bodyRows()).toHaveLength(2));
    expect(pageMock).toHaveBeenCalledTimes(2);
  });

  it('threads an abort signal into the load and aborts it on unmount', async () => {
    pageMock.mockResolvedValue(page([]));
    const { unmount } = renderWithRouter(<AuditPage />);
    await waitFor(() => expect(pageMock).toHaveBeenCalled());

    const signal = pageMock.mock.calls[0]![1];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
    unmount();
    expect(signal!.aborted).toBe(true);
  });

  /**
   * #1076 — the incremental tail. Before it, the api wrapper walked to the end
   * of an append-only log on every paint; now the page asks for one page and
   * the reader asks for more.
   */
  describe('older entries (#1076)', () => {
    it('offers no control when the server said this is the whole log', async () => {
      pageMock.mockResolvedValue(page([row(0, 1_000, CONNECT)]));

      renderWithRouter(<AuditPage />);

      await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
      // A button that did nothing would make the END of the history
      // indistinguishable from a history that had stopped loading.
      expect(screen.queryByRole('button', { name: 'Load older entries' })).toBeNull();
    });

    it('appends the older page beneath what is already shown, resuming from the cursor', async () => {
      pageMock.mockResolvedValueOnce(page([row(2, 3_000, archived('Newest'))], 'cur_1'));
      renderWithRouter(<AuditPage />);
      await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());

      pageMock.mockResolvedValueOnce(page([row(1, 2_000, archived('Older'))], 'cur_2'));
      await userEvent.click(screen.getByRole('button', { name: 'Load older entries' }));

      await waitFor(() => expect(bodyRows()).toHaveLength(2));
      // APPENDED, not replaced, and beneath — older entries go after newer ones.
      expect(bodyRows().map((tr) => tr.cells[2]!.textContent)).toEqual([
        expect.stringContaining('Newest'),
        expect.stringContaining('Older'),
      ]);
      expect(pageMock.mock.calls[1]![0]).toBe('cur_1');
    });

    it('stops offering the control once the last page arrives', async () => {
      pageMock.mockResolvedValueOnce(page([row(1, 2_000, archived('Newest'))], 'cur_1'));
      renderWithRouter(<AuditPage />);
      await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());

      pageMock.mockResolvedValueOnce(page([row(0, 1_000, archived('Oldest'))], null));
      await userEvent.click(screen.getByRole('button', { name: 'Load older entries' }));

      await waitFor(() => expect(bodyRows()).toHaveLength(2));
      expect(screen.queryByRole('button', { name: 'Load older entries' })).toBeNull();
    });

    it('keeps the loaded history when an older page fails, and says which failed', async () => {
      pageMock.mockResolvedValueOnce(page([row(1, 2_000, archived('Newest'))], 'cur_1'));
      renderWithRouter(<AuditPage />);
      await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());

      pageMock.mockRejectedValueOnce(new Error('network down'));
      await userEvent.click(screen.getByRole('button', { name: 'Load older entries' }));

      const alert = await screen.findByRole('alert');
      // Worded for the failure that happened: the history on screen is real and
      // merely stops short, which is different news from having none at all.
      expect(alert.textContent).toContain('Could not load older entries');
      expect(bodyRows()).toHaveLength(1);
    });

    it('discards the accumulated tail on refresh rather than gluing it to a new head', async () => {
      pageMock.mockResolvedValueOnce(page([row(2, 3_000, archived('Newest'))], 'cur_1'));
      renderWithRouter(<AuditPage />);
      await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());

      pageMock.mockResolvedValueOnce(page([row(1, 2_000, archived('Older'))], 'cur_2'));
      await userEvent.click(screen.getByRole('button', { name: 'Load older entries' }));
      await waitFor(() => expect(bodyRows()).toHaveLength(2));

      // A refresh re-reads the FIRST page. Entries appended since the last read
      // shift the whole descending sequence, so keeping the old tail would skip
      // whatever now sits between it and the new head.
      pageMock.mockResolvedValueOnce(page([row(3, 4_000, archived('Newer still'))], 'cur_0'));
      await userEvent.click(screen.getByRole('button', { name: 'Refresh audit log' }));

      await waitFor(() => expect(bodyRows()).toHaveLength(1));
      expect(bodyRows()[0]!.cells[2]!.textContent).toContain('Newer still');
      expect(pageMock.mock.calls[2]![0]).toBeUndefined();
    });
  });
});
