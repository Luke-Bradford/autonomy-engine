import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithRouter } from '../../testing/renderWithRouter';
import type { EngineEvent, PipelineVersion, Run, RunEvent } from '@autonomy-studio/shared';
import { CATALOG_VERSION, PipelineVersionSchema } from '@autonomy-studio/shared';
import { RunDetailPage } from './RunDetailPage';
import * as runsApi from '../../api/runs';
import * as hook from './useRunStream';
import type { RunStreamState } from './useRunStream';

vi.mock('../../api/runs', async (importActual) => ({
  ...(await importActual<typeof import('../../api/runs')>()),
  listRuns: vi.fn().mockResolvedValue([]),
  getRunDetail: vi.fn(),
  getRunEvents: vi.fn().mockResolvedValue([]),
}));
vi.mock('./useRunStream', async (importActual) => ({
  ...(await importActual<typeof import('./useRunStream')>()),
  useRunStream: vi.fn(),
}));

const getRunDetailMock = vi.mocked(runsApi.getRunDetail);
const useRunStreamMock = vi.mocked(hook.useRunStream);

let seq = 0;
function envelope(event: EngineEvent): RunEvent {
  return {
    id: `evt_${seq}`,
    runId: event.runId,
    seq: seq++,
    type: event.type,
    payload: event,
    ts: seq,
  };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_1',
    ownerId: 'local',
    pipelineVersionId: 'pv_1',
    triggerId: 'trg_1',
    parentRunId: null,
    params: { greeting: 'hi' },
    status: 'running',
    leaseUntil: null,
    heartbeatAt: null,
    queuedAt: null,
    triggerContext: null,
    rerunOf: null,
    startedAt: 1_700_000_000_000,
    finishedAt: null,
    ...overrides,
  };
}

function version(overrides: Partial<PipelineVersion> = {}): PipelineVersion {
  // Parsed through the REAL schema, so a fixture cannot drift from the contract
  // the page actually receives.
  return PipelineVersionSchema.parse({
    id: 'pv_1',
    resourceId: 'res_1',
    pipelineId: 'pl_1',
    version: 1,
    params: [],
    outputs: [],
    nodes: [
      { id: 'greet', type: 'http_request', position: { x: 0, y: 0 }, config: {} },
      { id: 'never', type: 'http_request', position: { x: 240, y: 0 }, config: {} },
    ],
    edges: [{ id: 'e1', from: 'greet', to: 'never', on: 'failure' }],
    containers: [],
    catalogVersion: CATALOG_VERSION,
    createdAt: 1_700_000_000_000,
    ...overrides,
  });
}

function stream(overrides: Partial<RunStreamState> = {}): RunStreamState {
  return { events: [], phase: 'live', error: undefined, ...overrides };
}

beforeEach(() => {
  getRunDetailMock.mockResolvedValue({ run: run(), pipelineVersion: version() });
  useRunStreamMock.mockReturnValue(stream());
});
afterEach(() => vi.restoreAllMocks());

