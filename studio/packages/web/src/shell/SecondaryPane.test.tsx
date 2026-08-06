import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { SecondaryPane, PANE_ELEMENT_ID } from './SecondaryPane';
import { hubById } from './hubs';
import { renderWithRouter } from '../testing/renderWithRouter';
import * as pipelinesApi from '../api/pipelines';

// The Author pane mounts `FactoryResources`, which loads the pipelines list.
// Without this the cases below would make a REAL relative-URL `fetch` (which
// cannot resolve under jsdom) against the app SINGLETON, leaving it in `error`
// for every later case in the file — a unit test with cross-case shared state
// and a network call in it.
vi.mock('../api/pipelines', async (importActual) => ({
  ...(await importActual<typeof import('../api/pipelines')>()),
  listPipelines: vi.fn(),
}));

/**
 * The pane takes its hub as a PROP rather than reading `useMatches()` itself.
 * `useMatches` is a data-router hook — it throws under the `MemoryRouter` these
 * component tests use — but the deciding reason is design, not testability:
 * `AppShell` is the one place that asks the router where it is, so there is a
 * single call site to reason about rather than one per shell part.
 */
const manage = hubById('manage')!;

function pane() {
  return screen.getByRole('navigation', { name: 'Manage sections' });
}

describe('SecondaryPane', () => {
  it("lists the hub's sections in order, as links to their own paths", () => {
    renderWithRouter(<SecondaryPane hub={manage} collapsed={false} />, '/manage/connections');

    const links = within(pane()).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['Connections', 'Triggers', 'Git']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/manage/connections',
      '/manage/triggers',
      '/manage/git',
    ]);
  });

  /**
   * The pane is the ONLY way to reach the Triggers page by clicking. Between U2
   * and U3 nothing in the app linked to it: the rail reaches Manage, Manage
   * index-redirects to Connections, and no page linked on — so a real bookmark
   * or a hand-typed URL was the only route in.
   */
  it('makes Triggers reachable at all', () => {
    renderWithRouter(<SecondaryPane hub={manage} collapsed={false} />, '/manage/connections');
    expect(within(pane()).getByRole('link', { name: 'Triggers' })).toHaveAttribute(
      'href',
      '/manage/triggers',
    );
  });

  /**
   * Active state comes from `NavLink`'s own `isActive`, which already sets
   * `aria-current` — the same single-source rule the rail follows, and the
   * reason U2 deleted its hand-rolled path matcher.
   */
  it('marks the current section, and only the current section', () => {
    renderWithRouter(<SecondaryPane hub={manage} collapsed={false} />, '/manage/triggers');
    const links = within(pane()).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual([null, 'page', null]);
  });

  /** A deeper route inside a section keeps that section lit. */
  it('keeps a section marked from a deeper route beneath it', () => {
    const monitor = hubById('monitor')!;
    renderWithRouter(<SecondaryPane hub={monitor} collapsed={false} />, '/monitor/runs/run_42');
    expect(screen.getByRole('link', { name: 'Runs' })).toHaveAttribute('aria-current', 'page');
  });

  /**
   * Collapsed keeps the pane MOUNTED and `hidden`, rather than unmounting it.
   * The command bar's toggle points `aria-controls` at this element, and
   * `aria-controls` naming an id that is not in the document is a broken
   * reference, not an empty one.
   */
  it('stays in the document but hidden when collapsed', () => {
    renderWithRouter(<SecondaryPane hub={manage} collapsed />, '/manage/connections');
    const el = document.getElementById(PANE_ELEMENT_ID);
    expect(el).not.toBeNull();
    expect(el).not.toBeVisible();
    // ...and out of the accessibility tree with it, so a screen reader is not
    // offered links to a pane that is not on screen.
    expect(screen.queryByRole('navigation', { name: 'Manage sections' })).toBeNull();
  });

  it('carries the id the command-bar toggle controls', () => {
    renderWithRouter(<SecondaryPane hub={manage} collapsed={false} />, '/manage/connections');
    expect(pane()).toHaveAttribute('id', PANE_ELEMENT_ID);
  });
});

/**
 * U4 — a hub with a surface of its own replaces the pane's BODY, never its
 * `<nav>` wrapper. The wrapper's id, `hidden` and `aria-label` are what the
 * command bar's `aria-controls`, its focus restoration and the shell's column
 * arithmetic all depend on; a hub surface that brought its own container would
 * have to re-earn all three, silently, one hub at a time.
 */
describe('SecondaryPane — per-hub content', () => {
  const author = hubById('author')!;

  beforeEach(() => {
    vi.mocked(pipelinesApi.listPipelines).mockResolvedValue([]);
  });

  function renderAuthor(path = '/author/pipelines') {
    return renderWithRouter(<SecondaryPane hub={author} collapsed={false} />, path);
  }

  it('keeps the wrapper contract for a hub that brings its own content', () => {
    renderAuthor();
    const el = screen.getByRole('navigation', { name: 'Author sections' });
    expect(el).toHaveAttribute('id', PANE_ELEMENT_ID);
  });

  it('still hides it wholesale when collapsed', () => {
    renderWithRouter(<SecondaryPane hub={author} collapsed />, '/author/pipelines');
    expect(document.getElementById(PANE_ELEMENT_ID)).not.toBeVisible();
  });

  it('titles the Author pane for what it HOLDS, not for the hub', () => {
    renderAuthor();
    // The Shell diagram labels this pane "Factory Resources": it is a resource
    // tree, not a section list.
    expect(screen.getByRole('heading', { name: 'Factory Resources' })).toBeInTheDocument();
  });

  it('renders the resources tree instead of a bare section list', () => {
    renderAuthor();
    expect(screen.getByRole('button', { name: 'New pipeline' })).toBeInTheDocument();
    // The hub's own section survives as the tree's group header, so `HUBS`
    // stays the single source of the pane's navigation.
    expect(screen.getByRole('link', { name: 'Pipelines' })).toHaveAttribute(
      'href',
      '/author/pipelines',
    );
  });

  /**
   * The tree's rows are `NavLink`s, so "which one am I on" comes from the
   * router and nothing else — the same single source the rail and the default
   * section list use. `end` on the group link is what stops `Pipelines` also
   * claiming to be current while a pipeline is open beneath it.
   */
  it('marks the open pipeline, and not the group header, as the current page', async () => {
    vi.mocked(pipelinesApi.listPipelines).mockResolvedValue([
      {
        id: 'pl_1',
        resourceId: 'res_pl1',
        ownerId: 'local',
        name: 'Alpha',
        concurrency: null,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    renderAuthor('/author/pipelines/pl_1');

    const row = await screen.findByRole('link', { name: 'Alpha' });
    expect(row).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Pipelines' })).not.toHaveAttribute('aria-current');
  });

  it('leaves a hub with no custom content on the default section list', () => {
    renderWithRouter(<SecondaryPane hub={manage} collapsed={false} />, '/manage/connections');
    expect(screen.getByRole('heading', { name: 'Manage' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New pipeline' })).toBeNull();
  });
});
