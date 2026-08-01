import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { renderWithRouter } from '../../testing/renderWithRouter';
import type { EngineEvent, PipelineVersion, Run, RunEvent } from '@autonomy-studio/shared';
import { CATALOG_VERSION, PipelineVersionSchema } from '@autonomy-studio/shared';
import { RunDetailPage } from './RunDetailPage';
import { projectRun } from './runProjection';
import { deriveRunLifecycle } from './runSummary';
import * as runsApi from '../../api/runs';
import * as hook from './useRunStream';
import type { RunStreamState } from './useRunStream';

vi.mock('../../api/runs', async (importActual) => ({
  ...(await importActual<typeof import('../../api/runs')>()),
  listRuns: vi.fn().mockResolvedValue([]),
  getRunDetail: vi.fn(),
  getRun: vi.fn(),
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
  // `replayComplete` defaults TRUE so a spec that does not care reads as a
  // normally-replayed stream; the specs that DO care set it explicitly.
  return { events: [], phase: 'live', error: undefined, replayComplete: true, ...overrides };
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

  /**
   * U25 — the page had TWO answers for one node, and this is the one that read
   * as a lie: the fixture doc routes `greet --failure--> never`, so a run in
   * which `greet` succeeds leaves `never` skipped. The graph painted it grey;
   * the table had no row for it at all, which an operator reads as "the run
   * never got there".
   */
  it('gives a routed-around node a row that says `skipped`, instead of omitting it', async () => {
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
        ],
      }),
    );
    renderWithRouter(<RunDetailPage runId="run_1" />);

    const skippedRow = (await screen.findByText('never')).closest('tr')!;
    expect(within(skippedRow).getByText('skipped')).toBeInTheDocument();
  });

  it('words the status for an operator rather than printing the engine’s identifier', async () => {
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
        ],
      }),
    );
    renderWithRouter(<RunDetailPage runId="run_1" />);

    const row = (await screen.findByRole('button', { name: 'HTTP Request 1' })).closest('tr')!;
    // The engine calls this `dispatched`, which names the ENGINE's act. The
    // operator is asking what the NODE is doing.
    expect(within(row).getByText('running')).toBeInTheDocument();
    expect(within(row).queryByText('dispatched')).not.toBeInTheDocument();
  });

  /**
   * The reconciliation is GATED on a complete replay, and this is the case that
   * gate exists for. A projection of a half-replayed log holds nodes the run has
   * in fact moved past, so letting it win would overwrite live rows with
   * `pending` — the same falsehood the ticket closes, arriving from the other
   * side. Mid-replay the doc-free fold stands alone.
   */
  it('does not let a HALF-REPLAYED projection mint rows or overrule the fold', async () => {
    useRunStreamMock.mockReturnValue(
      stream({
        phase: 'replaying',
        replayComplete: false,
        events: [
          envelope({
            type: 'timer.waitScheduled',
            runId: 'run_1',
            nodeId: 'greet',
            attemptId: 'greet#0',
            dueAt: 1_700_000_000_000,
          }),
        ],
      }),
    );
    renderWithRouter(<RunDetailPage runId="run_1" />);

    // The parked row is the fold's, and it says WHICH alarm — one word
    // ("waiting") could not tell a timer from an awaited inbound callback.
    const row = (await screen.findByRole('button', { name: 'HTTP Request 1' })).closest('tr')!;
    expect(within(row).getByText('waiting (timer)')).toBeInTheDocument();
    // …and no row was minted for the node the projection would have seeded.
    expect(screen.queryByText('never')).not.toBeInTheDocument();
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
    const nodeCell = await screen.findByRole('button', { name: 'HTTP Request 1' });
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
    useRunStreamMock.mockReturnValue(
      stream({ phase: 'replaying', events: [], replayComplete: false }),
    );
    renderWithRouter(<RunDetailPage runId="run_1" />);

    expect(await screen.findByTestId('run-canvas')).toBeInTheDocument();
    expect(screen.getByText(/Loading this run’s history/i)).toBeInTheDocument();
  });

  it('U11 — refuses to project a log the stream CLOSED before finishing, and says why', async () => {
    // `closed` is set by any orderly close, including one mid-replay. Reading it
    // as "the log is complete" would present a TRUNCATED log as authoritative —
    // a finished run drawn with one node stuck dispatched and the rest pending,
    // indistinguishable from the truth.
    useRunStreamMock.mockReturnValue(
      stream({
        phase: 'closed',
        replayComplete: false,
        events: [
          envelope({ type: 'run.started', runId: 'run_1', pipelineVersionId: 'pv_1', params: {} }),
        ],
      }),
    );
    renderWithRouter(<RunDetailPage runId="run_1" />);

    expect(await screen.findByTestId('run-canvas')).toBeInTheDocument();
    expect(
      screen.getByText(/ended before this run’s history finished loading/i),
    ).toBeInTheDocument();
  });

  it('U11 — KEEPS the overlay when the socket errors AFTER a complete replay', async () => {
    // The error path preserves `events`, so the log in hand is still the whole
    // run as of the last frame. Discarding a valid projection over a connection
    // that has merely stopped delivering new frames loses a correct picture; the
    // stream error is reported separately, as its own alert.
    useRunStreamMock.mockReturnValue(
      stream({
        phase: 'error',
        error: 'socket closed',
        replayComplete: true,
        events: [
          envelope({ type: 'run.started', runId: 'run_1', pipelineVersionId: 'pv_1', params: {} }),
        ],
      }),
    );
    renderWithRouter(<RunDetailPage runId="run_1" />);

    expect(await screen.findByTestId('run-canvas')).toBeInTheDocument();
    expect(screen.queryByText(/cannot be projected/i)).not.toBeInTheDocument();
    // …and the connection problem is still reported.
    expect(screen.getByText('socket closed')).toBeInTheDocument();
  });

  it('U11 — says the overlay is unavailable when the stream errored BEFORE replaying', async () => {
    // R1 carries no `events`, so an overlay that never got a replay has no
    // source at all. Stated on screen rather than drawn as an all-blank graph.
    useRunStreamMock.mockReturnValue(
      stream({ phase: 'error', error: 'socket closed', replayComplete: false }),
    );
    renderWithRouter(<RunDetailPage runId="run_1" />);

    expect(await screen.findByTestId('run-canvas')).toBeInTheDocument();
    expect(screen.getByText(/event stream is unavailable/i)).toBeInTheDocument();
  });

  it('U11 — a doc that will not resolve costs the OVERLAY, not the run’s metadata', async () => {
    // R1 resolves the run and its doc together, so a 409 on the doc must not
    // take the metadata, node table and feed with it — a run whose graph is
    // gone is exactly when those matter most.
    getRunDetailMock.mockRejectedValue(new Error('pipeline version not found'));
    const getRunMock = vi.mocked(runsApi.getRun);
    getRunMock.mockResolvedValue(run());

    renderWithRouter(<RunDetailPage runId="run_1" />);

    expect(await screen.findByText('pv_1')).toBeInTheDocument();
    expect(screen.getByText('{"greeting":"hi"}')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/no node overlay/i);
    expect(screen.queryByTestId('run-canvas')).not.toBeInTheDocument();
  });

  /**
   * #870 — the run header, one level up from U25's node table.
   *
   * The park events used here are the same ones the reducer folds, so these
   * assert the RENDERED word against a real log rather than against a
   * hand-built status.
   */
  describe('#870 — the run header says WHY a parked run is parked', () => {
    /* Scoped to the HEADER pill. The node table words its own parks through
       `nodeStatusLabel` and lands on the same string for the same alarm, so an
       unscoped `findByText('waiting (timer)')` matches both and throws — which
       is itself a small proof that the two vocabularies now agree. */
    const headerPill = () => screen.findByText(/./, { selector: '.page-hint .run-status' });

    const parked = (reason: 'waiting_timer' | 'waiting_external') => [
      envelope({ type: 'run.started', runId: 'run_1', pipelineVersionId: 'pv_1', params: {} }),
      envelope({ type: 'run.waiting', runId: 'run_1', reason }),
    ];

    it('reads `waiting (timer)`, not a bare `waiting`', async () => {
      useRunStreamMock.mockReturnValue(stream({ events: parked('waiting_timer') }));
      renderWithRouter(<RunDetailPage runId="run_1" />);
      expect(await headerPill()).toHaveTextContent('waiting (timer)');
      expect(screen.queryByText('waiting')).not.toBeInTheDocument();
    });

    it('reads `waiting (callback)` for an inbound external wait', async () => {
      useRunStreamMock.mockReturnValue(stream({ events: parked('waiting_external') }));
      renderWithRouter(<RunDetailPage runId="run_1" />);
      expect(await headerPill()).toHaveTextContent('waiting (callback)');
    });

    /**
     * The reason survives the loss of the doc. This is the case the doc-free
     * fold exists for, and the one where a parked run most needs reading — so
     * it must not be the case that loses the answer.
     */
    it('still says why when the pipeline version will not resolve', async () => {
      getRunDetailMock.mockRejectedValue(new Error('pipeline version not found'));
      vi.mocked(runsApi.getRun).mockResolvedValue(run({ status: 'waiting' }));
      useRunStreamMock.mockReturnValue(stream({ events: parked('waiting_timer') }));

      renderWithRouter(<RunDetailPage runId="run_1" />);
      expect(await headerPill()).toHaveTextContent('waiting (timer)');
    });

    /**
     * The row is the fallback while no lifecycle event has landed, and it must
     * survive a fully-loaded page. A `queued` run has a version, a doc and a
     * ready projection — and an EMPTY event log, because admission has not
     * driven it yet.
     */
    it('shows a `queued` row through the shared vocabulary, with a doc loaded', async () => {
      getRunDetailMock.mockResolvedValue({
        run: run({ status: 'queued' }),
        pipelineVersion: version(),
      });
      useRunStreamMock.mockReturnValue(stream({ events: [] }));

      renderWithRouter(<RunDetailPage runId="run_1" />);
      expect(await headerPill()).toHaveTextContent('queued (slot)');
      expect(screen.queryByText('pending')).not.toBeInTheDocument();
    });

    /**
     * WHY A TERMINAL IS THE FOLD'S ANSWER AND THE PARK IS THE ENGINE'S — both
     * halves pinned as facts about the reducer, so neither is a comment nobody
     * can check.
     *
     * The doc here is a single `wait` node, which makes both a real park and a
     * possible terminal expressible in one fixture. The page's own two-node
     * `version()` cannot express the terminal half: `run.finished` on a run
     * whose nodes are not all terminal is an IMPOSSIBLE event the reducer
     * rejects outright, and an earlier draft of this test measured exactly that
     * rejection and generalised it into a false claim that the reducer never
     * folds terminals at all. It does.
     */
    describe('the split of authority', () => {
      const waitDoc = () =>
        version({
          nodes: [
            { id: 'hold', type: 'wait', position: { x: 0, y: 0 }, config: { seconds: '${1}' } },
          ],
          edges: [],
        });
      const startEv = () =>
        envelope({ type: 'run.started', runId: 'run_1', pipelineVersionId: 'pv_1', params: {} });
      const scheduleEv = () =>
        envelope({
          type: 'timer.waitScheduled',
          runId: 'run_1',
          nodeId: 'hold',
          attemptId: 'hold#0',
          dueAt: 9_999_999_999_999,
        });
      const parkEv = () =>
        envelope({ type: 'run.waiting', runId: 'run_1', reason: 'waiting_timer' });

      /**
       * A terminal arriving on a PARKED run is not folded by the reducer at all
       * — its top-level guard admits only unpark events on a non-`running` run
       * — so the projection stays `waiting` while `terminalFactFromLog` and the
       * runs-list row both say `failure`. The fold reads terminals through the
       * same `terminalStatusOf` the server does, so it agrees with the row.
       */
      it('reports a terminal on a parked run, which its PROJECTION does not', async () => {
        const events = [startEv(), scheduleEv(), parkEv()];
        const terminated = [
          ...events,
          envelope({ type: 'run.finished', runId: 'run_1', outcome: 'failure' }),
        ];
        getRunDetailMock.mockResolvedValue({ run: run(), pipelineVersion: waitDoc() });
        useRunStreamMock.mockReturnValue(stream({ events: terminated }));
        renderWithRouter(<RunDetailPage runId="run_1" />);

        expect(await headerPill()).toHaveTextContent('failure');
        // The projection this page holds for the same log is still parked.
        const projected = projectRun(waitDoc(), terminated);
        expect(projected.ok && projected.state.status).toBe('waiting');
      });

      /**
       * THE OTHER DIRECTION, and the reason the park is NOT the fold's. The
       * reducer un-parks only when the parked node is still at the attempt the
       * alarm names; a redelivered or superseded `timer.due` no-ops and the run
       * stays parked. The doc-free fold has no node state, so it un-parks on
       * any of them — and the ROW stays `waiting`, so trusting the fold here
       * would put this header at odds with the runs list.
       */
      it('stays parked on a STALE timer.due, as the engine does — not un-parked as the fold would', async () => {
        const events = [
          startEv(),
          scheduleEv(),
          parkEv(),
          envelope({
            type: 'timer.due',
            runId: 'run_1',
            nodeId: 'hold',
            previousAttemptId: 'hold#99',
          }),
        ];
        getRunDetailMock.mockResolvedValue({ run: run(), pipelineVersion: waitDoc() });
        useRunStreamMock.mockReturnValue(stream({ events }));
        renderWithRouter(<RunDetailPage runId="run_1" />);

        expect(await headerPill()).toHaveTextContent('waiting (timer)');
        // The doc-free fold, left to itself, would have said `running` here.
        expect(deriveRunLifecycle(events)).toEqual({ status: 'running', waitingReason: null });
      });

      /** A MATCHING alarm un-parks both, so the header advances. */
      it('un-parks on a matching timer.due', async () => {
        const events = [
          startEv(),
          scheduleEv(),
          parkEv(),
          envelope({
            type: 'timer.due',
            runId: 'run_1',
            nodeId: 'hold',
            previousAttemptId: 'hold#0',
          }),
        ];
        getRunDetailMock.mockResolvedValue({ run: run(), pipelineVersion: waitDoc() });
        useRunStreamMock.mockReturnValue(stream({ events }));
        renderWithRouter(<RunDetailPage runId="run_1" />);

        expect(await headerPill()).toHaveTextContent('running');
      });
    });
  });

  it('U11 — only when the plain run read ALSO fails is the page empty', async () => {
    getRunDetailMock.mockRejectedValue(new Error('detail exploded'));
    vi.mocked(runsApi.getRun).mockRejectedValue(new Error('run gone'));

    renderWithRouter(<RunDetailPage runId="run_1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('detail exploded');
  });

  it('surfaces a stream error', async () => {
    useRunStreamMock.mockReturnValue(
      stream({ phase: 'error', error: 'run not found or not accessible' }),
    );
    renderWithRouter(<RunDetailPage runId="run_x" />);
    expect(await screen.findByText(/not found or not accessible/i)).toBeInTheDocument();
  });
});

