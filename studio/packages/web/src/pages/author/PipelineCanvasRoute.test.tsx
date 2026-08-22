import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { PipelineCanvasRoute } from './PipelineCanvasRoute';
import { ApiError } from '../../api/client';
import { renderWithRouter } from '../../testing/renderWithRouter';
import * as pipelinesApi from '../../api/pipelines';
import { createPipelinesStore, type PipelinesStore } from '../../stores/pipelinesStore';

vi.mock('../../api/pipelines', async (importActual) => ({
  ...(await importActual<typeof import('../../api/pipelines')>()),
  getPipeline: vi.fn(),
}));

// The canvas is React-Flow-heavy and has its own coverage; this file is about
// the ROUTE's three states (loading / resolved / unresolvable).
vi.mock('../pipeline/PipelineCanvas', () => ({
  PipelineCanvas: ({
    pipelineId,
    pipelineName,
    archived,
    onUnarchived,
    backTo,
  }: {
    pipelineId: string;
    pipelineName: string;
    archived: boolean;
    onUnarchived: () => void;
    backTo: string;
  }) => (
    <div>
      <span>{`canvas:${pipelineId}:${pipelineName}`}</span>
      {/* #907 — the archived flag as the canvas actually receives it. The
          banner itself is the real canvas's (and its e2e's); what this file
          owns is that the ROUTE hands the fact down and updates its own copy
          when the canvas reports the pipeline unarchived. */}
      <span>{`archived:${String(archived)}`}</span>
      <button type="button" onClick={onUnarchived}>
        Report unarchived
      </button>
      {/* #1242 — a `<Link>`, because that is what the real canvas now renders.
          The route's contract changed from "run this callback" to "hand down a
          DESTINATION", and a stub that kept a button would let the route ship a
          `backTo` no anchor could use while this file stayed green. */}
      <Link to={backTo}>Back</Link>
    </div>
  ),
}));

const getMock = vi.mocked(pipelinesApi.getPipeline);

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

/** Mount the route under a real `:pipelineId` pattern, as `ROUTES` does. */
function renderRoute(path: string) {
  return renderWithRouter(
    <>
      <Routes>
        <Route path="/author/pipelines" element={<span>list</span>} />
        <Route path="/author/pipelines/:pipelineId" element={<PipelineCanvasRoute />} />
      </Routes>
      <LocationProbe />
    </>,
    path,
  );
}