describe('RunDetailPage', () => {
  it('renders run metadata from the R1 read-model fetch', async () => {
    renderWithRouter(<RunDetailPage runId="run_1" />);
    expect(await screen.findByText('pv_1')).toBeInTheDocument();
    expect(screen.getByText('trg_1')).toBeInTheDocument();
    expect(screen.getByText('{"greeting":"hi"}')).toBeInTheDocument();
  });

  it('shows empty node/event states with no events', async () => {
    renderWithRouter(<RunDetailPage runId="run_1" />);
    expect(await screen.findByText(/No node activity yet/i)).toBeInTheDocument();
    expect(screen.getByText(/No events yet/i)).toBeInTheDocument();
  });

  it('lights up nodes and lists events from the live stream', async () => {
    useRunStreamMock.mockReturnValue(
      stream({
        events: [
          envelope({ type: 'run.started', runId: 'run_1', pipelineVersionId: 'pv_1', params: {} }),
          envelope({
            type: 'node.dispatched',
            runId: 'run_1',
            nodeId: 'greet',
            attemptId: 'greet#0',
            idempotent: true,
          }),
          envelope({
            type: 'node.succeeded',
            runId: 'run_1',
            nodeId: 'greet',
            attemptId: 'greet#0',
            outputs: {},
          }),
          envelope({ type: 'run.finished', runId: 'run_1', outcome: 'success' }),
        ],
      }),
    );
    renderWithRouter(<RunDetailPage runId="run_1" />);

    // Node table shows the node lit green.
    const nodeCell = await screen.findByText('greet');
    const nodeRow = nodeCell.closest('tr')!;
    expect(within(nodeRow).getByText('success')).toBeInTheDocument();

    // The run's derived lifecycle overrides the (running) REST status.
    expect(screen.getByText('run_1').closest('h2')).toBeInTheDocument();
    const hint = screen.getByText('● live').closest('p')!;
    expect(within(hint).getByText('success')).toBeInTheDocument();

    // Event feed lists each event type.
    expect(screen.getByText('run.finished')).toBeInTheDocument();
  });

  it('caps the event feed to the most recent rows on a chatty run', async () => {
    const many: RunEvent[] = Array.from({ length: 501 }, (_, i) =>
      envelope({ type: 'node.output', runId: 'run_1', nodeId: 'a', name: `chunk${i}`, value: i }),
    );
    useRunStreamMock.mockReturnValue(stream({ events: many }));
    renderWithRouter(<RunDetailPage runId="run_1" />);
    expect(await screen.findByText(/most recent 500 of 501 events/i)).toBeInTheDocument();
    // The oldest event's row is dropped; the newest is kept (glosses are unique).
    expect(screen.queryByText('node=a name=chunk0')).not.toBeInTheDocument();
    expect(screen.getByText('node=a name=chunk500')).toBeInTheDocument();
  });

  /* The three specs below assert what the PAGE decides: whether an overlay is
     available, and what it says when it is not. They deliberately do NOT assert
     node contents — jsdom measures every element as zero and React Flow's
     `onlyRenderVisibleElements` culls against that, so nothing inside the canvas
     is in the DOM here. The node/edge construction is unit-tested for real in
     `runFlow.test.ts`, and the RENDERED result in `e2e/run-overlay.spec.ts`. */

  it('U11 — mounts the graph and projects the run once the stream has replayed', async () => {
    useRunStreamMock.mockReturnValue(
      stream({
        phase: 'closed',
        events: [
          envelope({ type: 'run.started', runId: 'run_1', pipelineVersionId: 'pv_1', params: {} }),
        ],
      }),
    );
    renderWithRouter(<RunDetailPage runId="run_1" />);

    expect(await screen.findByTestId('run-canvas')).toBeInTheDocument();
    // Projected: no "why not" line is shown.
    expect(screen.queryByText(/cannot be projected|Loading this run/i)).not.toBeInTheDocument();
  });

  it('U11 — withholds the overlay while the stream is still replaying, and says so', async () => {
    // The engine seeds no nodes until `run.started` folds, so projecting
    // mid-replay would draw a finished run as one where nothing ran.
    useRunStreamMock.mockReturnValue(stream({ phase: 'replaying', events: [] }));
    renderWithRouter(<RunDetailPage runId="run_1" />);

    expect(await screen.findByTestId('run-canvas')).toBeInTheDocument();
    expect(screen.getByText(/Loading this run’s history/i)).toBeInTheDocument();
  });

  it('U11 — says the overlay is unavailable when the stream errored, and still draws the graph', async () => {
    // R1 carries no `events`, so the overlay has no source but the socket. That
    // is stated on screen rather than drawn as an all-blank graph.
    useRunStreamMock.mockReturnValue(stream({ phase: 'error', error: 'socket closed' }));
    renderWithRouter(<RunDetailPage runId="run_1" />);

    expect(await screen.findByTestId('run-canvas')).toBeInTheDocument();
    expect(screen.getByText(/event stream is unavailable/i)).toBeInTheDocument();
  });

  it('surfaces a stream error', async () => {
    useRunStreamMock.mockReturnValue(
      stream({ phase: 'error', error: 'run not found or not accessible' }),
    );
    renderWithRouter(<RunDetailPage runId="run_x" />);
    expect(await screen.findByText(/not found or not accessible/i)).toBeInTheDocument();
  });
});
