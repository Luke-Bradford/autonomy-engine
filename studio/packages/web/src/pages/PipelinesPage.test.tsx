import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Pipeline, PipelineSummary } from '@autonomy-studio/shared';
import { PipelinesPage } from './PipelinesPage';
import { ApiError } from '../api/client';
import { createPipelinesStore } from '../stores/pipelinesStore';
import { renderWithRouter } from '../testing/renderWithRouter';
import { chooseRowAction, closeRowMenu } from '../testing/rowActions';
import { answerConfirm, pressInConfirm, setConfirmName } from '../testing/confirmDialog';
import * as pipelinesApi from '../api/pipelines';
import * as downloadApi from '../api/download';
import * as portabilityApi from '../api/portability';
import * as workspaceGitApi from '../api/workspaceGit';

// Mock only the network layer. Since U4 the LIST lives in `pipelinesStore`, so
// each case gets its own store — the app's singleton is shared with the Factory
// Resources pane, and a shared store shared across test cases leaks state.
vi.mock('../api/demo', async () => (await import('../testing/apiModuleMocks')).demoModuleMock());

vi.mock('../api/pipelines', async (importActual) => {
  const actual = await importActual<typeof import('../api/pipelines')>();
  return {
    ...actual,
    listPipelines: vi.fn(),
    createPipeline: vi.fn(),
    deletePipeline: vi.fn(),
    listPipelineDependents: vi.fn(),
    // #1058 — the archive half. `archiveConfirmMessage` is deliberately NOT
    // mocked: it is a pure builder and the confirm text is part of what the
    // page owes the operator, so the real one runs.
    archivePipeline: vi.fn(),
    restorePipeline: vi.fn(),
    listArchivedPipelines: vi.fn(),
    listPipelineVersionStates: vi.fn(),
    listPipelineSummaries: vi.fn(),
  };
});
vi.mock('../api/workspaceGit', async (importActual) => ({
  ...(await importActual<typeof import('../api/workspaceGit')>()),
  getWorkspaceGit: vi.fn(),
  readWorkspaceGitSync: vi.fn(),
}));

// The real `downloadTextFile` clicks an anchor, which jsdom follows on the
// NEXT TICK (its `_cannotNavigate` is always false for an `<a>`, whatever the
// `download` attribute says) and then reports as an unimplemented-navigation
// error — attributed to whichever test happens to be running by then. The
// helper's own behaviour is covered directly in `api/download.test.ts`; here
// only the fact that the page calls it, with what, is under test.
vi.mock('../api/download', async (importActual) => ({
  ...(await importActual<typeof import('../api/download')>()),
  downloadTextFile: vi.fn(),
}));
vi.mock('../api/portability', async (importActual) => ({
  ...(await importActual<typeof import('../api/portability')>()),
  exportPipeline: vi.fn(),
}));

const listMock = vi.mocked(pipelinesApi.listPipelines);
const createMock = vi.mocked(pipelinesApi.createPipeline);
const deleteMock = vi.mocked(pipelinesApi.deletePipeline);
const dependentsMock = vi.mocked(pipelinesApi.listPipelineDependents);
const NO_DEPENDENTS = {
  hasRuns: false,
  debugRunsOnly: false,
  debugRetentionDays: 7,
  triggers: [],
  callers: [],
  dynamicCallers: [],
};
const archiveMock = vi.mocked(pipelinesApi.archivePipeline);
const restoreMock = vi.mocked(pipelinesApi.restorePipeline);
const listArchivedMock = vi.mocked(pipelinesApi.listArchivedPipelines);
const downloadMock = vi.mocked(downloadApi.downloadTextFile);
const exportMock = vi.mocked(portabilityApi.exportPipeline);
const statesMock = vi.mocked(pipelinesApi.listPipelineVersionStates);
const summariesMock = vi.mocked(pipelinesApi.listPipelineSummaries);
const gitMock = vi.mocked(workspaceGitApi.getWorkspaceGit);
const syncMock = vi.mocked(workspaceGitApi.readWorkspaceGitSync);

function pipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id: 'pl_1',
    resourceId: 'res_pl1',
    ownerId: 'local',
    name: 'My pipeline',
    concurrency: null,
    folder: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** The page under a router (its Open control is a `<Link>`), on a fresh store. */
function renderPage() {
  return renderWithRouter(<PipelinesPage store={createPipelinesStore()} />, '/author/pipelines');
}

