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
  downloadMock.mockReset();
  exportMock.mockReset();
  exportMock.mockResolvedValue('{"kind":"pipeline"}');
});

afterEach(() => {
  vi.restoreAllMocks();
});

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
