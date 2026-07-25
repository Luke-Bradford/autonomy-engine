import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { PipelineCanvasRoute } from './PipelineCanvasRoute';
import { ApiError } from '../../api/client';
import { renderWithRouter } from '../../testing/renderWithRouter';
import * as pipelinesApi from '../../api/pipelines';

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
    onBack,
  }: {
    pipelineId: string;
    pipelineName: string;
    onBack: () => void;
  }) => (
    <div>
      <span>{`canvas:${pipelineId}:${pipelineName}`}</span>
      <button type="button" onClick={onBack}>
        Back
      </button>
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
    expect(screen.getByRole('link', { name: /Back to pipelines/i })).toHaveAttribute(
      'href',
      '/author/pipelines',
    );
  });

  it('reports a genuine failure with its message', async () => {
    getMock.mockRejectedValue(new Error('the server exploded'));
    renderRoute('/author/pipelines/pl_1');

    expect(
      await screen.findByRole('heading', { name: 'Could not open pipeline' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('the server exploded');
  });

  it('takes Back to the pipelines list', async () => {
    const user = userEvent.setup();
    renderRoute('/author/pipelines/pl_1');
    await screen.findByText('canvas:pl_1:Nightly digest');

    await user.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.getByTestId('location').textContent).toBe('/author/pipelines');
  });

  it('does not report an aborted in-flight fetch as an error', async () => {
    // Unmounting mid-request aborts it; the rejection that follows must not be
    // painted onto a component that is already gone (React logs a warning) or
    // onto the NEXT pipeline's canvas.
    let reject!: (reason: unknown) => void;
    getMock.mockReturnValue(new Promise((_, rej) => (reject = rej)));
    const { unmount } = renderRoute('/author/pipelines/pl_1');
    await screen.findByText(/Loading pipeline/i);

    unmount();
    reject(new DOMException('aborted', 'AbortError'));

    expect(screen.queryByRole('alert')).toBeNull();
  });
});
