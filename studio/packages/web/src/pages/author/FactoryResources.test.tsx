import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router';
import type { Pipeline } from '@autonomy-studio/shared';
import { FactoryResources } from './FactoryResources';
import { createPipelinesStore } from '../../stores/pipelinesStore';
import { renderWithRouter } from '../../testing/renderWithRouter';
import { hubById } from '../../shell/hubs';
import * as pipelinesApi from '../../api/pipelines';

vi.mock('../../api/pipelines', async (importActual) => ({
  ...(await importActual<typeof import('../../api/pipelines')>()),
  listPipelines: vi.fn(),
  createPipeline: vi.fn(),
  renamePipeline: vi.fn(),
  duplicatePipeline: vi.fn(),
  deletePipeline: vi.fn(),
}));

const listMock = vi.mocked(pipelinesApi.listPipelines);
const createMock = vi.mocked(pipelinesApi.createPipeline);
const renameMock = vi.mocked(pipelinesApi.renamePipeline);
const duplicateMock = vi.mocked(pipelinesApi.duplicatePipeline);
const deleteMock = vi.mocked(pipelinesApi.deletePipeline);

function pipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id: 'pl_1',
    resourceId: 'res_pl1',
    ownerId: 'local',
    name: 'Alpha',
    concurrency: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const ALPHA = pipeline();
const BETA = pipeline({ id: 'pl_2', name: 'Beta' });

const AUTHOR = hubById('author')!;

/** Reads the router's current path back out, so navigation is observable. */
function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

/** Mount the pane content against its OWN store, so cases cannot bleed. */
function renderPane(initialPath = '/author/pipelines') {
  const store = createPipelinesStore();
  const view = renderWithRouter(
    <>
      <FactoryResources hub={AUTHOR} store={store} />
      <LocationProbe />
    </>,
    initialPath,
  );
  return { store, ...view };
}

/** The pipeline list inside the tree — not the toolbar, not the group header. */
function tree() {
  return within(screen.getByRole('list', { name: 'Pipelines' }));
}

async function openRowMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name: `More actions for ${name}` }));
}

beforeEach(() => {
  listMock.mockResolvedValue([ALPHA, BETA]);
  createMock.mockResolvedValue(pipeline({ id: 'pl_3', name: 'Gamma' }));
  renameMock.mockResolvedValue(pipeline({ name: 'Renamed' }));
  duplicateMock.mockResolvedValue(pipeline({ id: 'pl_3', name: 'Alpha (copy)' }));
  deleteMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FactoryResources — the tree', () => {
  it('loads the pipelines and links each one at its own route', async () => {
    renderPane();
    const alpha = await screen.findByRole('link', { name: 'Alpha' });
    expect(alpha).toHaveAttribute('href', '/author/pipelines/pl_1');
    expect(tree().getAllByRole('listitem')).toHaveLength(2);
  });

  it('keeps the hub SECTION as the group header, linking the list page', async () => {
    renderPane();
    // `HUBS` stays the single source of the pane's navigation: the tree hangs
    // beneath the section link rather than replacing it with a second one.
    const header = await screen.findByRole('link', { name: AUTHOR.sections[0]!.label });
    expect(header).toHaveAttribute('href', AUTHOR.sections[0]!.path);
  });

  it('collapses the group without unmounting it, so the toggle keeps its target', async () => {
    const user = userEvent.setup();
    renderPane();
    await screen.findByRole('link', { name: 'Alpha' });

    const toggle = screen.getByRole('button', { name: /Pipelines/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const list = document.getElementById(toggle.getAttribute('aria-controls')!);
    expect(list).not.toBeNull();
    expect(list).toHaveAttribute('hidden');
  });

  it('shows an empty state once a load has SUCCEEDED with nothing in it', async () => {
    listMock.mockResolvedValue([]);
    renderPane();
    expect(await screen.findByText(/No pipelines yet/i)).toBeInTheDocument();
  });

  it('reports a load failure and offers a retry rather than an empty tree', async () => {
    const user = userEvent.setup();
    listMock.mockRejectedValueOnce(new Error('offline'));
    renderPane();

    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    // The empty state must NOT be shown for a failure — "there are none" and
    // "we could not find out" are different facts.
    expect(screen.queryByText(/No pipelines yet/i)).not.toBeInTheDocument();

    listMock.mockResolvedValue([ALPHA]);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('link', { name: 'Alpha' })).toBeInTheDocument();
  });
});

describe('FactoryResources — filter', () => {
  it('filters by name, case-insensitively', async () => {
    const user = userEvent.setup();
    renderPane();
    await screen.findByRole('link', { name: 'Alpha' });

    await user.type(screen.getByRole('searchbox', { name: 'Filter pipelines' }), 'be');

    expect(tree().queryByRole('link', { name: 'Alpha' })).not.toBeInTheDocument();
    expect(tree().getByRole('link', { name: 'Beta' })).toBeInTheDocument();
  });

  it('distinguishes "no matches" from "no pipelines"', async () => {
    const user = userEvent.setup();
    renderPane();
    await screen.findByRole('link', { name: 'Alpha' });

    await user.type(screen.getByRole('searchbox', { name: 'Filter pipelines' }), 'zzz');

    expect(screen.getByText(/No pipelines match/i)).toBeInTheDocument();
    expect(screen.queryByText(/No pipelines yet/i)).not.toBeInTheDocument();
  });
});

describe('FactoryResources — create', () => {
  it('creates from the inline name row and refreshes the list', async () => {
    const user = userEvent.setup();
    renderPane();
    await screen.findByRole('link', { name: 'Alpha' });

    await user.click(screen.getByRole('button', { name: 'New pipeline' }));
    await user.type(screen.getByRole('textbox', { name: 'Pipeline name' }), 'Gamma');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createMock).toHaveBeenCalledWith({ name: 'Gamma' }));
    // Once for the mount, once after the write — the pane and the page share
    // one store, so the refresh is what keeps the other view honest.
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it('does not submit a blank name', async () => {
    const user = userEvent.setup();
    renderPane();
    await user.click(await screen.findByRole('button', { name: 'New pipeline' }));

    await user.type(screen.getByRole('textbox', { name: 'Pipeline name' }), '   ');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(createMock).not.toHaveBeenCalled();
  });

  it('closes the row on Escape and returns focus to the button that opened it', async () => {
    const user = userEvent.setup();
    renderPane();
    const newButton = await screen.findByRole('button', { name: 'New pipeline' });
    await user.click(newButton);

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('textbox', { name: 'Pipeline name' })).not.toBeInTheDocument();
    expect(newButton).toHaveFocus();
  });

  it('keeps the row open and reports the failure when the create fails', async () => {
    const user = userEvent.setup();
    createMock.mockRejectedValueOnce(new Error('server said no'));
    renderPane();

    await user.click(await screen.findByRole('button', { name: 'New pipeline' }));
    await user.type(screen.getByRole('textbox', { name: 'Pipeline name' }), 'Gamma');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('server said no');
    // The typed name survives, so a retry is one click and not a re-type.
    expect(screen.getByRole('textbox', { name: 'Pipeline name' })).toHaveValue('Gamma');
  });
});