describe('RunDetailPage — U24 the failure class and the node drill-in', () => {
  /** A run whose `greet` node failed with a full F0 class. */
  function failedStream(overrides: Partial<EngineEvent & { kind: string }> = {}) {
    return stream({
      events: [
        envelope({
          type: 'node.dispatched',
          runId: 'run_1',
          nodeId: 'greet',
          attemptId: 'greet#0',
          idempotent: true,
        }),
        envelope({ type: 'node.output', runId: 'run_1', nodeId: 'greet', name: 'chunk', value: 1 }),
        envelope({
          type: 'node.failed',
          runId: 'run_1',
          nodeId: 'greet',
          attemptId: 'greet#0',
          error: 'boom',
          kind: 'transient',
          code: 'rate_limit',
          ...overrides,
        } as EngineEvent),
      ],
    });
  }

  it('names the failure CLASS in the node table, not just the message', async () => {
    useRunStreamMock.mockReturnValue(failedStream());
    renderWithRouter(<RunDetailPage runId="run_1" />);
    expect(await screen.findByText('boom (transient · rate_limit)')).toBeInTheDocument();
  });

  it('opens a drill-in for the node clicked, and closes it again', async () => {
    useRunStreamMock.mockReturnValue(failedStream());
    const user = userEvent.setup();
    renderWithRouter(<RunDetailPage runId="run_1" />);

    expect(
      screen.queryByRole('complementary', { name: /Node HTTP Request 1/ }),
    ).not.toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'HTTP Request 1' }));
    const panel = screen.getByRole('complementary', { name: /Node HTTP Request 1/ });
    // The class the table compresses into one line, spelled out as fields.
    expect(within(panel).getByText('transient')).toBeInTheDocument();
    expect(within(panel).getByText('rate_limit')).toBeInTheDocument();
    expect(within(panel).getByText('boom')).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(
      screen.queryByRole('complementary', { name: /Node HTTP Request 1/ }),
    ).not.toBeInTheDocument();
  });

  /**
   * #882 — the node table and the drill-in name a node the way the GRAPH beside
   * them does.
   *
   * The graph has said `HTTP Request 1` since #878 while these two said
   * `n_7c44a16f-98f1-4958-…`, so an operator reading "HTTP Request 1 failed" off
   * the picture could not find that row in the table directly underneath it, and
   * could not search for it either. One view, two vocabularies — the exact defect
   * #878 exists to prevent, arriving inside the view it was built for.
   *
   * The raw id is KEPT, beside the name rather than instead of it. It is the only
   * string that matches the `${nodes.<id>.output.…}` expressions in the doc and
   * the ids in the raw event feed further down this same page, so a straight swap
   * would close one lookup by breaking another.
   *
   * It sits OUTSIDE the disclosure button on purpose: text inside a button
   * becomes part of its accessible name, and `HTTP Request 1 n_7c44a16f-98f1-…`
   * is what a screen reader would then have to read out on every row. Outside, the
   * button's visible label and its accessible name are the same string — which is
   * also what WCAG 2.5.3 asks for — and the id is still on screen to copy.
   */
  describe('#882 — the table and the drill-in name a node, not an id', () => {
    it('names the row by its activity, and keeps the raw id beside it', async () => {
      useRunStreamMock.mockReturnValue(failedStream());
      renderWithRouter(<RunDetailPage runId="run_1" />);

      // The name is the button — the thing the graph says and the operator reads.
      const button = await screen.findByRole('button', { name: 'HTTP Request 1' });
      const row = button.closest('tr')!;
      // …and the id is still THERE, just not the label.
      expect(within(row).getByText('greet')).toBeInTheDocument();
      expect(button).not.toHaveAccessibleName(/greet/);
    });

    it('falls back to the raw id when the pipeline version will not resolve', async () => {
      /* The doc is the ONLY source of a name, and this page is built to keep
         working without it (U11). So the honest fallback is the id it has always
         shown — never an invented placeholder, which would be a THIRD name for
         the same node. */
      getRunDetailMock.mockRejectedValue(new Error('pipeline version not found'));
      vi.mocked(runsApi.getRun).mockResolvedValue(run());
      useRunStreamMock.mockReturnValue(failedStream());

      renderWithRouter(<RunDetailPage runId="run_1" />);

      expect(await screen.findByRole('button', { name: 'greet' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'HTTP Request 1' })).not.toBeInTheDocument();
    });

    it('falls back to the raw id for a row the bound doc does not name', async () => {
      /* The rows come from the RUN, the names from the DOC, and the two lists are
         not the same list: a rerun can carry a node the doc no longer has. That
         row is named by the only thing that is true about it. */
      getRunDetailMock.mockResolvedValue({
        run: run(),
        pipelineVersion: version({
          nodes: [{ id: 'greet', type: 'http_request', position: { x: 0, y: 0 }, config: {} }],
          edges: [],
        }),
      });
      useRunStreamMock.mockReturnValue(
        stream({
          events: [
            envelope({
              type: 'node.dispatched',
              runId: 'run_1',
              nodeId: 'ghost',
              attemptId: 'ghost#0',
              idempotent: true,
            }),
          ],
        }),
      );

      renderWithRouter(<RunDetailPage runId="run_1" />);
      expect(await screen.findByRole('button', { name: 'ghost' })).toBeInTheDocument();
    });

    it('names the drill-in panel by the activity, with the id inside it', async () => {
      useRunStreamMock.mockReturnValue(failedStream());
      const user = userEvent.setup();
      renderWithRouter(<RunDetailPage runId="run_1" />);

      await user.click(await screen.findByRole('button', { name: 'HTTP Request 1' }));
      const panel = screen.getByRole('complementary', { name: 'Node HTTP Request 1' });
      // The id the panel's `${nodes.<id>…}` expressions and the event feed use.
      expect(within(panel).getByText('greet')).toBeInTheDocument();
    });
  });

  it('shows a succeeded node’s DECLARED outputs — the thing nothing rendered before', async () => {
    useRunStreamMock.mockReturnValue(
      stream({
        events: [
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
            outputs: { body: 'hello', status: 200 },
          }),
        ],
      }),
    );
    const user = userEvent.setup();
    renderWithRouter(<RunDetailPage runId="run_1" />);
    await user.click(await screen.findByRole('button', { name: 'HTTP Request 1' }));
    const panel = screen.getByRole('complementary', { name: /Node HTTP Request 1/ });
    expect(within(panel).getByText('{"body":"hello","status":200}')).toBeInTheDocument();
  });

  it('states the ABSENCE of a class rather than inventing one', async () => {
    // An expired external wait fails the node off its own alarm — there is no
    // `node.failed` behind it, so there is no kind to show.
    useRunStreamMock.mockReturnValue(
      stream({
        events: [
          envelope({
            type: 'externalWait.created',
            runId: 'run_1',
            nodeId: 'greet',
            attemptId: 'greet#0',
            dueAt: 5,
          }),
          envelope({
            type: 'externalWait.expired',
            runId: 'run_1',
            nodeId: 'greet',
            previousAttemptId: 'greet#0',
          }),
        ],
      }),
    );
    const user = userEvent.setup();
    renderWithRouter(<RunDetailPage runId="run_1" />);
    await user.click(await screen.findByRole('button', { name: 'HTTP Request 1' }));
    const panel = screen.getByRole('complementary', { name: /Node HTTP Request 1/ });
    expect(within(panel).getByText(/without a machine-readable class/i)).toBeInTheDocument();
  });

  it('names the instance KEY a collapsed result came from, without asserting a cause', async () => {
    useRunStreamMock.mockReturnValue(
      stream({
        events: [
          envelope({
            type: 'node.dispatched',
            runId: 'run_1',
            nodeId: 'greet@1',
            attemptId: 'greet@1#0',
            idempotent: true,
          }),
          envelope({
            type: 'node.succeeded',
            runId: 'run_1',
            nodeId: 'greet@1',
            attemptId: 'greet@1#0',
            outputs: { body: 'one item' },
          }),
        ],
      }),
    );
    const user = userEvent.setup();
    renderWithRouter(<RunDetailPage runId="run_1" />);
    await user.click(await screen.findByRole('button', { name: 'HTTP Request 1' }));
    const panel = screen.getByRole('complementary', { name: /Node HTTP Request 1/ });
    expect(within(panel).getByText('greet@1')).toBeInTheDocument();
    expect(within(panel).getByText(/fold onto the one node you drew/i)).toBeInTheDocument();
    // It names the KEY, never a cause: a SEQUENTIAL doc may legitimately
    // carry a literal `x@2` id, so 'a parallel foreach' would be a claim the
    // doc-free view cannot make.
    expect(within(panel).queryByText(/parallel foreach's items all/i)).not.toBeInTheDocument();
  });

  it('the event feed names the failure class too', async () => {
    useRunStreamMock.mockReturnValue(failedStream());
    renderWithRouter(<RunDetailPage runId="run_1" />);
    expect(
      await screen.findByText('node=greet error=boom kind=transient code=rate_limit'),
    ).toBeInTheDocument();
  });
});