beforeEach(() => {
  getMock.mockResolvedValue({
    id: 'pl_1',
    resourceId: 'res_pl1',
    ownerId: 'local',
    name: 'Nightly digest',
    concurrency: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PipelineCanvasRoute', () => {
  it('resolves the pipeline by id and hands its NAME to the canvas', async () => {
    renderRoute('/author/pipelines/pl_1');
    expect(await screen.findByText('canvas:pl_1:Nightly digest')).toBeInTheDocument();
    expect(getMock).toHaveBeenCalledWith('pl_1', expect.anything());
  });

  /**
   * #907 — the canvas warns on an archived pipeline, and the warning has to
   * clear once the operator acts on it. The fetch answers ONCE at mount, so a
   * route that did not update its own copy would leave the banner standing
   * over a pipeline that is no longer archived — telling the operator their
   * saves are refused when they are not.
   */
  describe('#907 — the archived fact reaches the canvas, and clears when acted on', () => {
    const archivedPipeline = {
      id: 'pl_1',
      resourceId: 'res_pl1',
      ownerId: 'local',
      name: 'Nightly digest',
      concurrency: null,
      archived: true,
      createdAt: 1,
      updatedAt: 1,
    };

    it('hands the archived flag down as fetched', async () => {
      getMock.mockResolvedValue(archivedPipeline);
      renderRoute('/author/pipelines/pl_1');
      expect(await screen.findByText('archived:true')).toBeInTheDocument();
    });

    it('stops saying archived once the canvas reports it unarchived', async () => {
      getMock.mockResolvedValue(archivedPipeline);
      renderRoute('/author/pipelines/pl_1');
      expect(await screen.findByText('archived:true')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Report unarchived' }));

      expect(await screen.findByText('archived:false')).toBeInTheDocument();
      // Settled from the route's OWN state — no second fetch is issued, and
      // none would help: the canvas already knows the outcome it just caused.
      expect(getMock).toHaveBeenCalledTimes(1);
    });

    it('is not archived for an ordinary pipeline', async () => {
      renderRoute('/author/pipelines/pl_1');
      expect(await screen.findByText('archived:false')).toBeInTheDocument();
    });
  });

  it('shows a loading hint rather than a placeholder name', async () => {
    getMock.mockReturnValue(new Promise(() => undefined));
    renderRoute('/author/pipelines/pl_1');
    // A heading that later swaps to the real name reads as a flicker of the
    // WRONG pipeline, which is worse than a moment of "Loading".
    expect(await screen.findByText(/Loading pipeline/i)).toBeInTheDocument();
  });

  it('calls a 404 what it is, rather than reporting a fault', async () => {
    getMock.mockRejectedValue(new ApiError(404, 'no such pipeline'));
    renderRoute('/author/pipelines/gone');

    expect(await screen.findByRole('heading', { name: 'Pipeline not found' })).toBeInTheDocument();
    const back = screen.getByRole('link', { name: /Back to pipelines/i });
    expect(back).toHaveAttribute('href', '/author/pipelines');
    /* #1242 — deliberately BARE, and pinned so the decision is not re-litigated
       by whoever next reads the ticket's "three back controls" table. This one
       sits in a `<p>` of error prose, not a `page-header`, so `.page-back`'s
       chip would be wrong here: it is a link in a sentence. What fixed it was
       the global `a` rule, which needs no class — and adding one would silently
       turn this into the fourth treatment the ticket exists to remove. */
    expect(back).not.toHaveAttribute('class');
  });

  it('reports a genuine failure with its message', async () => {
    getMock.mockRejectedValue(new Error('the server exploded'));
    renderRoute('/author/pipelines/pl_1');

    expect(
      await screen.findByRole('heading', { name: 'Could not open pipeline' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('the server exploded');
  });

  it('hands the canvas a back DESTINATION, and it lands', async () => {
    const user = userEvent.setup();
    renderRoute('/author/pipelines/pl_1');
    await screen.findByText('canvas:pl_1:Nightly digest');

    /* By ROLE `link`, with the `href` asserted before the click: the href is
       the half of #1242 a button never had, and a click that lands in the right
       place proves nothing about whether the control could be middle-clicked or
       copied. */
    const back = screen.getByRole('link', { name: 'Back' });
    expect(back).toHaveAttribute('href', '/author/pipelines');
    await user.click(back);

    expect(screen.getByTestId('location').textContent).toBe('/author/pipelines');
  });

  /**
   * An ABORTED request must not be reported as a failure.
   *
   * Getting this test honest took two attempts, both worth recording:
   *
   * 1. Asserting `queryByRole('alert')` is null after `unmount()` proves
   *    nothing — the query returns null whatever the code does, because the
   *    tree is gone.
   * 2. Navigating pl_a → pl_b and rejecting pl_a's promise proves nothing
   *    either: `PipelineCanvasRoute` keys the inner component by id, so a
   *    param change UNMOUNTS the old one rather than re-running its effect,
   *    and React 19 makes a setState on an unmounted component a silent no-op.
   *
   * The case where the guard genuinely earns its keep is `StrictMode`, which
   * `main.tsx` really does wrap the app in: it runs the effect, cleans it up
   * (aborting request #1) and runs it again on the SAME MOUNTED component. So
   * request #1's AbortError lands on a live tree, and without the guard every
   * canvas open in development would flash "Could not open pipeline: aborted".
   * The mock therefore honours the signal the way a real `fetch` does.
   */
  it('drops an ABORTED request instead of reporting it as a failure', async () => {
    getMock.mockImplementation(
      (id: string, signal?: AbortSignal) =>
        new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
          setTimeout(() => resolve({ id, name: 'Nightly digest' } as never), 0);
        }),
    );

    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/author/pipelines/pl_1']}>
          <Routes>
            <Route path="/author/pipelines/:pipelineId" element={<PipelineCanvasRoute />} />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );

    expect(await screen.findByText('canvas:pl_1:Nightly digest')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('PipelineCanvasRoute — the name stays in step with a rename (#720)', () => {
  /** A store standing in for the shared one, pre-loaded with the given rows. */
  function storeWith(pipelines: { id: string; name: string }[]) {
    const store = createPipelinesStore(() =>
      Promise.resolve(pipelines.map((p) => ({ ...pipelineRow, ...p }))),
    );
    return store;
  }

  const pipelineRow = {
    id: 'pl_1',
    resourceId: 'res_pl1',
    ownerId: 'local',
    name: 'Nightly digest',
    concurrency: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  };

  function renderWithStore(store: PipelinesStore, path = '/author/pipelines/pl_1') {
    return renderWithRouter(
      <Routes>
        <Route path="/author/pipelines" element={<span>list</span>} />
        <Route
          path="/author/pipelines/:pipelineId"
          element={<PipelineCanvasRoute store={store} />}
        />
      </Routes>,
      path,
    );
  }

  it('re-renders the heading when the pipeline is renamed in the tree while open', async () => {
    // The defect: the canvas took its name from a ONE-SHOT `getPipeline`, so
    // renaming in the Factory Resources pane left the two mounted views
    // disagreeing about the very fact the shared store exists to keep in step —
    // until a full reload.
    const store = storeWith([{ id: 'pl_1', name: 'Nightly digest' }]);
    await act(async () => {
      await store.getState().refresh();
    });
    renderWithStore(store);
    expect(await screen.findByText('canvas:pl_1:Nightly digest')).toBeInTheDocument();

    await act(async () => {
      store.setState((s) => ({
        pipelines: s.pipelines.map((p) => ({ ...p, name: 'Nightly digest v2' })),
      }));
    });
    expect(await screen.findByText('canvas:pl_1:Nightly digest v2')).toBeInTheDocument();
  });

  it('falls back to the FETCHED name when the store has no row for this id', async () => {
    // A deep link renders before (or without) any list load — the fetched name is
    // the only answer there is, and it must not be blanked by an empty store.
    const store = storeWith([]);
    renderWithStore(store);
    expect(await screen.findByText('canvas:pl_1:Nightly digest')).toBeInTheDocument();
  });
});
