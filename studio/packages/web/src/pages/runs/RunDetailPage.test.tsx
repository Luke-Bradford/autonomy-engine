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
  rerunFromFailed: vi.fn(),
  /* Defaulted to `[]` rather than a bare `vi.fn()`, and listed HERE rather than
     left to fall through to the real module. An un-mocked member of this module
     reaches `fetch`, which jsdom cannot serve; the rejection lands inside an
     effect and vitest reports it as an unhandled error that fails the file
     BEFORE its assertions run — the failure mode filed as #897. A resolved
     default also means every existing test in this file keeps describing a run
     that owes no callback, which is what they all are. */
  listExternalWaits: vi.fn().mockResolvedValue([]),
  /* Mocked so an un-mocked write cannot reach `fetch`. NOT for the #897 reason
     above, which is specific to a member called from a MOUNT EFFECT: this one is
     only reachable from a click, so no other test in this file can trigger it. */
  completeExternalWait: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./useRunStream', async (importActual) => ({
  ...(await importActual<typeof import('./useRunStream')>()),
  useRunStream: vi.fn(),
}));

const getRunDetailMock = vi.mocked(runsApi.getRunDetail);
const rerunFromFailedMock = vi.mocked(runsApi.rerunFromFailed);
const listExternalWaitsMock = vi.mocked(runsApi.listExternalWaits);
const completeExternalWaitMock = vi.mocked(runsApi.completeExternalWait);
const useRunStreamMock = vi.mocked(hook.useRunStream);