describe('FactoryResources — row actions', () => {
  it('renames in place, prefilled with the current name', async () => {
    const user = userEvent.setup();
    renderPane();
    await screen.findByRole('link', { name: 'Alpha' });

    await openRowMenu(user, 'Alpha');
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));

    const field = screen.getByRole('textbox', { name: 'Pipeline name' });
    expect(field).toHaveValue('Alpha');
    await user.clear(field);
    await user.type(field, 'Alpha 2');
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(renameMock).toHaveBeenCalledWith('pl_1', 'Alpha 2'));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it('duplicates through a name row prefilled with a "(copy)" suffix', async () => {
    const user = userEvent.setup();
    renderPane();
    await screen.findByRole('link', { name: 'Alpha' });

    await openRowMenu(user, 'Alpha');
    await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));

    expect(screen.getByRole('textbox', { name: 'Pipeline name' })).toHaveValue('Alpha (copy)');
    await user.click(screen.getByRole('button', { name: 'Duplicate' }));

    await waitFor(() => expect(duplicateMock).toHaveBeenCalledWith('pl_1', 'Alpha (copy)'));
  });

  it('deletes only after a confirmation', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPane();
    await screen.findByRole('link', { name: 'Alpha' });

    await openRowMenu(user, 'Alpha');
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(deleteMock).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await openRowMenu(user, 'Alpha');
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('pl_1'));
  });

  it('explains a 409 delete refusal in terms of run history', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { ApiError } = await import('../../api/client');
    deleteMock.mockRejectedValueOnce(new ApiError(409, 'nope'));
    renderPane();
    await screen.findByRole('link', { name: 'Alpha' });

    await openRowMenu(user, 'Alpha');
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/run history/i);
  });

  it('navigates OFF a pipeline it just deleted, so the canvas cannot 404', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPane('/author/pipelines/pl_1');
    await screen.findByRole('link', { name: 'Alpha' });

    await openRowMenu(user, 'Alpha');
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/author/pipelines'),
    );
    expect(screen.getByTestId('location').textContent).toBe('/author/pipelines');
  });

  it('stays put when the deleted pipeline is not the one being edited', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPane('/author/pipelines/pl_2');
    await screen.findByRole('link', { name: 'Alpha' });

    await openRowMenu(user, 'Alpha');
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalled());
    expect(screen.getByTestId('location').textContent).toBe('/author/pipelines/pl_2');
  });
});