beforeEach(() => {
  listMock.mockResolvedValue([]);
  createMock.mockResolvedValue(pipeline());
  deleteMock.mockResolvedValue(undefined);
  dependentsMock.mockResolvedValue(NO_DEPENDENTS);
  archiveMock.mockResolvedValue(pipeline({ archived: true }));
  restoreMock.mockResolvedValue(pipeline());
  listArchivedMock.mockResolvedValue([]);
  downloadMock.mockReset();
  exportMock.mockReset();
  exportMock.mockResolvedValue('{"kind":"pipeline"}');
  statesMock.mockResolvedValue([]);
  summariesMock.mockResolvedValue([]);
  gitMock.mockResolvedValue(null);
  syncMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A load whose completion moment this test controls. Both archived-load race
 * tests below turn on applying loads in COMPLETION order rather than issue
 * order, which is only expressible by holding one open.
 */
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('PipelinesPage', () => {
  it('shows the empty state after loading', async () => {
    renderPage();
    expect(await screen.findByText(/No pipelines yet/i)).toBeInTheDocument();
  });

  it('lists pipelines from the API', async () => {
    listMock.mockResolvedValue([pipeline({ name: 'Nightly digest' })]);
    renderPage();
    expect(await screen.findByText('Nightly digest')).toBeInTheDocument();
  });

  /** #1569 OR37 — the grid's row facts and its URL sort. */
  describe('grid', () => {
    const summary = (pipelineId: string, over: Partial<PipelineSummary> = {}): PipelineSummary => ({
      pipelineId,
      lastRun: null,
      window: {
        days: 7,
        runs: 0,
        succeeded: 0,
        failed: 0,
        successRate: null,
        p50Ms: null,
        p95Ms: null,
      },
      triggers: { total: 0, enabled: 0, items: [] },
      nextFireAt: null,
      activities: null,
      modifiedAt: 1,
      description: '',
      annotations: [],
      ...over,
    });
    const rowNames = () =>
      screen
        .getAllByRole('row')
        .slice(1)
        .map((r) => within(r).getAllByRole('link')[0]!.textContent);

    it('shows last run, success %, triggers and the folder — and no Version column', async () => {
      listMock.mockResolvedValue([pipeline({ name: 'Nightly', folder: 'ETL' })]);
      summariesMock.mockResolvedValue([
        summary('pl_1', {
          lastRun: { runId: 'run_9', status: 'failure', startedAt: 5, finishedAt: 9 },
          window: {
            days: 7,
            runs: 5,
            succeeded: 3,
            failed: 1,
            successRate: 0.75,
            p50Ms: 1,
            p95Ms: 2,
          },
          triggers: {
            total: 2,
            enabled: 1,
            items: [
              { id: 't1', name: 'Hourly', mode: 'schedule', enabled: true },
              { id: 't2', name: 'Spare', mode: 'manual', enabled: false },
            ],
          },
        }),
      ]);
      renderPage();
      const row = await screen.findByRole('row', { name: /Nightly/ });
      await within(row).findByText('75%');
      expect(within(row).getByText('ETL /')).toBeInTheDocument();
      expect(within(row).getByRole('link', { name: /failure/ })).toHaveAttribute(
        'href',
        expect.stringContaining('run_9'),
      );
      expect(within(row).getByText('1 active / 2')).toHaveAttribute(
        'title',
        'Hourly · Schedule\nSpare · Manual (off)',
      );
      const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
      expect(headers.some((h) => /version/i.test(h ?? ''))).toBe(false);
    });

    it('sorts by a header, newest last run first, never-run rows last', async () => {
      listMock.mockResolvedValue([
        pipeline({ id: 'pl_1', name: 'Alpha' }),
        pipeline({ id: 'pl_2', resourceId: 'res_2', name: 'Beta' }),
        pipeline({ id: 'pl_3', resourceId: 'res_3', name: 'Gamma' }),
      ]);
      const run = (startedAt: number) => ({
        runId: `r${String(startedAt)}`,
        status: 'success' as const,
        startedAt,
        finishedAt: startedAt,
      });
      summariesMock.mockResolvedValue([
        summary('pl_1', { lastRun: run(10) }),
        summary('pl_2'),
        summary('pl_3', { lastRun: run(20) }),
      ]);
      renderPage();
      await screen.findAllByText('success');
      expect(rowNames()).toEqual(['Alpha', 'Beta', 'Gamma']);
      // The header's button, not the filter bar's "Last run: All" menu.
      fireEvent.click(within(screen.getByRole('table')).getByRole('button', { name: /Last run/ }));
      expect(rowNames()).toEqual(['Gamma', 'Alpha', 'Beta']);
      expect(screen.getByRole('columnheader', { name: /Last run/ })).toHaveAttribute(
        'aria-sort',
        'descending',
      );
    });

    /** #1569 OR37 slice 2 — the filter bar. */
    describe('filter bar', () => {
      const failed = { runId: 'rf', status: 'failure' as const, startedAt: 5, finishedAt: 6 };
      const ok = { runId: 'ro', status: 'success' as const, startedAt: 5, finishedAt: 6 };
      const seed = () => {
        listMock.mockResolvedValue([
          pipeline({ id: 'pl_1', name: 'Alpha', folder: 'ETL' }),
          pipeline({ id: 'pl_2', resourceId: 'res_2', name: 'Beta' }),
          pipeline({ id: 'pl_3', resourceId: 'res_3', name: 'Gamma' }),
        ]);
        summariesMock.mockResolvedValue([
          summary('pl_1', { lastRun: ok, description: 'Loads the orders feed' }),
          summary('pl_2', { lastRun: failed, annotations: ['finance'] }),
          summary('pl_3'),
        ]);
      };
      const renderAt = (query: string) =>
        renderWithRouter(
          <PipelinesPage store={createPipelinesStore()} />,
          `/author/pipelines${query}`,
        );

      it('filters by last run from the URL, and Clear brings every row back', async () => {
        seed();
        const user = userEvent.setup();
        renderAt('?last=failure');
        await screen.findByRole('button', { name: /^Last run: failure/ });
        await waitFor(() => expect(rowNames()).toEqual(['Beta']));
        await user.click(screen.getByRole('button', { name: 'Clear filters' }));
        await waitFor(() => expect(rowNames()).toEqual(['Alpha', 'Beta', 'Gamma']));
      });

      it('picks several last-run statuses from the menu, never-run included', async () => {
        seed();
        const user = userEvent.setup();
        renderAt('');
        await screen.findAllByText('failure');
        await user.click(screen.getByRole('button', { name: /^Last run: All/ }));
        await user.click(await screen.findByRole('menuitemcheckbox', { name: 'failure' }));
        await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Never run' }));
        await waitFor(() => expect(rowNames()).toEqual(['Beta', 'Gamma']));
      });

      it('searches description and annotations, and narrows by folder', async () => {
        seed();
        renderAt('?q=orders');
        await waitFor(() => expect(rowNames()).toEqual(['Alpha']));
        cleanup();
        seed();
        renderAt('?q=FINANCE');
        await waitFor(() => expect(rowNames()).toEqual(['Beta']));
        cleanup();
        seed();
        renderAt(`?folder=${encodeURIComponent('/')}`);
        await waitFor(() => expect(rowNames()).toEqual(['Beta', 'Gamma']));
      });

      it('says a filter is waiting for facts — not "no match" — while the summaries are unread', async () => {
        seed();
        const pending = deferred<PipelineSummary[]>();
        summariesMock.mockReturnValue(pending.promise);
        renderAt('?last=failure');
        expect(await screen.findByText(/Waiting for run and state facts/)).toBeInTheDocument();
        expect(screen.queryByText(/No pipelines match/)).not.toBeInTheDocument();
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
        pending.resolve([summary('pl_2', { lastRun: failed })]);
        await waitFor(() => expect(rowNames()).toEqual(['Beta']));
        expect(screen.queryByText(/Waiting for run and state facts/)).not.toBeInTheDocument();
      });

      it('says no pipeline matches once the facts are read', async () => {
        seed();
        renderAt('?last=cancelled');
        expect(await screen.findByText('No pipelines match the filters.')).toBeInTheDocument();
      });

      it('keeps Archived reachable when every pipeline is archived, and draws only Name and Modified there', async () => {
        const user = userEvent.setup();
        listArchivedMock.mockResolvedValue([pipeline({ id: 'pl_9', name: 'Retired' })]);
        renderAt('');
        await screen.findByText(/No pipelines yet/i);
        await user.click(screen.getByRole('button', { name: 'Archived' }));
        expect(await screen.findByText('Retired')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Archived' })).toHaveAttribute(
          'aria-pressed',
          'true',
        );
        expect(
          // (Name carries the sort arrow.)
          screen.getAllByRole('columnheader').map((h) => h.textContent?.replace(/[▲▼]/g, '').trim()),
        ).toEqual(['Name', 'Modified', '']);
        // The run filters are not drawn where there are no run facts.
        expect(screen.queryByRole('button', { name: /^Last run:/ })).not.toBeInTheDocument();
        expect(screen.queryByText(/No pipelines yet/i)).not.toBeInTheDocument();
      });

      it('opens the archived view from a link', async () => {
        listArchivedMock.mockResolvedValue([pipeline({ id: 'pl_9', name: 'Retired' })]);
        renderAt('?archived=1');
        expect(await screen.findByText('Retired')).toBeInTheDocument();
        expect(listArchivedMock).toHaveBeenCalledTimes(1);
      });
    });
  });

  /** #1476 OR28 slice 8 — each row's state badge. */
  describe('state column', () => {
    const repo = {
      id: 'wg_1',
      ownerId: null,
      repoUrl: 'file:///tmp/repo.git',
      collabBranch: 'main',
      workingBranch: 'feature/x',
      observedCollabHead: null,
      importedFromCommit: null,
      lastFetchAt: 1,
      lastFetchError: null,
      createdAt: 1,
      updatedAt: 1,
      state: 'ready' as const,
      hasStoredToken: false,
    };
    const badge = (name: string) => screen.findByRole('group', { name: `${name} state` });

    it('says Saved, with no version number and no live part, in a DB-only workspace', async () => {
      listMock.mockResolvedValue([pipeline({ name: 'Nightly' })]);
      statesMock.mockResolvedValue([{ pipelineId: 'pl_1', latestVersion: 2, active: null }]);
      renderPage();
      const group = await badge('Nightly');
      // #1569 — no version number on the list; it is the hover detail's.
      expect(group).toHaveTextContent(/^Saved\./);
      expect(group).not.toHaveTextContent(/v2 \(latest\)/);
      expect(group.querySelector('[data-part="live"]')).toBeNull();
      expect(syncMock).not.toHaveBeenCalled();
    });

    it('says which rows differ from live, and which are uncommitted, with a repo', async () => {
      listMock.mockResolvedValue([
        pipeline({ name: 'Behind' }),
        pipeline({ id: 'pl_2', resourceId: 'res_pl2', name: 'Current' }),
      ]);
      statesMock.mockResolvedValue([
        { pipelineId: 'pl_1', latestVersion: 3, active: { versionId: 'pv_1', version: 1 } },
        { pipelineId: 'pl_2', latestVersion: 1, active: { versionId: 'pv_2', version: 1 } },
      ]);
      gitMock.mockResolvedValue(repo);
      syncMock.mockResolvedValue({
        fetchedAt: 2,
        fetched: false,
        workingBranch: 'feature/x',
        base: null,
        baseBranch: null,
        hasUncommittedChanges: true,
        pipelines: [{ pipelineId: 'pl_1', change: 'modified' }],
        divergence: { state: 'unknown', importBase: null, collabHead: null },
      });
      renderPage();
      const behind = await badge('Behind');
      await waitFor(() =>
        expect(behind.querySelector('[data-part="git"]')).toHaveTextContent(/^uncommitted\./),
      );
      expect(behind.querySelector('[data-part="live"]')).toHaveAttribute('data-tone', 'warning');
      expect(behind.querySelector('[data-part="live"]')).toHaveTextContent(/^Live \(behind\)\./);
      const current = await badge('Current');
      expect(current.querySelector('[data-part="live"]')).toHaveTextContent(
        /^Live ✓ \(the latest version\)/,
      );
      expect(current.querySelector('[data-part="git"]')).toBeNull();
    });

    it('a failed read leaves the row without a badge, and the list intact', async () => {
      listMock.mockResolvedValue([pipeline({ name: 'Nightly' })]);
      statesMock.mockRejectedValue(new ApiError(500, 'boom'));
      renderPage();
      expect(await screen.findByText('Nightly')).toBeInTheDocument();
      await waitFor(() => expect(statesMock).toHaveBeenCalled());
      expect(screen.queryByRole('group', { name: 'Nightly state' })).toBeNull();
    });

    it('a failed re-read takes back what it can no longer back', async () => {
      listMock.mockResolvedValue([pipeline({ name: 'Nightly' })]);
      statesMock.mockResolvedValue([{ pipelineId: 'pl_1', latestVersion: 2, active: null }]);
      gitMock.mockResolvedValue(repo);
      syncMock.mockResolvedValue({
        fetchedAt: 2,
        fetched: false,
        workingBranch: 'feature/x',
        base: null,
        baseBranch: null,
        hasUncommittedChanges: true,
        pipelines: [{ pipelineId: 'pl_1', change: 'added' }],
        divergence: { state: 'unknown', importBase: null, collabHead: null },
      });
      renderPage();
      const group = await badge('Nightly');
      await waitFor(() => expect(group.querySelector('[data-part="git"]')).not.toBeNull());
      syncMock.mockRejectedValue(new ApiError(500, 'boom'));
      window.dispatchEvent(new Event('focus'));
      await waitFor(() => expect(group.querySelector('[data-part="git"]')).toBeNull());
      expect(group.querySelector('[data-part="live"]')).toHaveTextContent(/^Not published/);
      gitMock.mockRejectedValue(new ApiError(500, 'boom'));
      window.dispatchEvent(new Event('focus'));
      await waitFor(() => expect(group.querySelector('[data-part="live"]')).toBeNull());
      statesMock.mockRejectedValue(new ApiError(500, 'boom'));
      window.dispatchEvent(new Event('focus'));
      await waitFor(() =>
        expect(screen.queryByRole('group', { name: 'Nightly state' })).toBeNull(),
      );
    });

    it('re-reads on focus, where a save in another tab shows up', async () => {
      listMock.mockResolvedValue([pipeline({ name: 'Nightly' })]);
      statesMock.mockResolvedValue([{ pipelineId: 'pl_1', latestVersion: null, active: null }]);
      renderPage();
      expect(await badge('Nightly')).toHaveTextContent(/^Not saved/);
      statesMock.mockResolvedValue([{ pipelineId: 'pl_1', latestVersion: 1, active: null }]);
      const summaryReads = summariesMock.mock.calls.length;
      window.dispatchEvent(new Event('focus'));
      await waitFor(async () => expect(await badge('Nightly')).toHaveTextContent(/^Saved/));
      // The grid's row facts are re-read with the row states (#1569).
      expect(summariesMock.mock.calls.length).toBeGreaterThan(summaryReads);
    });
  });

  it('creates a pipeline with the entered name and refreshes', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/No pipelines yet/i);
    const form = within(screen.getByRole('form', { name: /New pipeline/i }));
    await user.type(form.getByLabelText('Name'), 'Fresh');
    await user.click(form.getByRole('button', { name: /Create pipeline/i }));

    await waitFor(() => expect(createMock).toHaveBeenCalledWith({ name: 'Fresh' }));
    // Refresh after create: listPipelines called again (mount + post-create).
    // That refresh is also what keeps the Factory Resources pane — mounted
    // beside this page over the same store — from showing a stale tree.
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it('does not create when the name is blank', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/No pipelines yet/i);
    const form = within(screen.getByRole('form', { name: /New pipeline/i }));
    await user.click(form.getByRole('button', { name: /Create pipeline/i }));
    expect(createMock).not.toHaveBeenCalled();
  });

  /**
   * #1058 — archive is the only way to retire a pipeline that has ever run, and
   * the archived section is the only way back. Both halves, plus the load-status
   * honesty the section needs to be a real recovery surface.
   */
  describe('#1058 archive and the way back', () => {
    it('archives after confirmation, naming the consequences in the confirm', async () => {
      const user = userEvent.setup();
      listMock.mockResolvedValue([pipeline({ name: 'Nightly digest' })]);
      renderPage();

      await chooseRowAction(user, 'Nightly digest', 'Archive');
      // The confirm is where every consequence is named — the route discards
      // the trigger ids it disabled, so nothing can be reported afterwards.
      const asked = await answerConfirm(user, 'accept');

      await waitFor(() => expect(archiveMock).toHaveBeenCalledWith('pl_1'));
      expect(asked).toContain('Nightly digest');
      expect(asked).toMatch(/run history are KEPT/i);
      expect(asked).toContain('triggers stay disabled');
      expect(asked).toMatch(/Commit will delete its file/);
      // The live list refreshes: the row has left it, and the Factory Resources
      // pane shares that store.
      await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    });

    it('does not archive when the confirmation is declined', async () => {
      const user = userEvent.setup();
      listMock.mockResolvedValue([pipeline({ name: 'Nightly digest' })]);
      renderPage();

      await chooseRowAction(user, 'Nightly digest', 'Archive');
      await answerConfirm(user, 'cancel');
      expect(archiveMock).not.toHaveBeenCalled();
    });

    // Escape answers Cancel (#1397): dismissing the dialog is never a yes.
    it('does not archive when the dialog is dismissed with Escape', async () => {
      const user = userEvent.setup();
      listMock.mockResolvedValue([pipeline({ name: 'Nightly digest' })]);
      renderPage();

      await chooseRowAction(user, 'Nightly digest', 'Archive');
      await screen.findByRole('alertdialog');
      pressInConfirm('Escape');
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());

      expect(archiveMock).not.toHaveBeenCalled();
      expect(
        screen.getByRole('button', { name: 'Actions for Nightly digest' }),
      ).toBeInTheDocument();
    });

    it('fetches the archived set only when the section is opened', async () => {
      const user = userEvent.setup();
      listArchivedMock.mockResolvedValue([pipeline({ id: 'pl_9', name: 'Retired' })]);
      renderPage();

      // Closed: no request at all. A recovery surface nobody opened must not
      // cost a round-trip on every visit to the page.
      await screen.findByText(/No pipelines yet/i);
      expect(listArchivedMock).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Archived' }));
      expect(await screen.findByText('Retired')).toBeInTheDocument();
      expect(listArchivedMock).toHaveBeenCalledTimes(1);
    });

    it('unarchives from the archived list and refreshes BOTH lists', async () => {
      const user = userEvent.setup();
      listArchivedMock.mockResolvedValue([pipeline({ id: 'pl_9', name: 'Retired' })]);
      renderPage();
      await screen.findByText(/No pipelines yet/i);
      await user.click(screen.getByRole('button', { name: 'Archived' }));

      await chooseRowAction(user, 'Retired', 'Unarchive');

      await waitFor(() => expect(restoreMock).toHaveBeenCalledWith('pl_9'));
      // The row leaves the archived list and rejoins the live one, so both are
      // re-read — a stale live list would hide the pipeline just recovered.
      await waitFor(() => expect(listArchivedMock).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    });

    it('reports a failed archived load AS a failure, never as an empty list', async () => {
      const user = userEvent.setup();
      listArchivedMock.mockRejectedValue(new Error('server down'));
      renderPage();
      await screen.findByText(/No pipelines yet/i);

      await user.click(screen.getByRole('button', { name: 'Archived' }));

      // The lie this guards against: "No archived pipelines" over a load that
      // never answered tells the operator their pipeline is gone, on the ONE
      // surface that exists to bring it back.
      expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load archived/i);
      expect(screen.queryByText(/No archived pipelines/i)).not.toBeInTheDocument();

      // And the failure is not a dead end.
      listArchivedMock.mockResolvedValue([pipeline({ id: 'pl_9', name: 'Retired' })]);
      await user.click(screen.getByRole('button', { name: /Retry loading archived/i }));
      expect(await screen.findByText('Retired')).toBeInTheDocument();
    });

    it('drops a SUPERSEDED archived load, so a stale answer cannot overwrite a fresh one', async () => {
      const user = userEvent.setup();
      listMock.mockResolvedValue([pipeline({ name: 'Nightly digest' })]);

      // Two loads whose completion order is controlled here, because that is
      // the whole defect: they apply in COMPLETION order, not issue order.
      const first = deferred<Pipeline[]>();
      const second = deferred<Pipeline[]>();
      listArchivedMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

      renderPage();

      // 1. Open — load #1 starts, carrying a view from BEFORE the archive below.
      await user.click(await screen.findByRole('button', { name: 'Archived' }));
      // 2. Close before it answers, 3. archive (invalidating the cache),
      //    4. reopen — load #2 starts and is the only correct answer.
      await user.click(screen.getByRole('button', { name: 'Archived' }));
      await chooseRowAction(user, 'Nightly digest', 'Archive');
      await answerConfirm(user, 'accept');
      await waitFor(() => expect(archiveMock).toHaveBeenCalled());
      await user.click(screen.getByRole('button', { name: 'Archived' }));

      // 5. The fresher load lands first and is right.
      second.resolve([pipeline({ id: 'pl_9', name: 'Retired' })]);
      expect(await screen.findByText('Retired')).toBeInTheDocument();

      // 6. The STALE load finally answers, with a list from before the archive.
      first.resolve([]);

      // It must be dropped. Without the guard the section overwrites itself
      // with "No archived pipelines" — the exact lie the status triple exists
      // to prevent, on the ONE surface that is the way back out of archive, and
      // nothing refetches to self-correct.
      await waitFor(() => expect(listArchivedMock).toHaveBeenCalledTimes(2));
      expect(screen.queryByText(/No archived pipelines/i)).not.toBeInTheDocument();
      expect(screen.getByText('Retired')).toBeInTheDocument();
    });

    it('supersedes an in-flight load when an archive invalidates the CLOSED section', async () => {
      const user = userEvent.setup();
      listMock.mockResolvedValue([pipeline({ name: 'Nightly digest' })]);

      // The load is still in flight when the section is closed, and nothing
      // reopens it before it answers — so unlike the case above, no SECOND
      // load exists to move the counter past it.
      const inFlight = deferred<Pipeline[]>();
      listArchivedMock.mockReturnValueOnce(inFlight.promise);
      renderPage();

      await user.click(await screen.findByRole('button', { name: 'Archived' }));
      await waitFor(() => expect(listArchivedMock).toHaveBeenCalledTimes(1));
      await user.click(screen.getByRole('button', { name: 'Archived' }));

      await chooseRowAction(user, 'Nightly digest', 'Archive');
      await answerConfirm(user, 'accept');
      await waitFor(() => expect(archiveMock).toHaveBeenCalled());

      // Only NOW does the pre-archive load answer. Invalidation has to have
      // superseded it: if it is allowed to land it writes `ready` over the
      // `idle` the archive just set, and reopening then sees a non-idle status
      // and never refetches — permanently hiding the pipeline just archived
      // from the ONE surface that is the way back to it.
      inFlight.resolve([]);
      listArchivedMock.mockResolvedValue([pipeline({ name: 'Nightly digest', archived: true })]);

      await user.click(screen.getByRole('button', { name: 'Archived' }));
      // In the archived view, a row's menu is the archived row's.
      expect(
        await screen.findByRole('button', { name: 'Actions for Nightly digest' }),
      ).toBeInTheDocument();
      expect(listArchivedMock).toHaveBeenCalledTimes(2);
    });

    it('loads the archived set when a REOPEN races an in-flight archive', async () => {
      const user = userEvent.setup();
      listMock.mockResolvedValue([pipeline({ name: 'Nightly digest' })]);

      const firstLoad = deferred<Pipeline[]>();
      listArchivedMock.mockReturnValueOnce(firstLoad.promise);
      const archiving = deferred<Pipeline>();
      archiveMock.mockReturnValueOnce(archiving.promise);
      renderPage();

      // Open (load A starts), close, then archive — which reads `showArchived`
      // as false at CLICK time and holds that value across its awaits.
      await user.click(await screen.findByRole('button', { name: 'Archived' }));
      await waitFor(() => expect(listArchivedMock).toHaveBeenCalledTimes(1));
      await user.click(screen.getByRole('button', { name: 'Archived' }));
      await chooseRowAction(user, 'Nightly digest', 'Archive');
      await answerConfirm(user, 'accept');

      // Reopen while the archive is still in flight. Load A is still 'loading',
      // so an open that only fetches on the CLICK cannot fetch here.
      await user.click(screen.getByRole('button', { name: 'Archived' }));

      listArchivedMock.mockResolvedValue([pipeline({ name: 'Nightly digest', archived: true })]);
      archiving.resolve(pipeline({ archived: true }));
      firstLoad.resolve([]);

      // The archive lands last and invalidates the set. The section is OPEN by
      // then, so it has to load: otherwise it sits at `idle` while open, which
      // renders no rows, no error and no "Loading…" — a blank section that
      // nothing refetches, hiding the pipeline just archived.
      // In the archived view, a row's menu is the archived row's.
      expect(
        await screen.findByRole('button', { name: 'Actions for Nightly digest' }),
      ).toBeInTheDocument();
    });

    it('re-reads the archived set after an archive performed while it was closed', async () => {
      const user = userEvent.setup();
      listMock.mockResolvedValue([pipeline({ name: 'Nightly digest' })]);
      renderPage();

      // Open, then close — so a naive "fetch once" would now be holding a list
      // that predates the archive below.
      await user.click(await screen.findByRole('button', { name: 'Archived' }));
      await waitFor(() => expect(listArchivedMock).toHaveBeenCalledTimes(1));
      await user.click(screen.getByRole('button', { name: 'Archived' }));

      await chooseRowAction(user, 'Nightly digest', 'Archive');
      await answerConfirm(user, 'accept');
      await waitFor(() => expect(archiveMock).toHaveBeenCalled());
      // Still closed, so still no second request.
      expect(listArchivedMock).toHaveBeenCalledTimes(1);

      listArchivedMock.mockResolvedValue([pipeline({ name: 'Nightly digest', archived: true })]);
      await user.click(screen.getByRole('button', { name: 'Archived' }));
      // The row just archived is THERE, because opening refetched.
      // In the archived view, a row's menu is the archived row's.
      expect(
        await screen.findByRole('button', { name: 'Actions for Nightly digest' }),
      ).toBeInTheDocument();
    });

    /**
     * A SUCCESSFUL archive must never be reported as a failed one. The handler
     * wraps its follow-up reads in the same try/catch as the mutation, so the
     * only thing keeping "Could not archive" honest is that neither follow-up
     * can reject: `pipelinesStore.refresh` says so in its contract, and
     * `loadArchived` reports its own failure into the section's status.
     *
     * Both are non-local to the handler, which is exactly why they are pinned
     * here — the day either starts rejecting, the operator is told their
     * archive failed when the row is already gone, and the recovery surface is
     * the one place that lie is expensive.
     */
    it('reports a follow-up READ failure as itself, not as a failed archive', async () => {
      const user = userEvent.setup();
      listMock.mockResolvedValue([pipeline({ name: 'Nightly digest' })]);
      const archiving = deferred<Pipeline>();
      archiveMock.mockReturnValueOnce(archiving.promise);
      renderPage();

      await chooseRowAction(user, 'Nightly digest', 'Archive');
      await answerConfirm(user, 'accept');
      await waitFor(() => expect(archiveMock).toHaveBeenCalledWith('pl_1'));

      // The archived view OPEN by the time the archive lands (it replaces the
      // live list, so it cannot be open when the archive starts), so the
      // archive's follow-up takes the `loadArchived` branch.
      await user.click(screen.getByRole('button', { name: 'Archived' }));
      await waitFor(() => expect(listArchivedMock).toHaveBeenCalledTimes(1));

      // Both follow-up reads fail: the live refresh AND the archived reload.
      listMock.mockRejectedValue(new Error('live list down'));
      listArchivedMock.mockRejectedValue(new Error('archived list down'));
      archiving.resolve(pipeline({ archived: true }));

      expect(await screen.findByText(/Could not load archived pipelines/i)).toBeInTheDocument();
      expect(screen.getByText(/live list down/i)).toBeInTheDocument();
      // The archive itself SUCCEEDED, so nothing may say otherwise.
      expect(screen.queryByText(/Could not archive/i)).not.toBeInTheDocument();
    });

    it('reports a follow-up READ failure as itself, not as a failed unarchive', async () => {
      const user = userEvent.setup();
      listArchivedMock.mockResolvedValue([pipeline({ id: 'pl_9', name: 'Retired' })]);
      renderPage();
      await screen.findByText(/No pipelines yet/i);
      await user.click(screen.getByRole('button', { name: 'Archived' }));

      listMock.mockRejectedValue(new Error('live list down'));
      listArchivedMock.mockRejectedValue(new Error('archived list down'));

      await chooseRowAction(user, 'Retired', 'Unarchive');

      await waitFor(() => expect(restoreMock).toHaveBeenCalledWith('pl_9'));
      expect(await screen.findByText(/Could not load archived pipelines/i)).toBeInTheDocument();
      expect(screen.queryByText(/Could not unarchive/i)).not.toBeInTheDocument();
    });
  });

  it('deletes a pipeline after confirmation', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([pipeline({ name: 'Doomed' })]);
    renderPage();
    await chooseRowAction(user, 'Doomed', 'Delete');
    await answerConfirm(user, 'accept');
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('pl_1'));
  });

  // #1470 — the row and its ⋯ unmount with the delete; focus goes to the next
  // row's ⋯ rather than to <body>, and to the New pipeline name when none is left.
  it("hands focus to the next row's ⋯ after a confirmed delete", async () => {
    const user = userEvent.setup();
    const kept = pipeline({ id: 'pl_2', name: 'Kept' });
    listMock.mockResolvedValue([pipeline({ name: 'Doomed' }), kept]);
    renderPage();
    await screen.findByText('Kept');
    listMock.mockResolvedValue([kept]);
    await chooseRowAction(user, 'Doomed', 'Delete');
    await answerConfirm(user, 'accept');
    await waitFor(() => expect(screen.queryByText('Doomed')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Actions for Kept' })).toHaveFocus(),
    );
  });

  it('hands focus to the New pipeline name after archiving the last pipeline', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([pipeline({ name: 'Only' })]);
    renderPage();
    await screen.findByText('Only');
    listMock.mockResolvedValue([]);
    await chooseRowAction(user, 'Only', 'Archive');
    await answerConfirm(user, 'accept');
    const form = screen.getByRole('form', { name: 'New pipeline' });
    await waitFor(() => expect(within(form).getByLabelText('Name')).toHaveFocus());
  });

  // #1470 — the row's ⋯ still works while its delete is in flight; Delete
  // again must not ask a second time (accepting that would 404 into the banner).
  it("asks once while the row's delete is in flight", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([pipeline({ name: 'Doomed' })]);
    let release: () => void = () => {};
    deleteMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    renderPage();
    await screen.findByText('Doomed');
    await chooseRowAction(user, 'Doomed', 'Delete');
    await answerConfirm(user, 'accept');
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    await chooseRowAction(user, 'Doomed', 'Delete');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    release();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });

  it('shows a friendly message when deleting a pipeline that has runs (409)', async () => {
    const user = userEvent.setup();
    deleteMock.mockRejectedValue(new ApiError(409, 'pipeline has runs'));
    listMock.mockResolvedValue([pipeline({ name: 'Busy' })]);
    renderPage();
    await chooseRowAction(user, 'Busy', 'Delete');
    await answerConfirm(user, 'accept');
    expect(await screen.findByText(/it has run history/i)).toBeInTheDocument();
  });

  it('#1397 — names the triggers the delete takes with it, and asks for the name first', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([pipeline({ name: 'Doomed' })]);
    dependentsMock.mockResolvedValue({
      ...NO_DEPENDENTS,
      triggers: [{ id: 't1', name: 'At 2am' }],
    });
    renderPage();
    await chooseRowAction(user, 'Doomed', 'Delete');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('also deletes 1 trigger bound to it (At 2am)');
    // Typing the name is what arms Delete.
    const del = within(dialog).getByRole('button', { name: 'Delete' });
    expect(del).toBeDisabled();
    setConfirmName('Doomed', 'Doomed');
    expect(del).toBeEnabled();
    await user.click(del);
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('pl_1'));
  });

  it('#1397 — run history refuses up front: no question, no delete, and focus back on ⋯', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([pipeline({ name: 'Busy' })]);
    dependentsMock.mockResolvedValue({ ...NO_DEPENDENTS, hasRuns: true });
    renderPage();
    await chooseRowAction(user, 'Busy', 'Delete');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cannot delete “Busy”: it has run history. Archive it instead',
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(document.activeElement).toHaveAccessibleName('Actions for Busy');
  });

  it('does not delete when confirmation is declined', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([pipeline({ name: 'Safe' })]);
    renderPage();
    await chooseRowAction(user, 'Safe', 'Delete');
    await answerConfirm(user, 'cancel');
    expect(deleteMock).not.toHaveBeenCalled();
  });

  /**
   * U4 moved the open pipeline into the URL. Open used to be a BUTTON that
   * swapped this page for the canvas in local state, which meant the canvas had
   * no address to link to, bookmark, or come Back from.
   */
  it('opens a pipeline through a LINK to its own route, encoding the id', async () => {
    listMock.mockResolvedValue([pipeline({ id: 'pl/1', name: 'Editable' })]);
    renderPage();
    const open = await screen.findByRole('link', { name: /Open Editable/i });
    expect(open).toHaveAttribute('href', '/author/pipelines/pl%2F1');
  });

  it('exports a pipeline to a file named after it AND its id', async () => {
    const user = userEvent.setup();
    exportMock.mockResolvedValue('{"canonical":"bytes"}');
    listMock.mockResolvedValue([pipeline({ id: 'pl_7', name: 'Nightly digest' })]);
    renderPage();

    await chooseRowAction(user, 'Nightly digest', 'Export');

    await waitFor(() => expect(exportMock).toHaveBeenCalledWith('pl_7'));
    // The bytes go to disk untouched — an export is a canonical artifact.
    expect(downloadMock).toHaveBeenCalledWith(
      'pipeline-nightly-digest-pl_7.json',
      '{"canonical":"bytes"}',
    );
  });

  /**
   * #960 — the AFFORDANCE half. The correctness half (two clicks in one tick,
   * before React re-renders) is proved in `hooks/useBusyAction.test.ts`, and
   * deliberately NOT here: `user.click` does not dispatch on a natively
   * disabled button, so a click-twice test through this page would stay green
   * with the ref guard deleted and would certify nothing.
   */
  it('disables the Export item for THAT row while its export is in flight', async () => {
    const user = userEvent.setup();
    const gate = deferred<string>();
    exportMock.mockReturnValue(gate.promise);
    listMock.mockResolvedValue([
      pipeline({ id: 'pl_7', name: 'Nightly digest' }),
      pipeline({ id: 'pl_8', name: 'Other' }),
    ]);
    renderPage();

    const openExport = async (row: string) => {
      await user.click(await screen.findByRole('button', { name: `Actions for ${row}` }));
      return screen.findByRole('menuitem', { name: 'Export' });
    };

    const idle = await openExport('Nightly digest');
    expect(idle).not.toHaveAttribute('aria-disabled', 'true');
    await user.click(idle);
    await waitFor(() => expect(exportMock).toHaveBeenCalledWith('pl_7'));
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());

    // Reopen the row's menu: its Export is busy while the request is in flight.
    expect(await openExport('Nightly digest')).toHaveAttribute('aria-disabled', 'true');
    await closeRowMenu(user);

    // Keyed by row, not page-wide: a second pipeline stays exportable, which is
    // why this is a Set rather than one busy flag.
    expect(await openExport('Other')).not.toHaveAttribute('aria-disabled', 'true');
    await closeRowMenu(user);

    gate.resolve('{"canonical":"bytes"}');
    expect(await openExport('Nightly digest')).not.toHaveAttribute('aria-disabled', 'true');
    await closeRowMenu(user);
  });

  it('reports a failed export instead of saving the error body to disk', async () => {
    const user = userEvent.setup();
    exportMock.mockRejectedValue(new ApiError(404, 'pipeline "pl_1" not found'));
    listMock.mockResolvedValue([pipeline({ name: 'Gone' })]);
    renderPage();

    await chooseRowAction(user, 'Gone', 'Export');

    expect(await screen.findByText(/Could not export “Gone”.*not found/)).toBeInTheDocument();
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('offers the import surface', async () => {
    renderPage();
    expect(await screen.findByLabelText('Export file')).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    listMock.mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(/boom/i);
  });

  it('does not claim "no pipelines yet" when the load FAILED', async () => {
    listMock.mockRejectedValue(new Error('boom'));
    renderPage();
    await screen.findByRole('alert');
    expect(screen.queryByText(/No pipelines yet/i)).not.toBeInTheDocument();
  });

  /**
   * #761 — re-entering the page retries a load that failed.
   *
   * This page DOES unmount on navigation, unlike the Author pane, so it looks
   * like it should recover for free. It did not: `ensureFresh` skips a failed
   * load by design, which defeated the fresh mount on its own and left the
   * banner up on every return until Retry or a browser reload.
   *
   * Both renders share ONE store deliberately — `renderPage`'s fresh-store-per-
   * case isolation is what a re-entry must NOT have, since the whole defect
   * lives in the state carried across the unmount.
   */
  it('retries a FAILED load when the page is re-entered', async () => {
    const store = createPipelinesStore();
    listMock.mockRejectedValueOnce(new Error('boom'));

    const first = renderWithRouter(<PipelinesPage store={store} />, '/author/pipelines');
    expect(await screen.findByRole('alert')).toHaveTextContent(/boom/i);
    first.unmount();

    listMock.mockResolvedValueOnce([pipeline()]);
    renderWithRouter(<PipelinesPage store={store} />, '/author/pipelines');

    expect(await screen.findByText('My pipeline')).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