let seq = 0;
/** `at` pins the envelope `ts` — the append clock the #867 duration reads. */
function envelope(event: EngineEvent, at?: number): RunEvent {
  return {
    id: `evt_${seq}`,
    runId: event.runId,
    seq: seq++,
    type: event.type,
    payload: event,
    ts: at ?? seq,
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

/**
 * A doc whose only node is a `webhook`, optionally with a declared output
 * contract. Module-scope because two describes park a run on a callback — #900's
 * pending-callbacks list and #911's drill-in outputs — and a second copy of this
 * would be a fixture that can drift from the first.
 */
const approvalDoc = (outputs?: unknown) =>
  version({
    nodes: [
      {
        id: 'approve',
        type: 'webhook',
        position: { x: 0, y: 0 },
        config:
          outputs === undefined
            ? { timeoutSeconds: '${600}' }
            : { timeoutSeconds: '${600}', outputs },
      },
    ],
    edges: [],
  });

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
       is itself a small proof that the two vocabularies now agree.

       #894 — this awaits the pill SAYING `text`, and used to await `/./`: any
       non-empty pill. That was the flake, and not the timeout it was filed as.
       The pill renders unconditionally (there is no loading early-return), so on
       the first synchronous frame it reads whatever the DOC-FREE fold makes of
       the log — `running` for a stale-alarm park, `pending` for an empty log —
       and testing-library runs its check callback synchronously before
       installing any observer. So `/./` resolved on that first frame and the
       `toHaveTextContent` after it ran ONCE, with no retry, racing
       `getRunDetail`'s resolution through a single macrotask drain. Under suite
       contention that drain lost.

       The matcher is a substring test rather than an exact one so that it keeps
       the semantics of the `toHaveTextContent` calls beside it — which STAY,
       and are not folded into this query. The two have different jobs: the
       query decides when to stop waiting, the assertion decides whether the
       answer is right. Collapsing them reads tidier and is how the first draft
       of this fix went vacuous — with the text checked only inside the query,
       reinstating the old `/./` left NOTHING asserting the text, so the
       regression test below passed against the very defect it pins. */
    const headerPill = (text: string) =>
      screen.findByText((content) => content.includes(text), {
        selector: '.page-hint .run-status',
      });

    const parked = (reason: 'waiting_timer' | 'waiting_external') => [
      envelope({ type: 'run.started', runId: 'run_1', pipelineVersionId: 'pv_1', params: {} }),
      envelope({ type: 'run.waiting', runId: 'run_1', reason }),
    ];

    it('reads `waiting (timer)`, not a bare `waiting`', async () => {
      useRunStreamMock.mockReturnValue(stream({ events: parked('waiting_timer') }));
      renderWithRouter(<RunDetailPage runId="run_1" />);
      expect(await headerPill('waiting (timer)')).toHaveTextContent('waiting (timer)');
      expect(screen.queryByText('waiting')).not.toBeInTheDocument();
    });

    it('reads `waiting (callback)` for an inbound external wait', async () => {
      useRunStreamMock.mockReturnValue(stream({ events: parked('waiting_external') }));
      renderWithRouter(<RunDetailPage runId="run_1" />);
      expect(await headerPill('waiting (callback)')).toHaveTextContent('waiting (callback)');
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
      expect(await headerPill('waiting (timer)')).toHaveTextContent('waiting (timer)');
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
      expect(await headerPill('queued (slot)')).toHaveTextContent('queued (slot)');
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

        expect(await headerPill('failure')).toHaveTextContent('failure');
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

        expect(await headerPill('waiting (timer)')).toHaveTextContent('waiting (timer)');
        // The doc-free fold, left to itself, would have said `running` here.
        expect(deriveRunLifecycle(events)).toEqual({ status: 'running', waitingReason: null });
      });

      /**
       * #894 — the regression pin for the flake, and for its whole class.
       *
       * The case above is the one that flaked, and the mechanism was never the
       * timeout it was filed as: the pill renders unconditionally, so it is
       * ALREADY on screen holding the fold's `running` before `getRunDetail`
       * resolves. A query that waits for "a pill" rather than for "the pill
       * saying X" therefore settles on that first frame, leaving the assertion
       * after it a single macrotask in which to become right — which is what
       * lost under four-worker contention.
       *
       * Here the detail is held open past that drain deliberately, so a query
       * with that defect cannot pass by luck the way it did in isolation. The
       * first frame is pinned as the fold's word precisely so that the wait
       * after it is load-bearing rather than decorative.
       */
      it('waits for what the pill SAYS, not merely for a pill — the doc can land late', async () => {
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
        /* A TIMER, not a promise resolved inline. Resolving inline still lets
           the microtask queue drain during the very `await` below, so the doc
           lands in time even for a query that never really waited — which is
           exactly how the flake hid in isolation and only surfaced under
           contention. Landing it a macrotask out reproduces the losing side
           deterministically, so this test can actually fail. */
        getRunDetailMock.mockReturnValue(
          new Promise<{ run: Run; pipelineVersion: PipelineVersion }>((resolve) =>
            setTimeout(() => resolve({ run: run(), pipelineVersion: waitDoc() }), 50),
          ),
        );
        useRunStreamMock.mockReturnValue(stream({ events }));

        renderWithRouter(<RunDetailPage runId="run_1" />);

        expect(document.querySelector('.page-hint .run-status')?.textContent).toBe('running');
        expect(await headerPill('waiting (timer)')).toHaveTextContent('waiting (timer)');
      });

      /**
       * A MATCHING alarm un-parks both, so the header advances.
       *
       * #894 — the fold and the reducer AGREE on `running` here, which is the
       * whole point of the case and also why the pill ALONE cannot witness it:
       * `running` is what the doc-free first frame says too, so awaiting it
       * would pass even if the detail never resolved. The wait on the version
       * id is the gate — it renders only once `getRunDetail` has landed — so
       * what is asserted is the doc-aware answer rather than the fold's. The
       * STALE case above is where the two diverge, and is the discriminating
       * half of the pair.
       */
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

        await screen.findByText('pv_1');
        expect(await headerPill('running')).toHaveTextContent('running');
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
   * button's visible label and its accessible name are the same string, and the id
   * is still on screen to copy. (Both shapes satisfy WCAG 2.5.3, which asks only
   * that the accessible name CONTAIN the visible label — so the SC does not decide
   * this; the uuid-per-row readout does.)
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
         not the same list. The fixture is the case that is actually REACHABLE,
         which is narrower than "the doc changed": a rerun cannot produce one
         (`reseed` pins the run's own immutable `pipelineVersionId`). What can is
         the instance-key fold — `deriveNodeActivity` folds `x@2` onto `x`, and a
         doc whose LITERAL node id is `x@2` is folded with it, so a doc carrying
         `x@2` and no `x` yields a row `x` that no doc node names.

         Left as `x`, therefore: the fold key, which is what the event feed is
         keyed on. Never an invented placeholder — `nameOf` returning something
         readable-but-false here is the defect, not the fallback. */
      getRunDetailMock.mockResolvedValue({
        run: run(),
        pipelineVersion: version({
          nodes: [{ id: 'x@2', type: 'http_request', position: { x: 0, y: 0 }, config: {} }],
          edges: [],
        }),
      });
      useRunStreamMock.mockReturnValue(
        stream({
          events: [
            envelope({
              type: 'node.dispatched',
              runId: 'run_1',
              nodeId: 'x@2',
              attemptId: 'x@2#0',
              idempotent: true,
            }),
          ],
        }),
      );

      renderWithRouter(<RunDetailPage runId="run_1" />);
      // The FOLD key, not the doc id — `x@2`'s events land on row `x`, which
      // `activityLabels` (keyed on `x@2`) cannot name.
      expect(await screen.findByRole('button', { name: 'x' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'HTTP Request 1' })).not.toBeInTheDocument();
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

/**
 * #911 — the drill-in's Outputs section, on a node whose success event is NOT
 * `node.succeeded`.
 *
 * Pinned HERE as well as in `runSummary.test.ts` because the fold and the gate
 * are two halves of one behaviour and each is green without the other — the fold
 * tests would all still pass if `NodeActivityPanel` re-gated the section. The
 * existing panel test above covers the SUCCEEDED case; these cover the three
 * arms the section's gate can take (a value, an empty result, no result), on the
 * lifecycle that has none of them.
 */
describe('RunDetailPage — a parked node’s outputs reach the drill-in (#911)', () => {
  const park = () => [
    envelope({ type: 'run.started', runId: 'run_1', pipelineVersionId: 'pv_1', params: {} }),
    envelope({
      type: 'externalWait.created',
      runId: 'run_1',
      nodeId: 'approve',
      attemptId: 'approve#0',
      dueAt: 9_999_999_999_999,
    }),
  ];

  /** The park, then its callback. `outputs` omitted entirely = the pre-A16 shape. */
  const completed = (outputs?: Record<string, unknown>) =>
    stream({
      events: [
        ...park(),
        envelope({
          type: 'externalWait.completed',
          runId: 'run_1',
          nodeId: 'approve',
          previousAttemptId: 'approve#0',
          outputs,
        }),
      ],
    });

  async function openPanel() {
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Webhook (external wait) 1' }));
    return screen.getByRole('complementary', { name: /Node Webhook \(external wait\) 1/ });
  }

  beforeEach(() => {
    getRunDetailMock.mockResolvedValue({
      run: run(),
      pipelineVersion: approvalDoc([{ name: 'decision', type: 'string' }]),
    });
  });

  it('shows the callback payload the completion carried', async () => {
    useRunStreamMock.mockReturnValue(completed({ decision: 'approved in-app' }));
    renderWithRouter(<RunDetailPage runId="run_1" />);

    const panel = await openPanel();
    expect(within(panel).getByRole('heading', { name: 'Outputs' })).toBeInTheDocument();
    expect(within(panel).getByText('{"decision":"approved in-app"}')).toBeInTheDocument();
  });

  it('says a completion carrying nothing RECORDED nothing — without claiming the node declared nothing', async () => {
    // The pre-A16 shape, and the reason the empty-set copy may not talk about
    // the contract: this doc DOES declare `decision`. "Nothing was recorded" is
    // an answer; a missing section is the absence of one, indistinguishable from
    // a node that never finished.
    useRunStreamMock.mockReturnValue(completed());
    renderWithRouter(<RunDetailPage runId="run_1" />);

    const panel = await openPanel();
    expect(within(panel).getByRole('heading', { name: 'Outputs' })).toBeInTheDocument();
    expect(within(panel).getByText('No output values were recorded.')).toBeInTheDocument();
    expect(within(panel).queryByText(/declared no outputs/)).not.toBeInTheDocument();
  });

  it('omits the section entirely while the node is still PARKED — no result is on record yet', async () => {
    useRunStreamMock.mockReturnValue(stream({ events: park() }));
    renderWithRouter(<RunDetailPage runId="run_1" />);

    const panel = await openPanel();
    expect(within(panel).queryByRole('heading', { name: 'Outputs' })).not.toBeInTheDocument();
  });
});

describe('RunDetailPage — a rerun’s COPIED frontier is named as copied (#918 / RS6)', () => {
  /**
   * The reducer writes a copied node `{status:'success', attempts:0}` — byte
   * for byte an executed success — so before this the monitor presented R1's
   * result as R2's work, with no Outputs section to read it in. RS6 asks the
   * MONITOR to distinguish the two, which is why the table cell is asserted
   * here and not only the panel: a distinction you have to click to find does
   * not meet it.
   *
   * The fixture doc's `greet` is the frontier node; `never` is downstream and
   * un-run, so it also pins the negative — a node the reseed did NOT copy must
   * make no claim about a source run.
   */
  /* `rerunOf` on `run.started` is LOAD-BEARING, not decoration. It is what
     makes the reducer DEFER dispatch, leaving the un-progressed run the reseed
     needs; without it the walk marks `greet` `ready` on the first settle, the
     `progressed` impossible-log guard then refuses the reseed outright, and
     `reconcileNodeActivity` overrides the folded `success` with `ready`. That
     is a fixture the pure fold cannot detect (it has no reducer), and it fails
     here — which is the reason this pair of tests runs through the real page. */
  const reseeded = () =>
    stream({
      events: [
        envelope({
          type: 'run.started',
          runId: 'run_1',
          pipelineVersionId: 'pv_1',
          params: {},
          rerunOf: 'run_source',
        }),
        envelope({
          type: 'run.reseeded',
          runId: 'run_1',
          sourceRunId: 'run_source',
          frontier: ['greet'],
          copiedOutputs: { greet: { status: 200 } },
          copiedContainers: {},
        }),
      ],
    });

  it('says “reused from run …” in the node table, without a click', async () => {
    useRunStreamMock.mockReturnValue(reseeded());
    renderWithRouter(<RunDetailPage runId="run_1" />);

    /* Anchored on the drill-in button rather than on the raw id: the id also
       appears in the event feed, and a `findByText` can settle on an element
       from an intermediate render that the next pass replaces. */
    await screen.findByRole('button', { name: 'HTTP Request 1' });
    const copiedRow = screen.getByRole('button', { name: 'HTTP Request 1' }).closest('tr')!;
    expect(within(copiedRow).getByText('success')).toBeInTheDocument();
    expect(within(copiedRow).getByText('reused from run run_source')).toBeInTheDocument();
  });

  it('shows the copied outputs in the drill-in, attributed to the run that computed them', async () => {
    useRunStreamMock.mockReturnValue(reseeded());
    renderWithRouter(<RunDetailPage runId="run_1" />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'HTTP Request 1' }));
    const panel = screen.getByRole('complementary', { name: /Node HTTP Request 1/ });

    // The defect itself: before #918 there was no Outputs section at all here,
    // over a value `${nodes.greet.output.status}` resolves against downstream.
    expect(within(panel).getByText('Outputs')).toBeInTheDocument();
    expect(within(panel).getByText('{"status":200}')).toBeInTheDocument();
    expect(within(panel).getByText(/reused its result from run/)).toBeInTheDocument();
    expect(within(panel).getByText('run_source')).toBeInTheDocument();

    /* The duration sentence has to bend for this row too. A copied node has no
       span and 0 attempts, so it lands on the "has not started" arm — a
       sentence that contradicts the `success` badge and the outputs directly
       above it. */
    expect(
      within(panel).getByText(/not executed in this run, so there is no span to measure/),
    ).toBeInTheDocument();
    expect(within(panel).queryByText(/has not started/)).not.toBeInTheDocument();
  });

  it('claims nothing about a source run for a node the reseed did not copy', async () => {
    useRunStreamMock.mockReturnValue(reseeded());
    renderWithRouter(<RunDetailPage runId="run_1" />);

    /* `never` has no event of its own — it is a row `reconcileNodeActivity`
       SEEDS from the projection. Asserted as what the operator sees rather than
       as `copiedFromRunId === undefined`, which would pass whether or not the
       field existed on a seeded row at all (an absent key and an `undefined`
       one compare equal), i.e. it could not fail. */
    const seededRow = (await screen.findByText('never')).closest('tr')!;
    expect(within(seededRow).queryByText(/reused from run/)).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(seededRow).getByRole('button', { name: 'HTTP Request 2' }));
    const panel = screen.getByRole('complementary', { name: /Node HTTP Request 2/ });
    expect(within(panel).queryByText(/reused its result from run/)).not.toBeInTheDocument();
    /* `never` is downstream of a failure edge the copied `greet` did not take,
       so the reseed leaves it SKIPPED rather than merely unstarted (#1008). */
    expect(
      within(panel).getByText(/routed around, so it was never going to run/i),
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
      within(screen.getByRole('complementary', { name: /Node HTTP Request 1/ })).getByText(
        'running',
      ),
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

describe('RunDetailPage — how long a node took (#867)', () => {
  it('states the span of the latest attempt, and says nothing for a node that never started', async () => {
    // The fixture routes `greet --failure--> never`, so a successful `greet`
    // leaves `never` skipped — a row with no events at all, and therefore no
    // span. It is the em-dash case sitting right beside the measured one.
    useRunStreamMock.mockReturnValue(
      stream({
        events: [
          envelope({ type: 'run.started', runId: 'run_1', pipelineVersionId: 'pv_1', params: {} }),
          envelope(
            {
              type: 'node.dispatched',
              runId: 'run_1',
              nodeId: 'greet',
              attemptId: 'greet#0',
              idempotent: true,
            },
            1_000,
          ),
          envelope(
            {
              type: 'node.succeeded',
              runId: 'run_1',
              nodeId: 'greet',
              attemptId: 'greet#0',
              outputs: {},
            },
            4_200,
          ),
        ],
      }),
    );
    renderWithRouter(<RunDetailPage runId="run_1" />);

    const row = (await screen.findByRole('button', { name: 'HTTP Request 1' })).closest('tr')!;
    expect(within(row).getByText('3s')).toBeInTheDocument();

    const skippedRow = screen.getByText('never').closest('tr')!;
    expect(within(skippedRow).getByText('—')).toBeInTheDocument();
  });

  it('the panel says a node was SKIPPED, not that it has yet to start (#1008)', async () => {
    // Three different absences render the same em-dash, and only one of them is
    // "the engine evaluates this in one step". The fixture routes
    // `greet --failure--> never`, so a successful `greet` leaves `never` with no
    // events at all. Telling an operator it was evaluated in a single step would
    // be a confident, wrong explanation — and so, #1008, is telling them it has
    // not started yet: it was routed around, so it is never going to. The
    // timeline on this same page has always said `skipped` for this node, and
    // the two surfaces described one fact differently.
    useRunStreamMock.mockReturnValue(
      stream({
        events: [
          envelope({ type: 'run.started', runId: 'run_1', pipelineVersionId: 'pv_1', params: {} }),
          envelope(
            {
              type: 'node.dispatched',
              runId: 'run_1',
              nodeId: 'greet',
              attemptId: 'greet#0',
              idempotent: true,
            },
            1_000,
          ),
          envelope(
            {
              type: 'node.succeeded',
              runId: 'run_1',
              nodeId: 'greet',
              attemptId: 'greet#0',
              outputs: {},
            },
            4_200,
          ),
        ],
      }),
    );
    renderWithRouter(<RunDetailPage runId="run_1" />);

    const skippedRow = (await screen.findByText('never')).closest('tr')!;
    await userEvent.click(within(skippedRow).getByRole('button'));
    const panel = screen.getByRole('complementary');
    expect(
      within(panel).getByText(/routed around, so it was never going to run/i),
    ).toBeInTheDocument();
    expect(within(panel).queryByText(/has not started/i)).not.toBeInTheDocument();
  });

  /**
   * #1008's other half — the new arm must not SWALLOW the case it sits in front
   * of. There was no genuinely-unstarted fixture on this page before: every
   * `attempts === 0` row the file rendered was in fact a skipped one, which is
   * exactly how the wrong sentence survived so long. Here `greet` is dispatched
   * and unsettled, so `never` is still `pending` — it really has not started,
   * and really might.
   */
  it('still says a PENDING node has not started (the skipped arm does not swallow it)', async () => {
    useRunStreamMock.mockReturnValue(
      stream({
        events: [
          envelope({ type: 'run.started', runId: 'run_1', pipelineVersionId: 'pv_1', params: {} }),
          envelope(
            {
              type: 'node.dispatched',
              runId: 'run_1',
              nodeId: 'greet',
              attemptId: 'greet#0',
              idempotent: true,
            },
            1_000,
          ),
        ],
      }),
    );
    renderWithRouter(<RunDetailPage runId="run_1" />);

    const pendingRow = (await screen.findByText('never')).closest('tr')!;
    await userEvent.click(within(pendingRow).getByRole('button'));
    const panel = screen.getByRole('complementary');
    expect(
      within(panel).getByText(/has not started, so there is nothing to measure/i),
    ).toBeInTheDocument();
  });

  it('the panel says an attempt is still OPEN rather than claiming a span for it', async () => {
    useRunStreamMock.mockReturnValue(
      stream({
        events: [
          envelope({ type: 'run.started', runId: 'run_1', pipelineVersionId: 'pv_1', params: {} }),
          envelope(
            {
              type: 'node.dispatched',
              runId: 'run_1',
              nodeId: 'greet',
              attemptId: 'greet#0',
              idempotent: true,
            },
            1_000,
          ),
        ],
      }),
    );
    renderWithRouter(<RunDetailPage runId="run_1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'HTTP Request 1' }));

    const panel = screen.getByRole('complementary');
    expect(within(panel).getByText(/has not settled yet/i)).toBeInTheDocument();
  });

  it('the panel names a BACKWARDS span as a clock problem rather than leaving a bare em-dash', async () => {
    // Both stamps come from one single-writer append path, so an end before its
    // start is a corrupt log. It renders as unmeasured (never a clamped 0ms),
    // and this is the arm that stops that em-dash reading as a rendering bug.
    useRunStreamMock.mockReturnValue(
      stream({
        events: [
          envelope({ type: 'run.started', runId: 'run_1', pipelineVersionId: 'pv_1', params: {} }),
          envelope(
            {
              type: 'node.dispatched',
              runId: 'run_1',
              nodeId: 'greet',
              attemptId: 'greet#0',
              idempotent: true,
            },
            9_000,
          ),
          envelope(
            {
              type: 'node.succeeded',
              runId: 'run_1',
              nodeId: 'greet',
              attemptId: 'greet#0',
              outputs: {},
            },
            1_000,
          ),
        ],
      }),
    );
    renderWithRouter(<RunDetailPage runId="run_1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'HTTP Request 1' }));

    const panel = screen.getByRole('complementary');
    expect(within(panel).getByText(/recorded end precedes the start/i)).toBeInTheDocument();
  });

  it('the drill-in panel says what the number MEANS, not just the number', async () => {
    useRunStreamMock.mockReturnValue(
      stream({
        events: [
          envelope({ type: 'run.started', runId: 'run_1', pipelineVersionId: 'pv_1', params: {} }),
          envelope(
            {
              type: 'node.dispatched',
              runId: 'run_1',
              nodeId: 'greet',
              attemptId: 'greet#0',
              idempotent: true,
            },
            1_000,
          ),
          envelope(
            {
              type: 'node.succeeded',
              runId: 'run_1',
              nodeId: 'greet',
              attemptId: 'greet#0',
              outputs: {},
            },
            4_200,
          ),
        ],
      }),
    );
    renderWithRouter(<RunDetailPage runId="run_1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'HTTP Request 1' }));

    const panel = screen.getByRole('complementary');
    // Wall-clock, park-inclusive, retry-hold-exclusive: the three facts that
    // stop this being read as execution time or as an LLM call's latency.
    expect(within(panel).getByText(/wall clock for the latest attempt/i)).toBeInTheDocument();
    expect(within(panel).getByText(/including any wait it parked on/i)).toBeInTheDocument();
    expect(within(panel).getByText(/excluding time held between retries/i)).toBeInTheDocument();
  });
});

describe('RunDetailPage — #866 the drill-in says what a node SPENT and which tools it ran', () => {
  const dispatched = (nodeId: string, attemptId: string): EngineEvent => ({
    type: 'node.dispatched',
    runId: 'run_1',
    nodeId,
    attemptId,
    idempotent: true,
  });
  const metered = (fields: Record<string, unknown> = {}): EngineEvent =>
    ({
      type: 'activity.metered',
      runId: 'run_1',
      nodeId: 'greet',
      attemptId: 'greet#0',
      provider: 'anthropic_api',
      model: 'claude-opus-4-8',
      meteringStatus: 'metered',
      ...fields,
    }) as EngineEvent;

  /** Open the drill-in for `greet` and hand back the panel. */
  async function openPanel(events: EngineEvent[]) {
    useRunStreamMock.mockReturnValue(stream({ events: events.map((e) => envelope(e)) }));
    const user = userEvent.setup();
    renderWithRouter(<RunDetailPage runId="run_1" />);
    await user.click(await screen.findByRole('button', { name: 'HTTP Request 1' }));
    return screen.getByRole('complementary', { name: /Node HTTP Request 1/ });
  }

  it('states a priced node’s cost, its model and its token usage', async () => {
    const panel = await openPanel([
      dispatched('greet', 'greet#0'),
      metered({ inputTokens: 1200, outputTokens: 340, costEstimate: 0.0055 }),
    ]);
    expect(within(panel).getByText('$0.0055')).toBeInTheDocument();
    expect(within(panel).getByText('claude-opus-4-8')).toBeInTheDocument();
    expect(within(panel).getByText('1,200 in · 340 out')).toBeInTheDocument();
  });

  it('never renders a spent-but-unpriceable node as $0.00', async () => {
    const panel = await openPanel([
      dispatched('greet', 'greet#0'),
      // A model with no known price: tokens counted, no `costEstimate` stamped.
      metered({ inputTokens: 10, outputTokens: 5 }),
    ]);
    expect(within(panel).getByText('Cost unknown')).toBeInTheDocument();
    expect(within(panel).queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('renders a lower bound when only SOME exchanges priced', async () => {
    const panel = await openPanel([
      dispatched('greet', 'greet#0'),
      metered({ inputTokens: 10, outputTokens: 5, costEstimate: 0.02 }),
      metered({ inputTokens: 10, outputTokens: 5 }),
    ]);
    expect(within(panel).getByText('At least $0.02')).toBeInTheDocument();
  });

  it('renders an agent_cli node as a covered cost with tokens UNREPORTED, not zero', async () => {
    // `cliSpendFact`: provider `agent_cli`, unpriced, and no token counts at all.
    const panel = await openPanel([
      dispatched('greet', 'greet#0'),
      metered({ provider: 'agent_cli', model: 'cli', meteringStatus: 'unpriced' }),
    ]);
    expect(within(panel).getByText('No marginal cost')).toBeInTheDocument();
    expect(within(panel).getByText('not reported')).toBeInTheDocument();
    expect(within(panel).queryByText(/0 in · 0 out/)).not.toBeInTheDocument();
    // And the count is named as a floor, because a CLI reports none of the model
    // calls it drives internally.
    expect(within(panel).getByText(/floor, not a census/)).toBeInTheDocument();
  });

  it('shows no cost section at all for a node that never billed anything', async () => {
    const panel = await openPanel([
      dispatched('greet', 'greet#0'),
      {
        type: 'node.succeeded',
        runId: 'run_1',
        nodeId: 'greet',
        attemptId: 'greet#0',
        outputs: {},
      },
    ]);
    expect(within(panel).queryByRole('heading', { name: 'Cost & usage' })).not.toBeInTheDocument();
  });

  it('lists the tools the node ran, flagging the ones that errored', async () => {
    const toolCall = (fields: Record<string, unknown>): EngineEvent =>
      ({
        type: 'activity.toolCalled',
        runId: 'run_1',
        nodeId: 'greet',
        attemptId: 'greet#0',
        round: 0,
        toolName: 'read_file',
        argsChars: 12,
        resultChars: 400,
        isError: false,
        ...fields,
      }) as EngineEvent;
    const panel = await openPanel([
      dispatched('greet', 'greet#0'),
      toolCall({ toolName: 'read_file' }),
      toolCall({ toolName: 'grep', round: 1, isError: true }),
    ]);
    expect(within(panel).getByRole('heading', { name: 'Tool calls' })).toBeInTheDocument();
    expect(within(panel).getByText('read_file')).toBeInTheDocument();
    expect(within(panel).getByText('grep')).toBeInTheDocument();
    expect(within(panel).getByText(/1 of which returned an error/)).toBeInTheDocument();
  });

  it('says a tool-running node billed NOTHING, rather than hiding the section', async () => {
    /* The `||` arm: tool calls but no metered response. Reachable, and the case
       where an absent Cost section would be read as "the panel does not do
       cost" rather than as the finding it is — a timed-out provider call
       records no exchange at all, deliberately. */
    const panel = await openPanel([
      dispatched('greet', 'greet#0'),
      {
        type: 'activity.toolCalled',
        runId: 'run_1',
        nodeId: 'greet',
        attemptId: 'greet#0',
        round: 0,
        toolName: 'read_file',
        argsChars: 4,
        resultChars: 8,
        isError: false,
      } as EngineEvent,
    ]);
    expect(within(panel).getByRole('heading', { name: 'Cost & usage' })).toBeInTheDocument();
    expect(within(panel).getByText('No billed exchange')).toBeInTheDocument();
    expect(within(panel).getByText(/TIMED OUT records no exchange/)).toBeInTheDocument();
  });

  it('says a foreach node’s cost SUMS every item, unlike the outputs beside it', async () => {
    const panel = await openPanel([
      dispatched('greet@1', 'greet@1#0'),
      dispatched('greet@2', 'greet@2#0'),
      metered({ nodeId: 'greet@1', inputTokens: 1, outputTokens: 1, costEstimate: 0.1 }),
      metered({ nodeId: 'greet@2', inputTokens: 1, outputTokens: 1, costEstimate: 0.2 }),
    ]);
    expect(within(panel).getByText('$0.30')).toBeInTheDocument();
    expect(within(panel).getByText(/SUMS every result keyed/)).toBeInTheDocument();
  });

  it('names an unnamed tool as unnamed, and truncates a long list out loud', async () => {
    const call = (i: number): EngineEvent =>
      ({
        type: 'activity.toolCalled',
        runId: 'run_1',
        nodeId: 'greet',
        attemptId: 'greet#0',
        round: i,
        // The LAST call is structurally nameless — kept in view by the
        // keep-the-most-recent truncation, which is the point of both halves.
        toolName: i === 120 ? '' : `tool_${i}`,
        argsChars: 1,
        resultChars: 1,
        isError: false,
      }) as EngineEvent;
    const calls = Array.from({ length: 121 }, (_, i) => call(i));
    const panel = await openPanel([dispatched('greet', 'greet#0'), ...calls]);
    expect(within(panel).getByText(/showing the most recent 100 of 121 calls/)).toBeInTheDocument();
    expect(within(panel).getByText('unnamed')).toBeInTheDocument();
    // Truncated from the FRONT: the oldest call is gone, the newest is not.
    expect(within(panel).queryByText('tool_0')).not.toBeInTheDocument();
    expect(within(panel).getByText('tool_119')).toBeInTheDocument();
  });

  it('reports ONE side of a token count without inventing the other', async () => {
    /* `meterUsage` stamps whichever side the provider sent. Rendering the
       unmeasured side as `0 out` is the manufactured zero this panel exists to
       refuse — and it is the arm a single combined "tokens reported" flag got
       wrong. */
    const panel = await openPanel([
      dispatched('greet', 'greet#0'),
      metered({ inputTokens: 4000, meteringStatus: 'unknown' }),
    ]);
    expect(within(panel).getByText('4,000 in · output not reported')).toBeInTheDocument();
    expect(within(panel).queryByText(/0 out/)).not.toBeInTheDocument();
  });

  it('says the token sums are partial when only some exchanges reported a side', async () => {
    const panel = await openPanel([
      dispatched('greet', 'greet#0'),
      metered({ inputTokens: 10, outputTokens: 5, costEstimate: 0.02 }),
      metered({ inputTokens: 10, outputTokens: 5, costEstimate: 0.02 }),
      metered({ outputTokens: 5, meteringStatus: 'unknown' }),
    ]);
    expect(
      within(panel).getByText(/2 of 3 reported input and 3 of 3 reported output/),
    ).toBeInTheDocument();
  });

  it('never composes a lower bound out of an amount too small to state', async () => {
    /* A genuinely-stamped `costEstimate: 0` (a free model in the price table)
       alongside an unpriceable exchange. "At least $0.00" is the exact reading
       this surface exists to prevent, and the sub-micro-dollar case composes into
       the self-contradictory "At least < $0.000001". Both collapse to the one
       true statement: the priced part tells us nothing. */
    const panel = await openPanel([
      dispatched('greet', 'greet#0'),
      metered({ inputTokens: 1, outputTokens: 1, costEstimate: 0 }),
      metered({ inputTokens: 1, outputTokens: 1 }),
    ]);
    expect(within(panel).getByText('Cost unknown')).toBeInTheDocument();
    expect(within(panel).queryByText(/At least/)).not.toBeInTheDocument();
    /* And the SENTENCE agrees with the headline. Promising "the figure" while
       the headline deliberately withheld one is the contradiction the shared
       `statesAnAmount` predicate exists to stop. */
    expect(within(panel).queryByText(/The figure is what the rest cost/)).not.toBeInTheDocument();
    expect(within(panel).getByText(/less than a millionth of a dollar/)).toBeInTheDocument();
  });

  it('says an unsettled node’s spend is SO FAR, not a final figure', async () => {
    // Dispatched and never settled — the live-tail case.
    const panel = await openPanel([
      dispatched('greet', 'greet#0'),
      metered({ inputTokens: 1, outputTokens: 1, costEstimate: 0.5 }),
    ]);
    expect(within(panel).getByText(/spent SO FAR/)).toBeInTheDocument();
  });

  it('does not qualify a FIGURE when the headline never showed one', async () => {
    /* Unsettled, and nothing priced — the headline is "Cost unknown" and its own
       sentence says a number is deliberately not shown. A caveat about "what it
       has spent SO FAR" would qualify a figure that is not on screen. */
    const panel = await openPanel([
      dispatched('greet', 'greet#0'),
      metered({ inputTokens: 10, outputTokens: 5 }),
    ]);
    expect(within(panel).getByText('Cost unknown')).toBeInTheDocument();
    expect(within(panel).queryByText(/spent SO FAR/)).not.toBeInTheDocument();
    // The useful half of the caveat survives, worded for a panel with no figure.
    expect(within(panel).getByText(/more exchanges may still be billed/)).toBeInTheDocument();
  });

  it('does not caveat a SETTLED node’s spend as still running', async () => {
    const panel = await openPanel([
      dispatched('greet', 'greet#0'),
      metered({ inputTokens: 1, outputTokens: 1, costEstimate: 0.5 }),
      {
        type: 'node.succeeded',
        runId: 'run_1',
        nodeId: 'greet',
        attemptId: 'greet#0',
        outputs: {},
      },
    ]);
    expect(within(panel).queryByText(/spent SO FAR/)).not.toBeInTheDocument();
  });

  it('shows no tool-call section for a node that ran none', async () => {
    const panel = await openPanel([
      dispatched('greet', 'greet#0'),
      metered({ inputTokens: 1, outputTokens: 1, costEstimate: 0.5 }),
    ]);
    expect(within(panel).queryByRole('heading', { name: 'Tool calls' })).not.toBeInTheDocument();
  });
});

/**
 * RS2 — the rerun action. The engine half (`POST /api/runs/:id/rerun-from-failed`)
 * shipped with the RS series and had no caller at all, so an operator could not
 * rerun a failed run from the product.
 *
 * NAVIGATION on success is deliberately NOT asserted here: `renderWithRouter`
 * mounts a router that goes nowhere, and its own docblock says destination
 * assertions belong on the real `ROUTES`. The e2e spec covers the landing,
 * end to end, against a real rerun. What these specs pin is the decision to
 * call the server, and everything the page says around it.
 */
describe('RunDetailPage — the rerun-from-failed action (RS2)', () => {
  const ACTION = 'Rerun from failed';

  /** Mount with the run row in `status`; an empty stream leaves the row as the
        page's status source, which is the case an operator sees on a finished
        run they navigated to fresh. */
  async function mountWithStatus(status: Run['status'], overrides: Partial<Run> = {}) {
    getRunDetailMock.mockResolvedValue({
      run: run({ status, finishedAt: 1_700_000_001_000, ...overrides }),
      pipelineVersion: version(),
    });
    renderWithRouter(<RunDetailPage runId="run_1" />);
    await screen.findByText('pv_1');
  }

  beforeEach(() => rerunFromFailedMock.mockResolvedValue({ runId: 'run_2' }));

  it.each(['failure', 'interrupted'] as const)('offers the action on a %s run', async (s) => {
    await mountWithStatus(s);
    expect(screen.getByRole('button', { name: ACTION })).toBeInTheDocument();
  });

  it.each(['success', 'running'] as const)('withholds the action on a %s run', async (s) => {
    await mountWithStatus(s);
    expect(screen.queryByRole('button', { name: ACTION })).not.toBeInTheDocument();
  });

  /* The rerun spec requires the UI warn that a rerun "may incur additional
       cost" — copied nodes are free, but everything from the failure onward
       re-executes and meters. Asserted on the RENDERED page, not just on the
       constant, so removing it from the JSX fails here. */
  it('warns that the rerun may cost money, beside the button', async () => {
    await mountWithStatus('failure');
    expect(screen.getByText(/may incur additional cost/)).toBeInTheDocument();
  });

  it('asks the server to rerun THIS run when clicked', async () => {
    await mountWithStatus('failure');
    await userEvent.click(screen.getByRole('button', { name: ACTION }));
    expect(rerunFromFailedMock).toHaveBeenCalledWith('run_1');
  });

  /* A rerun is NOT idempotent — a second in-flight click would start a second
       run and spend money twice. The button disables itself the moment the
       request goes out, so the second click cannot land. */
  it('starts only one rerun when the button is clicked twice', async () => {
    let release!: (v: { runId: string }) => void;
    rerunFromFailedMock.mockReturnValue(
      new Promise<{ runId: string }>((resolve) => {
        release = resolve;
      }),
    );
    await mountWithStatus('failure');
    const button = screen.getByRole('button', { name: ACTION });
    await userEvent.click(button);
    const busy = await screen.findByRole('button', { name: 'Starting rerun…' });
    expect(busy).toBeDisabled();
    await userEvent.click(busy);
    expect(rerunFromFailedMock).toHaveBeenCalledTimes(1);
    release({ runId: 'run_2' });
  });

  /* RS6 lineage. `rerunOf` is the durable row projection of
       `run.started.rerunOf`, so a rerun can always say what it came from. An
       ORDINARY run gets no row at all rather than a row reading "—". */
  it('links back to the source run, and says nothing on a run that is not a rerun', async () => {
    await mountWithStatus('failure', { rerunOf: 'run_0' });
    expect(screen.getByText('Rerun of')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'run_0' })).toBeInTheDocument();
  });

  it('shows no lineage row on an original run', async () => {
    await mountWithStatus('failure');
    expect(screen.queryByText('Rerun of')).not.toBeInTheDocument();
  });
});

/**
 * #900 — the "waiting on a callback" surface.
 *
 * A16 shipped the whole producer (the correlation row, the derived capability
 * token, `GET /api/runs/:id/external-waits`) and nothing in the web app called
 * it, so a run parked on a human-approval webhook was a dead end: the header
 * said `waiting (callback)` and the page offered no way to find out where that
 * callback goes.
 *
 * These drive the page against a REAL parked log — `run.waiting{waiting_external}`
 * is the event the reducer folds — so what is asserted is the rendered surface
 * over the same state the engine produces, not a hand-built status.
 */
describe('RunDetailPage — #900 waiting on a callback', () => {
  const WAIT = {
    nodeId: 'approve',
    attemptId: 'approve#0',
    expiresAt: 1_700_000_900_000,
    callbackPath: '/api/external-wait/tok_abc',
  };

  /* Scoped to the new list. The node table and the drill-in name the same node
     with the same string (which is #882 working), so an unscoped query for it
     matches three elements and throws. */
  const pendingList = () => screen.findByRole('list', { name: 'Pending callbacks' });

  const parkedOn = (reason: 'waiting_timer' | 'waiting_external') => [
    envelope({ type: 'run.started', runId: 'run_1', pipelineVersionId: 'pv_1', params: {} }),
    envelope({ type: 'run.waiting', runId: 'run_1', reason }),
  ];

  async function mountParked(
    reason: 'waiting_timer' | 'waiting_external' = 'waiting_external',
    doc = approvalDoc(),
  ) {
    getRunDetailMock.mockResolvedValue({ run: run({ status: 'waiting' }), pipelineVersion: doc });
    useRunStreamMock.mockReturnValue(stream({ events: parkedOn(reason) }));
    renderWithRouter(<RunDetailPage runId="run_1" />);
    await screen.findByText('Run');
  }

  it('names the parked node and reveals its callback path on demand', async () => {
    listExternalWaitsMock.mockResolvedValue([WAIT]);
    await mountParked();

    // Named by the one name #878 gives an activity — kind plus within-kind
    // ordinal — and never by the raw `n_<uuid>` the canvas mints.
    expect(within(await pendingList()).getByText('Webhook (external wait) 1')).toBeVisible();

    /* The token is a live bearer credential, so it is NOT painted onto the page:
       it appears only once asked for, matching the webhook-secret reveal on the
       triggers page. */
    expect(screen.queryByText(/tok_abc/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show callback URL' }));
    expect(screen.getByText(/\/api\/external-wait\/tok_abc/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Hide callback URL' }));
    expect(screen.queryByText(/tok_abc/)).not.toBeInTheDocument();
  });

  it('renders the path as TEXT, never as a link', async () => {
    /* A link would navigate somewhere useless (the route is POST-only) and would
       leak the capability token through the Referer header on any external
       navigation. */
    listExternalWaitsMock.mockResolvedValue([WAIT]);
    await mountParked();
    await userEvent.click(await screen.findByRole('button', { name: 'Show callback URL' }));
    expect(screen.queryByRole('link', { name: /external-wait/ })).not.toBeInTheDocument();
  });

  it('says nothing, and asks nothing, on a run parked on a TIMER', async () => {
    /* The whole reason the gate is the waiting REASON and not the bare status: a
       timer park is equally `waiting` and owes no callback. */
    await mountParked('waiting_timer');
    expect(await screen.findByText('waiting (timer)', { selector: '.run-status' })).toBeVisible();
    expect(screen.queryByText('Waiting on a callback')).not.toBeInTheDocument();
    expect(listExternalWaitsMock).not.toHaveBeenCalled();
  });

  it('states what the callback body must contain, read off the declared contract', async () => {
    listExternalWaitsMock.mockResolvedValue([WAIT]);
    await mountParked('waiting_external', approvalDoc([{ name: 'decision', type: 'string' }]));
    // A missing declared key is a 422 that leaves the node parked, so an operator
    // handed only a URL would find this out by failing.
    expect(await screen.findByText(/must be JSON supplying “decision” \(string\)/)).toBeVisible();
  });

  it('says a no-outputs webhook discards whatever body it is sent', async () => {
    listExternalWaitsMock.mockResolvedValue([WAIT]);
    await mountParked();
    expect(await screen.findByText(/declares no outputs/)).toBeVisible();
  });

  it('names the INSTANCE when a parallel foreach body parked', async () => {
    // The engine parks `approve@1`; the doc only has `approve`. The name comes
    // from the resolved doc node, and the instance key is what says WHICH one.
    listExternalWaitsMock.mockResolvedValue([{ ...WAIT, nodeId: 'approve@1' }]);
    await mountParked();
    const list = within(await pendingList());
    expect(list.getByText('Webhook (external wait) 1')).toBeVisible();
    expect(list.getByText('approve@1')).toBeVisible();
  });

  it('surfaces a failed lookup instead of reading as "no callback owed"', async () => {
    listExternalWaitsMock.mockRejectedValue(new Error('boom'));
    await mountParked();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The pending callbacks could not be loaded');
    expect(alert).toHaveTextContent('boom');
    // And no reveal control, because there is nothing to reveal.
    expect(screen.queryByRole('button', { name: 'Show callback URL' })).not.toBeInTheDocument();
  });

  it('says it is still LOADING before the list arrives', async () => {
    let release!: (waits: (typeof WAIT)[]) => void;
    listExternalWaitsMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await mountParked();
    expect(await screen.findByText(/Loading the pending callbacks/)).toBeVisible();
    // And it is genuinely a WAITING state, not the empty one wearing a spinner.
    expect(screen.queryByText(/No callback is pending/)).not.toBeInTheDocument();
    release([WAIT]);
    expect(within(await pendingList()).getByText('Webhook (external wait) 1')).toBeVisible();
  });

  it('says a settled wait is settled, rather than loading forever', async () => {
    // Parked, but the list came back EMPTY — the wait settled between the status
    // frame and this fetch. A spinner that never resolves would be a lie.
    listExternalWaitsMock.mockResolvedValue([]);
    await mountParked();
    expect(await screen.findByText(/No callback is pending/)).toBeVisible();
    expect(screen.queryByText(/Loading the pending callbacks/)).not.toBeInTheDocument();
  });

  it('re-asks on a NEW park, so a second webhook never shows the first dead token', async () => {
    /* Two webhooks in sequence: the completion of one and the park of the next
       can arrive in a single stream batch, so the un-parked state may never
       render. Counting `externalWait.created` is what makes the refetch survive
       that batching. */
    listExternalWaitsMock.mockResolvedValue([WAIT]);
    getRunDetailMock.mockResolvedValue({
      run: run({ status: 'waiting' }),
      pipelineVersion: approvalDoc(),
    });
    const first = [
      ...parkedOn('waiting_external'),
      envelope({
        type: 'externalWait.created',
        runId: 'run_1',
        nodeId: 'approve',
        attemptId: 'approve#0',
        dueAt: WAIT.expiresAt,
      }),
    ];
    useRunStreamMock.mockReturnValue(stream({ events: first }));
    const { rerender } = renderWithRouter(<RunDetailPage runId="run_1" />);
    await pendingList();
    expect(listExternalWaitsMock).toHaveBeenCalledTimes(1);

    listExternalWaitsMock.mockResolvedValue([
      { ...WAIT, callbackPath: '/api/external-wait/tok_2' },
    ]);
    useRunStreamMock.mockReturnValue(
      stream({
        events: [
          ...first,
          envelope({
            type: 'externalWait.completed',
            runId: 'run_1',
            nodeId: 'approve',
            previousAttemptId: 'approve#0',
            outputs: {},
          }),
          envelope({ type: 'run.waiting', runId: 'run_1', reason: 'waiting_external' }),
          envelope({
            type: 'externalWait.created',
            runId: 'run_1',
            nodeId: 'approve',
            attemptId: 'approve#1',
            dueAt: WAIT.expiresAt,
          }),
        ],
      }),
    );
    /* Wrapped, because `rerender` replaces the WHOLE tree — including the
       `MemoryRouter` `renderWithRouter` supplied — and the page calls
       `useNavigate`, which throws outside a router. */
    rerender(
      <MemoryRouter>
        <RunDetailPage runId="run_1" />
      </MemoryRouter>,
    );

    await vi.waitFor(() => expect(listExternalWaitsMock).toHaveBeenCalledTimes(2));
    await userEvent.click(await screen.findByRole('button', { name: 'Show callback URL' }));
    expect(screen.getByText(/tok_2/)).toBeInTheDocument();
    // The title's actual claim: the FIRST park's token is gone, not merely that
    // the second one arrived.
    expect(screen.queryByText(/tok_abc/)).not.toBeInTheDocument();
  });

  /**
   * The case a `created`-only tick could not see, and the reason the epoch counts
   * settlements too.
   *
   * TWO webhooks parked at once — a fork, or a `foreach` webhook body. Completing
   * one leaves the other parked, so the reducer answers `waiting_external` again
   * and the run re-parks with NO new `externalWait.created`. A tick that counted
   * only parks would not move, the list would never be re-asked, and the completed
   * wait's dead token would stay on screen.
   */
  it('re-asks when one of TWO concurrent waits completes, dropping the dead one', async () => {
    const second = { ...WAIT, nodeId: 'approve2', attemptId: 'approve2#0' };
    listExternalWaitsMock.mockResolvedValue([WAIT, second]);
    getRunDetailMock.mockResolvedValue({
      run: run({ status: 'waiting' }),
      pipelineVersion: approvalDoc(),
    });
    const bothParked = [
      ...parkedOn('waiting_external'),
      envelope({
        type: 'externalWait.created',
        runId: 'run_1',
        nodeId: 'approve',
        attemptId: 'approve#0',
        dueAt: WAIT.expiresAt,
      }),
      envelope({
        type: 'externalWait.created',
        runId: 'run_1',
        nodeId: 'approve2',
        attemptId: 'approve2#0',
        dueAt: WAIT.expiresAt,
      }),
    ];
    useRunStreamMock.mockReturnValue(stream({ events: bothParked }));
    const { rerender } = renderWithRouter(<RunDetailPage runId="run_1" />);
    await pendingList();
    expect(listExternalWaitsMock).toHaveBeenCalledTimes(1);

    // One completes. The run STAYS parked on the other — note there is no further
    // `externalWait.created` in this batch, which is the whole point.
    listExternalWaitsMock.mockResolvedValue([second]);
    useRunStreamMock.mockReturnValue(
      stream({
        events: [
          ...bothParked,
          envelope({
            type: 'externalWait.completed',
            runId: 'run_1',
            nodeId: 'approve',
            previousAttemptId: 'approve#0',
            outputs: {},
          }),
          envelope({ type: 'run.waiting', runId: 'run_1', reason: 'waiting_external' }),
        ],
      }),
    );
    rerender(
      <MemoryRouter>
        <RunDetailPage runId="run_1" />
      </MemoryRouter>,
    );

    await vi.waitFor(() => expect(listExternalWaitsMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () =>
      expect(within(await pendingList()).getAllByRole('listitem')).toHaveLength(1),
    );
  });

  /**
   * #901 — completing the wait from the app, the half #900 deliberately left out.
   *
   * The behaviours worth pinning are the ones a screenshot cannot show: that no
   * capability token is sent, that a typo is caught before it becomes a useless
   * framework 400, that a refusal leaves the editor usable, and — the one that
   * required the draft to live on `RunDetailPage` — that unsaved input survives the
   * epoch remount an unrelated wait can trigger at any moment.
   */
  async function openEditor() {
    await userEvent.click(await screen.findByRole('button', { name: /^Complete wait for / }));
    return screen.getByRole('textbox', { name: /Callback body/ });
  }

  it('#901 — completing a wait posts the attempt and payload, and never a token', async () => {
    listExternalWaitsMock.mockResolvedValue([WAIT]);
    completeExternalWaitMock.mockResolvedValue(undefined);
    await mountParked();

    await userEvent.type(await openEditor(), '{{"decision": "approve"}');
    await userEvent.click(screen.getByRole('button', { name: 'Complete this wait' }));

    await vi.waitFor(() => expect(completeExternalWaitMock).toHaveBeenCalledTimes(1));
    expect(completeExternalWaitMock).toHaveBeenCalledWith('run_1', {
      nodeId: 'approve',
      attemptId: 'approve#0',
      payload: { decision: 'approve' },
    });
    // The point of the owner-scoped route: the token the GET revealed is not what
    // authorizes this, and it must not be along for the ride.
    const sent = JSON.stringify(completeExternalWaitMock.mock.calls[0]);
    expect(sent).not.toContain('tok_abc');
    expect(sent).not.toContain('external-wait/');
  });

  it('#901 — an EMPTY editor completes with {}, not with nothing', async () => {
    // `payload` is required server-side with no default, so "I typed nothing" has
    // to become an explicit empty object here rather than an absent field the
    // route would have to invent a meaning for.
    listExternalWaitsMock.mockResolvedValue([WAIT]);
    completeExternalWaitMock.mockResolvedValue(undefined);
    await mountParked();

    await openEditor();
    await userEvent.click(screen.getByRole('button', { name: 'Complete this wait' }));

    await vi.waitFor(() => expect(completeExternalWaitMock).toHaveBeenCalledTimes(1));
    expect(completeExternalWaitMock.mock.calls[0]![1].payload).toEqual({});
  });

  it('#901 — invalid JSON is refused HERE, without a pointless round trip', async () => {
    listExternalWaitsMock.mockResolvedValue([WAIT]);
    await mountParked();

    await userEvent.type(await openEditor(), 'not json');
    await userEvent.click(screen.getByRole('button', { name: 'Complete this wait' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/was not completed/i);
    // The server would answer a framework 400 that the shared contract flattens to
    // "Malformed request" — so catching it here is what makes the message useful.
    expect(completeExternalWaitMock).not.toHaveBeenCalled();
  });

  it('#901 — a rejected body keeps the editor open, with what was typed intact', async () => {
    listExternalWaitsMock.mockResolvedValue([WAIT]);
    completeExternalWaitMock.mockRejectedValue(new Error("missing declared output 'decision'"));
    await mountParked();

    await userEvent.type(await openEditor(), '{{"note": "wrong"}');
    await userEvent.click(screen.getByRole('button', { name: 'Complete this wait' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/missing declared output/);
    // A 422 means the node is STILL PARKED and the body is fixable — so the worst
    // possible response is to close the editor and make them type it again.
    expect(screen.getByRole('textbox', { name: /Callback body/ })).toHaveValue('{"note": "wrong"}');
  });

  it('#901 — Cancel puts focus back on the control that opened the editor', async () => {
    /* The trigger only EXISTS while the editor is closed, so at the moment Cancel
       runs its ref has already been nulled by its own unmount — restoring focus
       synchronously there is a guaranteed no-op, and the keyboard user lands on
       <body>. The restore has to wait until the trigger has mounted again. */
    listExternalWaitsMock.mockResolvedValue([WAIT]);
    await mountParked();

    await openEditor();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    const trigger = await screen.findByRole('button', { name: /^Complete wait for / });
    await vi.waitFor(() => expect(trigger).toHaveFocus());
  });

  it('#901 — an unrelated wait settling does NOT discard what is being typed', async () => {
    /* The direct collision between #901's editor and #900's freshness model:
       `PendingCallbacks` is keyed on the wait epoch, so ANY externalWait frame
       remounts it. Two parallel waits are all it takes — an external caller
       completes the first while the operator is mid-sentence on the second. The
       draft lives on the page, above the key, precisely so this remount cannot
       take it. */
    const OTHER = { ...WAIT, nodeId: 'approve2', attemptId: 'approve2#0' };
    listExternalWaitsMock.mockResolvedValue([WAIT, OTHER]);
    const first = parkedOn('waiting_external');
    getRunDetailMock.mockResolvedValue({
      run: run({ status: 'waiting' }),
      pipelineVersion: approvalDoc(),
    });
    useRunStreamMock.mockReturnValue(stream({ events: first }));
    const { rerender } = renderWithRouter(<RunDetailPage runId="run_1" />);
    await pendingList();

    const editors = screen.getAllByRole('button', { name: /^Complete wait for / });
    await userEvent.click(editors[1]!);
    await userEvent.type(screen.getByRole('textbox', { name: /Callback body/ }), 'half-typed');

    // The OTHER wait settles — a frame this operator did not cause.
    listExternalWaitsMock.mockResolvedValue([OTHER]);
    useRunStreamMock.mockReturnValue(
      stream({
        events: [
          ...first,
          envelope({
            type: 'externalWait.completed',
            runId: 'run_1',
            nodeId: 'approve',
            previousAttemptId: 'approve#0',
            outputs: {},
          }),
        ],
      }),
    );
    rerender(
      <MemoryRouter>
        <RunDetailPage runId="run_1" />
      </MemoryRouter>,
    );

    await vi.waitFor(() => expect(listExternalWaitsMock).toHaveBeenCalledTimes(2));
    // Survived the remount: still open, still holding the operator's own words.
    expect(await screen.findByRole('textbox', { name: /Callback body/ })).toHaveValue('half-typed');
  });
});

/**
 * U27 slice 1 (#930) — the run says what IT spent, not just each node.
 *
 * Asserted through the page rather than against `RunCostSummary` directly,
 * because three of the four things this surface refuses to do are decided by what
 * the PAGE hands it: whether the replay finished, whether the run has settled,
 * and what it reused. A component test would let each of those be whatever the
 * fixture said.
 */
describe('RunDetailPage — U27 the run says what it SPENT (#930)', () => {
  const metered = (fields: Record<string, unknown> = {}): EngineEvent =>
    ({
      type: 'activity.metered',
      runId: 'run_1',
      nodeId: 'greet',
      attemptId: 'greet#0',
      provider: 'anthropic_api',
      model: 'claude-opus-4-8',
      meteringStatus: 'metered',
      ...fields,
    }) as EngineEvent;

  /** The run-level section, found by its own heading rather than by position. */
  const costSection = () => screen.getByRole('region', { name: 'Cost & usage' });

  async function renderRun(over: Partial<RunStreamState>, runOver: Partial<Run> = {}) {
    getRunDetailMock.mockResolvedValue({
      run: run({ status: 'success', finishedAt: 1_700_000_001_000, ...runOver }),
      pipelineVersion: version(),
    });
    useRunStreamMock.mockReturnValue(stream(over));
    renderWithRouter(<RunDetailPage runId="run_1" />);
    await screen.findByRole('region', { name: 'Cost & usage' });
  }

  it('totals the whole run, naming its models and tokens', async () => {
    await renderRun({
      events: [
        envelope(metered({ inputTokens: 1200, outputTokens: 340, costEstimate: 0.0055 })),
        envelope(metered({ inputTokens: 800, outputTokens: 60, costEstimate: 0.0045 })),
      ],
    });
    const section = costSection();
    expect(within(section).getByText('$0.01')).toBeInTheDocument();
    expect(within(section).getByText('2,000 in · 400 out')).toBeInTheDocument();
    expect(within(section).getByText('claude-opus-4-8')).toBeInTheDocument();
  });

  it('never presents a run nobody could price as $0.00', async () => {
    await renderRun({ events: [envelope(metered({ inputTokens: 10, outputTokens: 5 }))] });
    const section = costSection();
    expect(within(section).getByText('Cost unknown')).toBeInTheDocument();
    expect(within(section).queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('describes a MIXED run truthfully — priced AND subscription exchanges', async () => {
    /* Unreachable per node (one connection per node for the whole immutable run)
       and ordinary per RUN. #866's wording called every such exchange priced. */
    await renderRun({
      events: [
        envelope(metered({ inputTokens: 10, outputTokens: 5, costEstimate: 0.02 })),
        envelope(
          metered({
            nodeId: 'never',
            attemptId: 'never#0',
            provider: 'agent_cli',
            model: 'claude-cli',
            meteringStatus: 'unpriced',
          }),
        ),
      ],
    });
    const section = costSection();
    expect(within(section).getByText('$0.02')).toBeInTheDocument();
    expect(within(section).getByText(/1 priced, and 1 a subscription or CLI call/)).toBeVisible();
    expect(within(section).queryByText(/all priced/)).not.toBeInTheDocument();
  });

  it('says the run is still spending while it is still going', async () => {
    await renderRun(
      { events: [envelope(metered({ inputTokens: 10, outputTokens: 5, costEstimate: 0.02 }))] },
      { status: 'running', finishedAt: null },
    );
    expect(within(costSection()).getByText(/This run has not settled/)).toBeVisible();
  });

  it('renders the section even for a run that billed nothing', async () => {
    /* A run page that silently omits its cost section is indistinguishable from
       an app with no cost surface at all — unlike the drill-in, which is a thing
       you opened deliberately. */
    await renderRun({ events: [] });
    expect(within(costSection()).getByText('No billed exchange')).toBeInTheDocument();
  });

  it('withholds the figure until the durable log has been fully replayed', async () => {
    /* A total folded from half a log is a manufactured authority: it would carry
       the confidence of a settled figure while being a floor of unknown depth. */
    await renderRun({
      phase: 'replaying',
      replayComplete: false,
      events: [envelope(metered({ inputTokens: 10, outputTokens: 5, costEstimate: 0.02 }))],
    });
    const section = costSection();
    expect(within(section).getByText('Reading the run log…')).toBeInTheDocument();
    expect(within(section).queryByText('$0.02')).not.toBeInTheDocument();
  });

  it('says the log is INCOMPLETE when the stream closed mid-replay', async () => {
    /* `useRunStream` can reach `closed` mid-replay with no error shown, which is
       the case that would otherwise print a silently-truncated total. */
    await renderRun({
      phase: 'closed',
      replayComplete: false,
      events: [envelope(metered({ inputTokens: 10, outputTokens: 5, costEstimate: 0.02 }))],
    });
    const section = costSection();
    expect(within(section).getByText(/ended before the whole log was read/)).toBeVisible();
    expect(within(section).queryByText('$0.02')).not.toBeInTheDocument();
  });

  it('says a RERUN’s total is incremental, naming what it reused', async () => {
    await renderRun(
      {
        events: [
          envelope({
            type: 'run.started',
            runId: 'run_1',
            pipelineVersionId: 'pv_1',
            params: {},
            rerunOf: 'run_source',
          }),
          envelope({
            type: 'run.reseeded',
            runId: 'run_1',
            sourceRunId: 'run_source',
            frontier: ['greet'],
            copiedOutputs: { greet: { status: 200 } },
            copiedContainers: {},
          }),
        ],
      },
      { rerunOf: 'run_source' },
    );
    const section = costSection();
    /* The all-copied rerun: nothing was billed, so a "did it spend anything"
       gate would have hidden the caveat in exactly the case it exists for. */
    expect(within(section).getByText('No billed exchange')).toBeInTheDocument();
    expect(within(section).getByText(/1 node was REUSED from run/)).toBeVisible();
    expect(
      within(section).getByText(/what the rerun spent, not what the result cost/),
    ).toBeVisible();
    /* #932 — and the reuse caveat carries the child boundary too. A copied call
       node re-executes nothing, so THIS run announces no child and the exclusion
       caveat says nothing; without this clause the spend those children hold
       would be named nowhere on the page. */
    expect(within(section).getByText(/on any sub-pipelines it called/)).toBeVisible();
    // The source run is reachable, not just quoted.
    expect(within(section).getByRole('link', { name: 'run_source' })).toHaveAttribute(
      'href',
      '/monitor/runs/run_source',
    );
  });

  it('says nothing about reuse on an ordinary run', async () => {
    await renderRun({
      events: [envelope(metered({ inputTokens: 10, outputTokens: 5, costEstimate: 0.02 }))],
    });
    expect(within(costSection()).queryByText(/REUSED/)).not.toBeInTheDocument();
  });

  describe('#932 — the child runs the total excludes', () => {
    const callStarted = (childRunId: string, attemptId = 'call#0') =>
      envelope({
        type: 'call.started',
        runId: 'run_1',
        callNodeId: 'call',
        attemptId,
        childRunId,
      } as EngineEvent);

    it('states the exclusion and LINKS every child run', async () => {
      await renderRun({
        events: [
          envelope(metered({ inputTokens: 10, outputTokens: 5, costEstimate: 0.02 })),
          callStarted('run_child_a'),
        ],
      });
      const section = costSection();
      /* The figure is still this run's own spend — the point is that the sentence
         beside it now says so, instead of the total silently standing for the
         whole tree. */
      expect(within(section).getByText('$0.02')).toBeInTheDocument();
      /* The SINGULAR clause in full. Matching only up to the comma would leave
         "and each one ran" — a distributive quantifier over one item — free to
         ship, which is what it did until the FIT lens caught it. */
      expect(
        within(section).getByText(/called 1 sub-pipeline, and it ran as its own run/),
      ).toBeVisible();
      /* "and anything it called in turn" — children nest to `MAX_CALL_DEPTH`, so a
         reader who opens the linked run has still not found the whole exclusion. */
      expect(within(section).getByText(/anything it called in turn/)).toBeVisible();
      const link = within(section).getByRole('link', { name: 'run_child_a' });
      expect(link).toHaveAttribute('href', '/monitor/runs/run_child_a');
    });

    it('names both children of a call node that ran twice', async () => {
      await renderRun({
        events: [callStarted('run_child_a'), callStarted('run_child_b', 'call#1')],
      });
      const section = costSection();
      expect(
        within(section).getByText(/called 2 sub-pipelines, and each one ran as its own run/),
      ).toBeVisible();
      expect(within(section).getByRole('link', { name: 'run_child_a' })).toBeInTheDocument();
      expect(within(section).getByRole('link', { name: 'run_child_b' })).toBeInTheDocument();
    });

    it('says nothing about children on a run that spawned none', async () => {
      await renderRun({
        events: [envelope(metered({ inputTokens: 10, outputTokens: 5, costEstimate: 0.02 }))],
      });
      expect(within(costSection()).queryByText(/sub-pipeline/)).not.toBeInTheDocument();
    });

    it('does NOT claim an exclusion while the log is still being read', async () => {
      /* The caveat sits INSIDE the replay gate. `call.started` lands arbitrarily
         late in a log, so a truncated replay can hold a child the fold has not
         reached — and there is no figure to qualify anyway, since the gate's other
         branch says the total cannot be computed. Announcing "excludes 1 child
         run" here would attach a precise-sounding claim to a number that is not on
         screen. */
      await renderRun({
        events: [callStarted('run_child_a')],
        replayComplete: false,
        phase: 'closed',
      });
      const section = costSection();
      expect(within(section).getByText(/ended before the whole log was read/)).toBeVisible();
      expect(within(section).queryByText(/sub-pipeline/)).not.toBeInTheDocument();
    });
  });
});
