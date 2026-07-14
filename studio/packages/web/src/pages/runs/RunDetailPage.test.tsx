import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { EngineEvent, Run, RunEvent } from '@autonomy-studio/shared';
import { RunDetailPage } from './RunDetailPage';
import * as runsApi from '../../api/runs';
import * as hook from './useRunStream';
import type { RunStreamState } from './useRunStream';

vi.mock('../../api/runs', async (importActual) => ({
  ...(await importActual<typeof import('../../api/runs')>()),
  listRuns: vi.fn().mockResolvedValue([]),
  getRun: vi.fn(),
  getRunEvents: vi.fn().mockResolvedValue([]),
}));
vi.mock('./useRunStream', async (importActual) => ({
  ...(await importActual<typeof import('./useRunStream')>()),
  useRunStream: vi.fn(),
}));

const getRunMock = vi.mocked(runsApi.getRun);
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
    startedAt: 1_700_000_000_000,
    finishedAt: null,
    ...overrides,
  };
}

function stream(overrides: Partial<RunStreamState> = {}): RunStreamState {
  return { events: [], phase: 'live', error: undefined, ...overrides };
}

beforeEach(() => {
  getRunMock.mockResolvedValue(run());
  useRunStreamMock.mockReturnValue(stream());
});
afterEach(() => vi.restoreAllMocks());

describe('RunDetailPage', () => {
  it('renders run metadata from the REST fetch', async () => {
    render(<RunDetailPage runId="run_1" />);
    expect(await screen.findByText('pv_1')).toBeInTheDocument();
    expect(screen.getByText('trg_1')).toBeInTheDocument();
    expect(screen.getByText('{"greeting":"hi"}')).toBeInTheDocument();
  });

  it('shows empty node/event states with no events', async () => {
    render(<RunDetailPage runId="run_1" />);
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
    render(<RunDetailPage runId="run_1" />);

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
    render(<RunDetailPage runId="run_1" />);
    expect(await screen.findByText(/most recent 500 of 501 events/i)).toBeInTheDocument();
    // The oldest event's row is dropped; the newest is kept (glosses are unique).
    expect(screen.queryByText('node=a name=chunk0')).not.toBeInTheDocument();
    expect(screen.getByText('node=a name=chunk500')).toBeInTheDocument();
  });

  it('surfaces a stream error', async () => {
    useRunStreamMock.mockReturnValue(
      stream({ phase: 'error', error: 'run not found or not accessible' }),
    );
    render(<RunDetailPage runId="run_x" />);
    expect(await screen.findByText(/not found or not accessible/i)).toBeInTheDocument();
  });
});
