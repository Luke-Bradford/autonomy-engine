import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter, useLocation } from 'react-router';
import type { Pipeline } from '@autonomy-studio/shared';
import { FactoryResources } from './FactoryResources';
import { ApiError } from '../../api/client';
import { createPipelinesStore } from '../../stores/pipelinesStore';
import { renderWithRouter } from '../../testing/renderWithRouter';
import { hubById } from '../../shell/hubs';
import * as pipelinesApi from '../../api/pipelines';
import * as downloadApi from '../../api/download';
import * as portabilityApi from '../../api/portability';

vi.mock('../../api/pipelines', async (importActual) => ({
  ...(await importActual<typeof import('../../api/pipelines')>()),
  listPipelines: vi.fn(),
  createPipeline: vi.fn(),
  renamePipeline: vi.fn(),
  duplicatePipeline: vi.fn(),
  deletePipeline: vi.fn(),
}));

// See `PipelinesPage.test.tsx` for why the real download helper is kept out of
// jsdom: an anchor click schedules a navigation jsdom cannot perform, on a
// later tick, in whichever test is running by then.
vi.mock('../../api/download', async (importActual) => ({
  ...(await importActual<typeof import('../../api/download')>()),
  downloadTextFile: vi.fn(),
}));
vi.mock('../../api/portability', async (importActual) => ({
  ...(await importActual<typeof import('../../api/portability')>()),
  exportPipeline: vi.fn(),
}));