describe('RunDetailPage — U24 the states a single well-formed failure does not cover', () => {
  it('a failed CALL node gets a Failure section, though it has no message of its own', async () => {
    // Gating the section on `error` hid it entirely for a call node: the child
    // run's verdict is the failure, and there is no message to quote.
    useRunStreamMock.mockReturnValue(
      stream({
        events: [
          envelope({
            type: 'call.returned',
            runId: 'run_1',
            callNodeId: 'greet',
            attemptId: 'greet#0',
            childRunId: 'run_child',
            childOutcome: 'failure',
            outputs: {},
          }),
        ],
      }),
    );
    const user = userEvent.setup();
    renderWithRouter(<RunDetailPage runId="run_1" />);
    await user.click(await screen.findByRole('button', { name: 'HTTP Request 1' }));
    const panel = screen.getByRole('complementary', { name: /Node HTTP Request 1/ });
    expect(within(panel).getByText(/reports another run/i)).toBeInTheDocument();
  });

  it('keeps the class on screen through a retry HOLD — it is the reason for the hold', async () => {
    useRunStreamMock.mockReturnValue(
      stream({
        events: [
          envelope({
            type: 'node.dispatched',
            runId: 'run_1',
            nodeId: 'greet',
            attemptId: 'greet#0',
            idempotent: true,
          }),
          envelope({
            type: 'node.failed',
            runId: 'run_1',
            nodeId: 'greet',
            attemptId: 'greet#0',
            error: 'throttled',
            kind: 'transient',
            code: 'rate_limit',
          }),
          envelope({
            type: 'node.retryScheduled',
            runId: 'run_1',
            nodeId: 'greet',
            attemptId: 'greet#0',
            nextAttemptAt: 1,
          }),
        ],
      }),
    );
    renderWithRouter(<RunDetailPage runId="run_1" />);
    expect(
      await screen.findByRole('cell', { name: 'throttled (transient · rate_limit)' }),
    ).toBeInTheDocument();
    expect(screen.getByText('retrying')).toBeInTheDocument();
  });

  it('the OPEN panel tracks the node as later frames arrive', async () => {
    // The panel resolves its node from the live fold rather than snapshotting a
    // row, which is the whole reason it can be opened on a running node.
    const dispatched = envelope({
      type: 'node.dispatched',
      runId: 'run_1',
      nodeId: 'greet',
      attemptId: 'greet#0',
      idempotent: true,
    });
    useRunStreamMock.mockReturnValue(stream({ events: [dispatched] }));
    const user = userEvent.setup();
    const { rerender } = renderWithRouter(<RunDetailPage runId="run_1" />);
    await user.click(await screen.findByRole('button', { name: 'HTTP Request 1' }));
    expect(
      within(screen.getByRole('complementary', { name: /Node HTTP Request 1/ })).getByText('running'),
    ).toBeInTheDocument();

    useRunStreamMock.mockReturnValue(
      stream({
        events: [
          dispatched,
          envelope({
            type: 'node.failed',
            runId: 'run_1',
            nodeId: 'greet',
            attemptId: 'greet#0',
            error: 'boom',
            kind: 'permanent',
            code: 'auth',
          }),
        ],
      }),
    );
    rerender(
      <MemoryRouter>
        <RunDetailPage runId="run_1" />
      </MemoryRouter>,
    );
    const panel = screen.getByRole('complementary', { name: /Node HTTP Request 1/ });
    expect(within(panel).getByText('failure')).toBeInTheDocument();
    expect(within(panel).getByText('auth')).toBeInTheDocument();
  });
});
