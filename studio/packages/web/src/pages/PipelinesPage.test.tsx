import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Pipeline } from '@autonomy-studio/shared';
import { PipelinesPage } from './PipelinesPage';
import { ApiError } from '../api/client';
import { createPipelinesStore } from '../stores/pipelinesStore';
import { renderWithRouter } from '../testing/renderWithRouter';
import * as pipelinesApi from '../api/pipelines';
import * as downloadApi from '../api/download';
import * as portabilityApi from '../api/portability';

// Mock only the network layer. Since U4 the LIST lives in `pipelinesStore`, so
// each case gets its own store — the app's singleton is shared with the Factory
// Resources pane, and a shared store shared across test cases leaks state.
vi.mock('../api/pipelines', async (importActual) => {
  const actual = await importActual<typeof import('../api/pipelines')>();
  return {
    ...actual,
    listPipelines: vi.fn(),
    createPipeline: vi.fn(),
    deletePipeline: vi.fn(),
    // #1058 — the archive half. `archiveConfirmMessage` is deliberately NOT
    // mocked: it is a pure builder and the confirm text is part of what the
    // page owes the operator, so the real one runs.
    archivePipeline: vi.fn(),
    restorePipeline: vi.fn(),
    listArchivedPipelines: vi.fn(),
  };
});

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
const archiveMock = vi.mocked(pipelinesApi.archivePipeline);
const restoreMock = vi.mocked(pipelinesApi.restorePipeline);
const listArchivedMock = vi.mocked(pipelinesApi.listArchivedPipelines);
const downloadMock = vi.mocked(downloadApi.downloadTextFile);
const exportMock = vi.mocked(portabilityApi.exportPipeline);

function pipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id: 'pl_1',
    resourceId: 'res_pl1',
    ownerId: 'local',
    name: 'My pipeline',
    concurrency: null,
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
  archiveMock.mockResolvedValue(pipeline({ archived: true }));
  restoreMock.mockResolvedValue(pipeline());
  listArchivedMock.mockResolvedValue([]);
  downloadMock.mockReset();
  exportMock.mockReset();
  exportMock.mockResolvedValue('{"kind":"pipeline"}');
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
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      listMock.mockResolvedValue([pipeline({ name: 'Nightly digest' })]);
      renderPage();

      await user.click(await screen.findByRole('button', { name: 'Archive Nightly digest' }));

      await waitFor(() => expect(archiveMock).toHaveBeenCalledWith('pl_1'));
      // The confirm is where every consequence is named — the route discards
      // the trigger ids it disabled, so nothing can be reported afterwards.
      const asked = confirmSpy.mock.calls[0]![0] as string;
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
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      listMock.mockResolvedValue([pipeline({ name: 'Nightly digest' })]);
      renderPage();

      await user.click(await screen.findByRole('button', { name: 'Archive Nightly digest' }));
      expect(archiveMock).not.toHaveBeenCalled();
    });

    it('fetches the archived set only when the section is opened', async () => {
      const user = userEvent.setup();
      listArchivedMock.mockResolvedValue([pipeline({ id: 'pl_9', name: 'Retired' })]);
      renderPage();

      // Closed: no request at all. A recovery surface nobody opened must not
      // cost a round-trip on every visit to the page.
      await screen.findByText(/No pipelines yet/i);
      expect(listArchivedMock).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: /Show archived/i }));
      expect(await screen.findByText('Retired')).toBeInTheDocument();
      expect(listArchivedMock).toHaveBeenCalledTimes(1);
    });

    it('unarchives from the archived list and refreshes BOTH lists', async () => {
      const user = userEvent.setup();
      listArchivedMock.mockResolvedValue([pipeline({ id: 'pl_9', name: 'Retired' })]);
      renderPage();
      await screen.findByText(/No pipelines yet/i);
      await user.click(screen.getByRole('button', { name: /Show archived/i }));

      await user.click(await screen.findByRole('button', { name: 'Unarchive Retired' }));

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

      await user.click(screen.getByRole('button', { name: /Show archived/i }));

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
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      listMock.mockResolvedValue([pipeline({ name: 'Nightly digest' })]);

      // Two loads whose completion order is controlled here, because that is
      // the whole defect: they apply in COMPLETION order, not issue order.
      const first = deferred<Pipeline[]>();
      const second = deferred<Pipeline[]>();
      listArchivedMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

      renderPage();

      // 1. Open — load #1 starts, carrying a view from BEFORE the archive below.
      await user.click(await screen.findByRole('button', { name: /Show archived/i }));
      // 2. Close before it answers, 3. archive (invalidating the cache),
      //    4. reopen — load #2 starts and is the only correct answer.
      await user.click(screen.getByRole('button', { name: /Hide archived/i }));
      await user.click(screen.getByRole('button', { name: 'Archive Nightly digest' }));
      await waitFor(() => expect(archiveMock).toHaveBeenCalled());
      await user.click(screen.getByRole('button', { name: /Show archived/i }));

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
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      listMock.mockResolvedValue([pipeline({ name: 'Nightly digest' })]);

      // The load is still in flight when the section is closed, and nothing
      // reopens it before it answers — so unlike the case above, no SECOND
      // load exists to move the counter past it.
      const inFlight = deferred<Pipeline[]>();
      listArchivedMock.mockReturnValueOnce(inFlight.promise);
      renderPage();

      await user.click(await screen.findByRole('button', { name: /Show archived/i }));
      await waitFor(() => expect(listArchivedMock).toHaveBeenCalledTimes(1));
      await user.click(screen.getByRole('button', { name: /Hide archived/i }));

      await user.click(screen.getByRole('button', { name: 'Archive Nightly digest' }));
      await waitFor(() => expect(archiveMock).toHaveBeenCalled());

      // Only NOW does the pre-archive load answer. Invalidation has to have
      // superseded it: if it is allowed to land it writes `ready` over the
      // `idle` the archive just set, and reopening then sees a non-idle status
      // and never refetches — permanently hiding the pipeline just archived
      // from the ONE surface that is the way back to it.
      inFlight.resolve([]);
      listArchivedMock.mockResolvedValue([pipeline({ name: 'Nightly digest', archived: true })]);

      await user.click(screen.getByRole('button', { name: /Show archived/i }));
      expect(
        await screen.findByRole('button', { name: 'Unarchive Nightly digest' }),
      ).toBeInTheDocument();
      expect(listArchivedMock).toHaveBeenCalledTimes(2);
    });

    it('loads the archived set when a REOPEN races an in-flight archive', async () => {
      const user = userEvent.setup();
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      listMock.mockResolvedValue([pipeline({ name: 'Nightly digest' })]);

      const firstLoad = deferred<Pipeline[]>();
      listArchivedMock.mockReturnValueOnce(firstLoad.promise);
      const archiving = deferred<Pipeline>();
      archiveMock.mockReturnValueOnce(archiving.promise);
      renderPage();

      // Open (load A starts), close, then archive — which reads `showArchived`
      // as false at CLICK time and holds that value across its awaits.
      await user.click(await screen.findByRole('button', { name: /Show archived/i }));
      await waitFor(() => expect(listArchivedMock).toHaveBeenCalledTimes(1));
      await user.click(screen.getByRole('button', { name: /Hide archived/i }));
      await user.click(screen.getByRole('button', { name: 'Archive Nightly digest' }));

      // Reopen while the archive is still in flight. Load A is still 'loading',
      // so an open that only fetches on the CLICK cannot fetch here.
      await user.click(screen.getByRole('button', { name: /Show archived/i }));

      listArchivedMock.mockResolvedValue([pipeline({ name: 'Nightly digest', archived: true })]);
      archiving.resolve(pipeline({ archived: true }));
      firstLoad.resolve([]);

      // The archive lands last and invalidates the set. The section is OPEN by
      // then, so it has to load: otherwise it sits at `idle` while open, which
      // renders no rows, no error and no "Loading…" — a blank section that
      // nothing refetches, hiding the pipeline just archived.
      expect(
        await screen.findByRole('button', { name: 'Unarchive Nightly digest' }),
      ).toBeInTheDocument();
    });

    it('re-reads the archived set after an archive performed while it was closed', async () => {
      const user = userEvent.setup();
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      listMock.mockResolvedValue([pipeline({ name: 'Nightly digest' })]);
      renderPage();

      // Open, then close — so a naive "fetch once" would now be holding a list
      // that predates the archive below.
      await user.click(await screen.findByRole('button', { name: /Show archived/i }));
      await waitFor(() => expect(listArchivedMock).toHaveBeenCalledTimes(1));
      await user.click(screen.getByRole('button', { name: /Hide archived/i }));

      await user.click(screen.getByRole('button', { name: 'Archive Nightly digest' }));
      await waitFor(() => expect(archiveMock).toHaveBeenCalled());
      // Still closed, so still no second request.
      expect(listArchivedMock).toHaveBeenCalledTimes(1);

      listArchivedMock.mockResolvedValue([pipeline({ name: 'Nightly digest', archived: true })]);
      await user.click(screen.getByRole('button', { name: /Show archived/i }));
      // The row just archived is THERE, because opening refetched.
      expect(
        await screen.findByRole('button', { name: 'Unarchive Nightly digest' }),
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
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      listMock.mockResolvedValue([pipeline({ name: 'Nightly digest' })]);
      renderPage();

      // Section OPEN, so the archive's follow-up takes the `loadArchived` branch.
      await user.click(await screen.findByRole('button', { name: /Show archived/i }));
      await waitFor(() => expect(listArchivedMock).toHaveBeenCalledTimes(1));

      // Both follow-up reads fail: the live refresh AND the archived reload.
      listMock.mockRejectedValue(new Error('live list down'));
      listArchivedMock.mockRejectedValue(new Error('archived list down'));

      await user.click(screen.getByRole('button', { name: 'Archive Nightly digest' }));

      await waitFor(() => expect(archiveMock).toHaveBeenCalledWith('pl_1'));
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
      await user.click(screen.getByRole('button', { name: /Show archived/i }));

      listMock.mockRejectedValue(new Error('live list down'));
      listArchivedMock.mockRejectedValue(new Error('archived list down'));

      await user.click(await screen.findByRole('button', { name: 'Unarchive Retired' }));

      await waitFor(() => expect(restoreMock).toHaveBeenCalledWith('pl_9'));
      expect(await screen.findByText(/Could not load archived pipelines/i)).toBeInTheDocument();
      expect(screen.queryByText(/Could not unarchive/i)).not.toBeInTheDocument();
    });
  });

  it('deletes a pipeline after confirmation', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    listMock.mockResolvedValue([pipeline({ name: 'Doomed' })]);
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Delete Doomed/i }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('pl_1'));
  });

  it('shows a friendly message when deleting a pipeline that has runs (409)', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    deleteMock.mockRejectedValue(new ApiError(409, 'pipeline has runs'));
    listMock.mockResolvedValue([pipeline({ name: 'Busy' })]);
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Delete Busy/i }));
    expect(await screen.findByText(/it has run history/i)).toBeInTheDocument();
  });

  it('does not delete when confirmation is declined', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    listMock.mockResolvedValue([pipeline({ name: 'Safe' })]);
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Delete Safe/i }));
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

    await user.click(await screen.findByRole('button', { name: /Export Nightly digest/i }));

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
  it('disables the Export button for THAT row while its export is in flight', async () => {
    const user = userEvent.setup();
    const gate = deferred<string>();
    exportMock.mockReturnValue(gate.promise);
    listMock.mockResolvedValue([
      pipeline({ id: 'pl_7', name: 'Nightly digest' }),
      pipeline({ id: 'pl_8', name: 'Other' }),
    ]);
    renderPage();

    const target = await screen.findByRole('button', { name: /Export Nightly digest/i });
    const other = await screen.findByRole('button', { name: /Export Other/i });
    expect(target).toBeEnabled();

    await user.click(target);

    await waitFor(() => expect(target).toBeDisabled());
    expect(target).toHaveAttribute('aria-busy', 'true');
    // Keyed by row, not page-wide: a second pipeline stays exportable, which is
    // why this is a Set rather than one busy flag.
    expect(other).toBeEnabled();

    gate.resolve('{"canonical":"bytes"}');
    await waitFor(() => expect(target).toBeEnabled());
  });

  it('reports a failed export instead of saving the error body to disk', async () => {
    const user = userEvent.setup();
    exportMock.mockRejectedValue(new ApiError(404, 'pipeline "pl_1" not found'));
    listMock.mockResolvedValue([pipeline({ name: 'Gone' })]);
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Export Gone/i }));

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