const listMock = vi.mocked(pipelinesApi.listPipelines);
const downloadMock = vi.mocked(downloadApi.downloadTextFile);
const exportMock = vi.mocked(portabilityApi.exportPipeline);
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

    // NOT an `alert`: the pipelines page mounted beside this pane announces the
    // same load failure, and two alerts carrying one message means a screen
    // reader says it twice.
    expect(await screen.findByText('offline')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    // The empty state must NOT be shown for a failure — "there are none" and
    // "we could not find out" are different facts.
    expect(screen.queryByText(/No pipelines yet/i)).not.toBeInTheDocument();

    listMock.mockResolvedValue([ALPHA]);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('link', { name: 'Alpha' })).toBeInTheDocument();
  });

  it('keeps Retry available when a MUTATION also fails on top of the load', async () => {
    const user = userEvent.setup();
    listMock.mockRejectedValue(new Error('offline'));
    createMock.mockRejectedValueOnce(new Error('also broken'));
    renderPane();
    await screen.findByText('offline');

    await user.click(screen.getByRole('button', { name: 'New pipeline' }));
    await user.type(screen.getByRole('textbox', { name: 'Pipeline name' }), 'Gamma');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByRole('alert');

    // Gating Retry on `!actionError` meant a second failure hid the only way back.
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
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

  /**
   * #959 — the pane and the pipelines page are two views of ONE list, mounted
   * at the same time. An act offered on one and not the other is a hole the
   * operator finds by looking in the wrong place.
   */
  it('exports from the row menu, without refreshing a list nothing changed in', async () => {
    const user = userEvent.setup();
    exportMock.mockReset();
    downloadMock.mockReset();
    exportMock.mockResolvedValue('{"canonical":"bytes"}');
    renderPane();
    await screen.findByRole('link', { name: 'Alpha' });
    const listCallsBefore = listMock.mock.calls.length;

    await openRowMenu(user, 'Alpha');
    await user.click(await screen.findByRole('menuitem', { name: 'Export' }));

    await waitFor(() => expect(exportMock).toHaveBeenCalledWith('pl_1'));
    expect(downloadMock).toHaveBeenCalledWith('pipeline-alpha-pl_1.json', '{"canonical":"bytes"}');
    // An export mutates nothing, so it must not go through `run`, whose
    // refresh would imply to every other view that something moved.
    expect(listMock.mock.calls).toHaveLength(listCallsBefore);
  });

  it('duplicates through a name row prefilled with a "(copy)" suffix', async () => {
    const user = userEvent.setup();
    renderPane();
    await screen.findByRole('link', { name: 'Alpha' });

    await openRowMenu(user, 'Alpha');
    await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));

    expect(screen.getByRole('textbox', { name: 'Pipeline name' })).toHaveValue('Alpha (copy)');
    await user.click(screen.getByRole('button', { name: 'Duplicate' }));

    await waitFor(() => expect(duplicateMock).toHaveBeenCalledWith(ALPHA, 'Alpha (copy)'));
  });

  /**
   * The actions are not mutually exclusive — the row `⋯` menus stay live while a
   * draft is mid-submit — so two mutations can overlap. While the in-flight flag
   * was a BOOLEAN, whichever finished first cleared it and lied about the other
   * still running: the duplicate's submit button came back to life under a
   * request that had not returned, and a second click minted a second copy.
   */
  it('keeps the draft submit disabled while ITS request is still in flight, not the fastest one', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    // The duplicate hangs; the delete raced against it resolves immediately.
    let finishDuplicate!: (p: Pipeline) => void;
    duplicateMock.mockImplementationOnce(
      () => new Promise<Pipeline>((resolve) => (finishDuplicate = resolve)),
    );

    renderPane();
    await screen.findByRole('link', { name: 'Alpha' });

    await openRowMenu(user, 'Alpha');
    await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
    const submit = screen.getByRole('button', { name: 'Duplicate' });
    await user.click(submit);
    await waitFor(() => expect(submit).toBeDisabled());

    // Now delete an unrelated row — its menu was never gated on the flag.
    await openRowMenu(user, 'Beta');
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('pl_2'));

    // The delete has come and gone; the duplicate has NOT. One `duplicatePipeline`
    // call is the whole point — a re-enabled button here means two copies.
    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(duplicateMock).toHaveBeenCalledTimes(1);

    finishDuplicate(pipeline({ id: 'pl_3', name: 'Alpha (copy)' }));
    await waitFor(() => expect(duplicateMock).toHaveBeenCalledTimes(1));
  });

  /**
   * `+` opens a CREATE draft, which replaces whatever draft is open — so while a
   * rename/duplicate is mid-submit it would discard the name the user is waiting
   * on, with the request still in flight.
   */
  it('cannot discard a mid-submit draft with the + button', async () => {
    const user = userEvent.setup();
    let finishRename!: (p: Pipeline) => void;
    renameMock.mockImplementationOnce(
      () => new Promise<Pipeline>((resolve) => (finishRename = resolve)),
    );

    renderPane();
    await screen.findByRole('link', { name: 'Alpha' });

    await openRowMenu(user, 'Alpha');
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    const add = screen.getByRole('button', { name: 'New pipeline' });
    await waitFor(() => expect(add).toBeDisabled());
    // The typed name is still there, not replaced by an empty create row.
    expect(screen.getByRole('textbox', { name: 'Pipeline name' })).toHaveValue('Alpha');

    finishRename(pipeline({ name: 'Alpha' }));
    // ...and it frees up again the moment the request settles, because it is
    // also the target a delete hands focus back to.
    await waitFor(() => expect(add).toBeEnabled());
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
      expect(screen.getByTestId('location').textContent).toBe('/author/pipelines'),
    );
  });

  /**
   * A PUSHED navigation would leave the dead pipeline's URL in history, so Back
   * lands on "Pipeline not found" — the trap `routes.tsx` states the house rule
   * for. Asserted through the history LENGTH, which is the only way to tell a
   * push from a replace apart.
   */
  it('leaves the deleted pipeline by REPLACE, so Back is not a trap', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const store = createPipelinesStore();
    const router = createMemoryRouter(
      [
        {
          path: '/author/pipelines',
          element: (
            <>
              <FactoryResources hub={AUTHOR} store={store} />
              <LocationProbe />
            </>
          ),
        },
        {
          path: '/author/pipelines/:pipelineId',
          element: (
            <>
              <FactoryResources hub={AUTHOR} store={store} />
              <LocationProbe />
            </>
          ),
        },
      ],
      { initialEntries: ['/author/pipelines', '/author/pipelines/pl_1'] },
    );
    render(<RouterProvider router={router} />);
    await screen.findByRole('link', { name: 'Alpha' });

    await openRowMenu(user, 'Alpha');
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/author/pipelines'));

    // Back must reach the entry BEFORE the canvas, not the canvas itself.
    await act(async () => {
      await router.navigate(-1);
    });
    expect(router.state.location.pathname).toBe('/author/pipelines');
  });

  /**
   * Delete unmounts the row the Fluent menu was anchored to. Fluent restores
   * focus to its trigger on close — which by then is gone — so focus would fall
   * to `<body>` and Tab would restart from the top of the document.
   */
  it('hands focus somewhere real after deleting the row it came from', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    listMock.mockResolvedValueOnce([ALPHA, BETA]).mockResolvedValue([BETA]);
    renderPane();
    await screen.findByRole('link', { name: 'Alpha' });

    await openRowMenu(user, 'Alpha');
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'New pipeline' })).toHaveFocus());
  });

  /**
   * The mirror of the case above: a delete that FAILED removed no row, so there
   * is nothing to hand focus back FROM. Arming the restoration anyway leaves it
   * armed indefinitely — a failed delete never refreshes, so the effect that
   * would consume it does not run — and the next unrelated change to the SHARED
   * list (the pipelines page, mounted beside this pane, creating or deleting)
   * fires it instead, yanking focus out of whatever the user had moved on to.
   */
  it('disarms focus restoration when the delete FAILED, so nothing steals it later', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    deleteMock.mockRejectedValueOnce(new ApiError(409, 'nope'));
    const { store } = renderPane();
    await screen.findByRole('link', { name: 'Alpha' });

    await openRowMenu(user, 'Alpha');
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await screen.findByRole('alert');

    // The row survived the failure; the user moves on to the filter.
    const filter = screen.getByRole('searchbox', { name: 'Filter pipelines' });
    filter.focus();

    // The SIBLING view mutates the shared list — nothing to do with this pane.
    listMock.mockResolvedValue([ALPHA]);
    await act(async () => {
      await store.getState().refresh();
    });
    await waitFor(() => expect(tree().queryByRole('link', { name: 'Beta' })).toBeNull());

    expect(filter).toHaveFocus();
  });

  /**
   * A draft's return target can be deleted out from under it. Only a `rename`
   * draft replaces its row — a `duplicate` leaves the source row live and
   * deletable beneath the open draft — and `activeDraft` reconciles for rename
   * only, so the delete's own restoration stands down and the draft's branch is
   * what eventually runs, against a `⋯` button that no longer exists. Without a
   * fallback, focus lands nowhere at all.
   */
  it('falls back to a control that EXISTS when the draft’s row was deleted underneath it', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    listMock.mockResolvedValueOnce([ALPHA, BETA]).mockResolvedValue([BETA]);
    renderPane();
    await screen.findByRole('link', { name: 'Alpha' });

    // Duplicate leaves Alpha's own row in place, still carrying its `⋯` menu.
    await openRowMenu(user, 'Alpha');
    await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
    await screen.findByRole('textbox', { name: 'Pipeline name' });

    // Delete that very row while its duplicate draft is still open.
    await openRowMenu(user, 'Alpha');
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Alpha' })).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    // The row's `⋯` is gone, so focus must land on the pane's stable control —
    // anywhere real rather than `<body>`.
    await waitFor(() => expect(screen.getByRole('button', { name: 'New pipeline' })).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  /**
   * Two deletes in flight at once, the FIRST one failing. Under the old
   * save-and-restore slot, delete A captured the pre-arm value, delete B then
   * armed on top, and A's failure unwound to a value that predated B — silently
   * dropping the request B was still waiting on, so B's success restored nothing
   * and focus stayed on `<body>`: the exact failure the mechanism exists to
   * prevent. The slot is now the row id, cleared only by whoever still owns it.
   */
  it('restores focus for a delete that SUCCEEDS alongside one that failed first', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    /* BOTH held open, so they are genuinely concurrent: Alpha must fail while
       Beta is still in flight. Letting Beta settle first would complete its
       restoration before Alpha's failure ran, and the interleaving under test
       would never occur. */
    let failAlpha!: (err: unknown) => void;
    let finishBeta!: () => void;
    deleteMock
      .mockImplementationOnce(() => new Promise<void>((_res, rej) => (failAlpha = rej)))
      .mockImplementationOnce(() => new Promise<void>((res) => (finishBeta = () => res())));
    listMock.mockResolvedValueOnce([ALPHA, BETA]).mockResolvedValue([ALPHA]);

    renderPane();
    await screen.findByRole('link', { name: 'Alpha' });

    await openRowMenu(user, 'Alpha');
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('pl_1'));

    await openRowMenu(user, 'Beta');
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('pl_2'));

    // Alpha fails FIRST, with Beta's request still outstanding.
    await act(async () => {
      failAlpha(new ApiError(409, 'nope'));
      await Promise.resolve();
    });
    await screen.findByRole('alert');

    // Beta then succeeds — its restoration must not have been dropped.
    await act(async () => {
      finishBeta();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryByRole('link', { name: 'Beta' })).toBeNull());
    await waitFor(() => expect(screen.getByRole('button', { name: 'New pipeline' })).toHaveFocus());
  });

  /**
   * One slot, two independent restoration flows. A SUCCESSFUL delete of an
   * unrelated row used to overwrite an open draft's return target with the `+`
   * button — so cancelling the draft afterwards landed focus on `+` rather than
   * on the row it came from. The delete gains nothing by arming here (the effect
   * stands down while a draft is open), so it simply does not claim the slot.
   */
  it('does not hijack an open draft’s focus target when an unrelated delete SUCCEEDS', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    listMock.mockResolvedValueOnce([ALPHA, BETA]).mockResolvedValue([ALPHA]);
    renderPane();
    await screen.findByRole('link', { name: 'Alpha' });

    // A rename is in progress on Alpha — its `⋯` button is the return target.
    await openRowMenu(user, 'Alpha');
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    await screen.findByRole('textbox', { name: 'Pipeline name' });

    // Beta is deleted out from under it, successfully.
    await openRowMenu(user, 'Beta');
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Beta' })).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'More actions for Alpha' })).toHaveFocus(),
    );
  });

  /**
   * The other half of "transactional": unwinding a failed delete to `null`
   * outright would clear a target that is not the delete's to clear. A draft
   * open on ANOTHER pipeline parks its own return target in the same slot, and
   * the focus effect deliberately leaves it there until the draft closes — so a
   * failed delete in between must put back what it found, not blank it.
   */
  it('leaves an OPEN draft’s focus target intact when an unrelated delete fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    deleteMock.mockRejectedValueOnce(new ApiError(409, 'nope'));
    renderPane();
    await screen.findByRole('link', { name: 'Alpha' });

    // A rename is in progress on Alpha — its `⋯` button is the return target.
    await openRowMenu(user, 'Alpha');
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    await screen.findByRole('textbox', { name: 'Pipeline name' });

    // Meanwhile the user deletes Beta, and that delete fails.
    await openRowMenu(user, 'Beta');
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await screen.findByRole('alert');

    // Cancelling the rename must still land focus on the row it came from.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'More actions for Alpha' })).toHaveFocus(),
    );
  });

  /**
   * A failed DELETE closes no draft row, so nothing else would ever clear its
   * message: the pane outlives every route change inside the hub.
   */
  it('lets the user dismiss a failed action’s message', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    deleteMock.mockRejectedValueOnce(new ApiError(409, 'nope'));
    renderPane();
    await screen.findByRole('link', { name: 'Alpha' });

    await openRowMenu(user, 'Alpha');
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await screen.findByRole('alert');

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
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
