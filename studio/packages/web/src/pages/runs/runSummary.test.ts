import { describe, expect, it } from 'vitest';
import type { EngineDoc, EngineEvent, RunEvent } from '@autonomy-studio/shared';
import { projectRun } from './runProjection';
import {
  deriveNodeActivity,
  emptyNodeCost,
  deriveRunLifecycle,
  reconcileNodeActivity,
  runStreamUrl,
  type AttemptSpan,
  type NodeActivity,
} from './runSummary';

/**
 * #866 — the three observability fields every row now carries. Spread into the
 * EXHAUSTIVE whole-row assertions so they stay exhaustive (a `toEqual` that
 * omitted them would silently stop checking them) without restating a dozen
 * zeroed cost counters in each case.
 */
const NO_LLM_ACTIVITY = {
  cost: emptyNodeCost(),
  costSpansInstances: false,
  toolCalls: [],
};

let seq = 0;
/** Wrap a typed EngineEvent in the durable envelope shape the log/stream carry
 * (the whole EngineEvent is stored as `payload`, per `run/events.ts`).
 *
 * `at` sets the envelope `ts` — the append-time epoch-ms stamp, and the only
 * clock in the log (payloads are deliberately clock-free). It defaults to the
 * sequence so every pre-existing case is untouched; the #867 duration cases
 * pass it explicitly, because a span is the whole thing they measure. */
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

describe('runStreamUrl', () => {
  it('builds a same-origin ws:// URL for http', () => {
    expect(runStreamUrl('run_1', { protocol: 'http:', host: 'localhost:5173' })).toBe(
      'ws://localhost:5173/api/runs/run_1/events/stream',
    );
  });
  it('upgrades to wss:// under https and encodes the id', () => {
    expect(runStreamUrl('run/1', { protocol: 'https:', host: 'studio.example' })).toBe(
      'wss://studio.example/api/runs/run%2F1/events/stream',
    );
  });
});

describe('deriveNodeActivity', () => {
  it('is empty for a log with no node events', () => {
    const events = [
      envelope({ type: 'run.started', runId: 'r', pipelineVersionId: 'pv', params: {} }),
    ];
    expect(deriveNodeActivity(events)).toEqual([]);
  });

  it('projects dispatch → success/failure and counts attempts + outputs', () => {
    const events = [
      envelope(
        {
          type: 'node.dispatched',
          runId: 'r',
          nodeId: 'a',
          attemptId: 'a#0',
          idempotent: true,
        },
        1_000,
      ),
      envelope({ type: 'node.output', runId: 'r', nodeId: 'a', name: 'text', value: 'hi' }),
      envelope({ type: 'node.output', runId: 'r', nodeId: 'a', name: 'text', value: 'there' }),
      envelope(
        { type: 'node.succeeded', runId: 'r', nodeId: 'a', attemptId: 'a#0', outputs: {} },
        1_400,
      ),
      envelope(
        {
          type: 'node.dispatched',
          runId: 'r',
          nodeId: 'b',
          attemptId: 'b#0',
          idempotent: true,
        },
        2_000,
      ),
      envelope(
        {
          type: 'node.failed',
          runId: 'r',
          nodeId: 'b',
          attemptId: 'b#0',
          error: 'boom',
          kind: 'permanent',
        },
        2_300,
      ),
    ];
    const activity = deriveNodeActivity(events);
    expect(activity).toEqual([
      {
        ...NO_LLM_ACTIVITY,
        nodeId: 'a',
        status: 'success',
        attempts: 1,
        outputs: 2,
        lastOutputName: 'text',
        error: undefined,
        failureKind: undefined,
        failureCode: undefined,
        outputValues: {},
        instanceId: undefined,
        startedAtMs: 1_000,
        endedAtMs: 1_400,
        spans: [
          {
            startedAtMs: 1_000,
            endedAtMs: 1_400,
            startedAs: 'dispatched',
            endedAs: 'success',
            instanceId: undefined,
          },
        ],
      },
      {
        ...NO_LLM_ACTIVITY,
        nodeId: 'b',
        status: 'failure',
        attempts: 1,
        outputs: 0,
        lastOutputName: undefined,
        error: 'boom',
        // U24 — the class the message no longer carries. `code` is genuinely
        // absent here: this producer stated none.
        failureKind: 'permanent',
        failureCode: undefined,
        outputValues: undefined,
        instanceId: undefined,
        startedAtMs: 2_000,
        endedAtMs: 2_300,
        spans: [
          {
            startedAtMs: 2_000,
            endedAtMs: 2_300,
            startedAs: 'dispatched',
            endedAs: 'failure',
            instanceId: undefined,
          },
        ],
      },
    ]);
  });

  it('a retry re-opens a node to running and bumps attempts', () => {
    const events = [
      envelope({
        type: 'node.dispatched',
        runId: 'r',
        nodeId: 'a',
        attemptId: 'a#0',
        idempotent: true,
      }),
      envelope({
        type: 'node.failed',
        runId: 'r',
        nodeId: 'a',
        attemptId: 'a#0',
        error: 'x',
        kind: 'transient',
      }),
      envelope({
        type: 'node.retryRequested',
        runId: 'r',
        nodeId: 'a',
        previousAttemptId: 'a#0',
        reason: 'retry',
      }),
      envelope({
        type: 'node.dispatched',
        runId: 'r',
        nodeId: 'a',
        attemptId: 'a#1',
        idempotent: true,
      }),
    ];
    const [a] = deriveNodeActivity(events);
    expect(a).toMatchObject({ nodeId: 'a', status: 'dispatched', attempts: 2 });
  });

  it('resolves a call node from call.returned', () => {
    const events = [
      envelope({
        type: 'call.returned',
        runId: 'r',
        callNodeId: 'c',
        attemptId: 'c#0',
        childRunId: 'r2',
        childOutcome: 'failure',
        outputs: {},
      }),
    ];
    expect(deriveNodeActivity(events)).toEqual([
      {
        ...NO_LLM_ACTIVITY,
        nodeId: 'c',
        status: 'failure',
        // 1, not 0, since #483: a call node is never dispatched, so `call.returned`
        // is the only event it has and it IS the node's one attempt. It read 0
        // before, which renders as "never ran" for a node that ran a whole child
        // pipeline.
        attempts: 1,
        outputs: 0,
        lastOutputName: undefined,
        error: undefined,
        // `{}`, not `undefined`: this event's `outputs` is a REQUIRED record, so
        // the child genuinely reported none — which the panel renders as "no
        // output values were recorded" rather than hiding the section as it does
        // for a node that has not reported yet.
        outputValues: {},
        /* #1007 — and NO span: `call.returned` is a terminal with no start to
           pair it with until #796 appends `call.started`. The other absent
           fields above are `undefined`, which `toEqual` treats as missing; an
           empty array is a value, so it has to be stated. */
        spans: [],
      },
    ]);
  });

  it('ignores a malformed payload rather than throwing', () => {
    const bad: RunEvent = {
      id: 'x',
      runId: 'r',
      seq: 99,
      type: 'node.dispatched',
      payload: { nope: true },
      ts: 1,
    };
    expect(deriveNodeActivity([bad])).toEqual([]);
  });
});

describe('deriveRunLifecycle', () => {
  const started = () =>
    envelope({ type: 'run.started', runId: 'r', pipelineVersionId: 'pv', params: {} });

  it('is null before any lifecycle event (caller falls back to the REST status)', () => {
    expect(deriveRunLifecycle([])).toBeNull();
  });
  it('tracks started → finished', () => {
    const events = [started()];
    expect(deriveRunLifecycle(events)).toEqual({ status: 'running', waitingReason: null });
    events.push(envelope({ type: 'run.finished', runId: 'r', outcome: 'success' }));
    expect(deriveRunLifecycle(events)).toEqual({ status: 'success', waitingReason: null });
  });
  it('maps run.interrupted', () => {
    const events = [envelope({ type: 'run.interrupted', runId: 'r', reason: 'boot' })];
    expect(deriveRunLifecycle(events)).toEqual({ status: 'interrupted', waitingReason: null });
  });
  it('#5 S3 — a run.waiting tailing after run.started shows `waiting` (live park view)', () => {
    const events = [
      started(),
      envelope({ type: 'run.waiting', runId: 'r', reason: 'waiting_external' }),
    ];
    // #870 — and it now carries the REASON, which this fold used to drop.
    expect(deriveRunLifecycle(events)).toEqual({
      status: 'waiting',
      waitingReason: 'waiting_external',
    });
  });
  it('#5 S3 — a run.resumed/started after a run.waiting returns the VIEW to running', () => {
    // The live-view reverse edge (the reducer defers the waiting→running producer
    // to S4/S6, but the monitor must un-park a run the moment it advances again).
    const events = [
      started(),
      envelope({ type: 'run.waiting', runId: 'r', reason: 'waiting_timer' }),
      envelope({ type: 'run.resumed', runId: 'r', reason: 'boot_reconcile' }),
    ];
    // #870 — the reason is cleared with the status. A stale reason surviving an
    // unpark is how a running run comes to be labelled "waiting (timer)".
    expect(deriveRunLifecycle(events)).toEqual({ status: 'running', waitingReason: null });
  });
  it('a resume AFTER a terminal shows running again — the VIEW rule, not the log rule', () => {
    // This is the deliberate divergence from the server's `terminalFactFromLog`
    // (#443), which reads the last TERMINAL fact and must never let a resume erase
    // it. This is a live view: a resume tailing in means the run is going again.
    // Pinned so a later "unify these two" fire cannot silently break one of them.
    const events = [
      started(),
      envelope({ type: 'run.finished', runId: 'r', outcome: 'success' }),
      envelope({ type: 'run.resumed', runId: 'r', reason: 'boot_reconcile' }),
    ];
    expect(deriveRunLifecycle(events)).toEqual({ status: 'running', waitingReason: null });
  });

  /**
   * #870 — the rules that decide which reason (if any) reaches the screen.
   *
   * THREE of them mirror behaviour the reducer pins for itself in
   * `shared/engine/__tests__/run-waiting-status.test.ts` (a pre-`run.started`
   * park, a second park on an already-parked run, and the unparks). The other
   * three are this fold's OWN rules, and have no reducer counterpart on
   * purpose: the fold's status model is terminal-aware where `RunState.status`
   * is not — a terminal arriving on a parked run is not admitted by the
   * reducer's top-level guard at all (see `RunDetailPage`'s split-of-authority
   * tests, which measure exactly that).
   */
  describe('#870 — mirrors the reducer’s park/unpark rules', () => {
    it('ignores a run.waiting that arrives BEFORE run.started', () => {
      const events = [envelope({ type: 'run.waiting', runId: 'r', reason: 'waiting_timer' })];
      expect(deriveRunLifecycle(events)).toBeNull();
    });

    it('keeps the FIRST reason when a second run.waiting lands on an already-parked run', () => {
      // The reducer's status guard ignores the second park outright, so the run
      // is still parked on the thing it first parked on. A last-wins fold would
      // relabel it — a specific, confident, wrong noun.
      const events = [
        started(),
        envelope({ type: 'run.waiting', runId: 'r', reason: 'waiting_timer' }),
        envelope({ type: 'run.waiting', runId: 'r', reason: 'waiting_external' }),
      ];
      expect(deriveRunLifecycle(events)).toEqual({
        status: 'waiting',
        waitingReason: 'waiting_timer',
      });
    });

    it('ignores a run.waiting that arrives after a terminal', () => {
      const events = [
        started(),
        envelope({ type: 'run.finished', runId: 'r', outcome: 'success' }),
        envelope({ type: 'run.waiting', runId: 'r', reason: 'waiting_timer' }),
      ];
      expect(deriveRunLifecycle(events)).toEqual({ status: 'success', waitingReason: null });
    });

    const parkedNode = { runId: 'r', nodeId: 'n', previousAttemptId: 'n#0' };
    it.each([
      ['timer.due', envelope({ type: 'timer.due', ...parkedNode })],
      [
        'externalWait.completed',
        envelope({ type: 'externalWait.completed', ...parkedNode, outputs: {} }),
      ],
      ['externalWait.expired', envelope({ type: 'externalWait.expired', ...parkedNode })],
    ])('un-parks on %s — the reducer’s unpark set, not just run.resumed', (_name, unpark) => {
      // The case that made the reason dangerous: `run.resumed` is appended only
      // by boot-reconcile and lease-reclaim, so a timer-parked run resumed by
      // `timer.due` used to keep a stale `waiting` here while the RUNS LIST,
      // reading the row, correctly said `running`.
      const events = [
        started(),
        envelope({ type: 'run.waiting', runId: 'r', reason: 'waiting_timer' }),
        unpark,
      ];
      expect(deriveRunLifecycle(events)).toEqual({ status: 'running', waitingReason: null });
    });

    it('does not let an unpark event resurrect a terminal run', () => {
      // `unparkIfWaiting` is a no-op on anything that is not `waiting`; so is
      // this. A late `timer.due` on a finished run must not un-finish it.
      const events = [
        started(),
        envelope({ type: 'run.finished', runId: 'r', outcome: 'failure' }),
        envelope({ type: 'timer.due', runId: 'r', nodeId: 'n', previousAttemptId: 'n#0' }),
      ];
      expect(deriveRunLifecycle(events)).toEqual({ status: 'failure', waitingReason: null });
    });

    it('does not let an unpark event start a run that never started', () => {
      const events = [
        envelope({ type: 'timer.due', runId: 'r', nodeId: 'n', previousAttemptId: 'n#0' }),
      ];
      expect(deriveRunLifecycle(events)).toBeNull();
    });
  });
});

describe('deriveNodeActivity — parallel foreach instance keys (#566 slice 2 / #4 A4b)', () => {
  it('folds an instance-key event onto the CANVAS node row (docNodeIdOf)', () => {
    // Two item instances of one doc node `w`: both fold onto the single `w` row
    // (last-write-wins, the same collapse the sequential rounds already have).
    const events = [
      envelope({
        type: 'node.dispatched',
        runId: 'r',
        nodeId: 'w@0',
        attemptId: 'w@0#0',
        idempotent: true,
      }),
      envelope({
        type: 'node.dispatched',
        runId: 'r',
        nodeId: 'w@1',
        attemptId: 'w@1#0',
        idempotent: true,
      }),
      envelope({
        type: 'node.succeeded',
        runId: 'r',
        nodeId: 'w@0',
        attemptId: 'w@0#0',
        outputs: {},
      }),
      envelope({
        type: 'node.failed',
        runId: 'r',
        nodeId: 'w@1',
        attemptId: 'w@1#0',
        error: 'item 1 broke',
        kind: 'permanent',
      }),
    ];
    const activity = deriveNodeActivity(events);
    expect(activity.map((a) => a.nodeId)).toEqual(['w']);
    expect(activity[0]!.attempts).toBe(2); // both instances counted on the one row
    expect(activity[0]!.status).toBe('failure'); // last write wins
    expect(activity[0]!.error).toBe('item 1 broke');
  });
});

describe('deriveNodeActivity — the non-dispatch node lifecycles (#483)', () => {
  const dispatched = (nodeId: string, attempt = 0) =>
    envelope({
      type: 'node.dispatched',
      runId: 'r',
      nodeId,
      attemptId: `${nodeId}#${attempt}`,
      idempotent: true,
    });

  it('a HELD node reads `retry_pending`, not the red `failure` its node.failed set', () => {
    // The defect: `node.retryScheduled` fell through `default:`, so a node
    // waiting out its retry interval kept the RED pill for the whole hold
    // (`retryIntervalSeconds` can make that minutes) and the monitor said a node
    // had failed while the run was perfectly healthy.
    const events = [
      dispatched('a'),
      envelope({
        type: 'node.failed',
        runId: 'r',
        nodeId: 'a',
        attemptId: 'a#0',
        error: 'timeout',
        kind: 'transient',
      }),
      envelope({
        type: 'node.retryScheduled',
        runId: 'r',
        nodeId: 'a',
        attemptId: 'a#0',
        nextAttemptAt: 1_700_000_000_000,
      }),
    ];
    const [a] = deriveNodeActivity(events);
    expect(a!.status).toBe('retry_pending');
    // The failure message SURVIVES the hold: it is why the node is retrying, and
    // the detail column is the only place it is shown.
    expect(a!.error).toBe('timeout');
    expect(a!.attempts).toBe(1);
  });

  it('folds a whole retry loop back to success, counting both attempts', () => {
    const events = [
      dispatched('a', 0),
      envelope({
        type: 'node.failed',
        runId: 'r',
        nodeId: 'a',
        attemptId: 'a#0',
        error: 'timeout',
        kind: 'transient',
      }),
      envelope({
        type: 'node.retryScheduled',
        runId: 'r',
        nodeId: 'a',
        attemptId: 'a#0',
        nextAttemptAt: 1,
      }),
      envelope({ type: 'node.retryDue', runId: 'r', nodeId: 'a', previousAttemptId: 'a#0' }),
      dispatched('a', 1),
      envelope({ type: 'node.succeeded', runId: 'r', nodeId: 'a', attemptId: 'a#1', outputs: {} }),
    ];
    expect(deriveNodeActivity(events)).toEqual([
      {
        ...NO_LLM_ACTIVITY,
        nodeId: 'a',
        status: 'success',
        attempts: 2,
        outputs: 0,
        lastOutputName: undefined,
        error: undefined,
        // The transient failure that opened the loop left NO residue once the
        // node re-opened and then succeeded — message and class went together.
        failureKind: undefined,
        failureCode: undefined,
        outputValues: {},
        instanceId: undefined,
        // #867 — the LAST attempt's span, so the retry hold between them is not
        // inside it. Read off the two events themselves (the second dispatch and
        // its success) rather than written as literals, because this helper's
        // stamps come from a file-wide sequence.
        startedAtMs: events[4]!.ts,
        endedAtMs: events[5]!.ts,
        /* #1007 — and BOTH attempts survive here, which the scalars above cannot
           say: the first span is the one `node.retryDue` drops from them. */
        spans: [
          {
            startedAtMs: events[0]!.ts,
            endedAtMs: events[1]!.ts,
            startedAs: 'dispatched',
            endedAs: 'failure',
            instanceId: undefined,
          },
          {
            startedAtMs: events[4]!.ts,
            endedAtMs: events[5]!.ts,
            startedAs: 'dispatched',
            endedAs: 'success',
            instanceId: undefined,
          },
        ],
      },
    ]);
  });

  it('node.retryDue re-opens the node WITHOUT counting an attempt of its own', () => {
    // Decided explicitly rather than by omission: `retryDue` clears the hold, and
    // the `node.dispatched` that follows it is what bumps `attempts`. Asserted on
    // its own so a future change cannot double-count silently.
    const events = [
      dispatched('a'),
      envelope({
        type: 'node.failed',
        runId: 'r',
        nodeId: 'a',
        attemptId: 'a#0',
        error: 'timeout',
        kind: 'transient',
      }),
      envelope({
        type: 'node.retryScheduled',
        runId: 'r',
        nodeId: 'a',
        attemptId: 'a#0',
        nextAttemptAt: 1,
      }),
      envelope({ type: 'node.retryDue', runId: 'r', nodeId: 'a', previousAttemptId: 'a#0' }),
    ];
    const [a] = deriveNodeActivity(events);
    expect(a!.status).toBe('dispatched');
    expect(a!.attempts).toBe(1);
    expect(a!.error).toBeUndefined();
  });

  it('a parked `wait` node APPEARS at all, then completes on its timer', () => {
    // A `wait` is engine-evaluated and NEVER dispatched (`scheduleWait`, not
    // `dispatchNode`), so before this fix it was absent from the table entirely
    // — start to finish, the monitor showed nothing for it.
    const parked = [
      envelope({
        type: 'timer.waitScheduled',
        runId: 'r',
        nodeId: 'w',
        attemptId: 'w#0',
        dueAt: 1_700_000_000_000,
      }),
    ];
    const [waiting] = deriveNodeActivity(parked);
    // U25 — the park names WHICH alarm: a timer, not an awaited callback.
    expect(waiting!.status).toBe('wait_pending');
    expect(waiting!.attempts).toBe(1);

    const [done] = deriveNodeActivity([
      ...parked,
      envelope({ type: 'timer.due', runId: 'r', nodeId: 'w', previousAttemptId: 'w#0' }),
    ]);
    expect(done!.status).toBe('success');
  });

  it('a parked `webhook` node reads `external_wait_pending`, then succeeds on its callback', () => {
    const parked = [
      envelope({
        type: 'externalWait.created',
        runId: 'r',
        nodeId: 'h',
        attemptId: 'h#0',
        dueAt: 1_700_000_000_000,
      }),
    ];
    expect(deriveNodeActivity(parked)[0]!.status).toBe('external_wait_pending');

    const [done] = deriveNodeActivity([
      ...parked,
      envelope({
        type: 'externalWait.completed',
        runId: 'r',
        nodeId: 'h',
        previousAttemptId: 'h#0',
      }),
    ]);
    expect(done!.status).toBe('success');
  });

  /**
   * #911 — the DECLARED outputs of a node whose success event is NOT
   * `node.succeeded`.
   *
   * FOUR event types terminate a node successfully without one:
   * `externalWait.completed` (a webhook's callback arrived), `timer.due` (a
   * wait's alarm) and `condition.evaluated` / `switch.evaluated` (an
   * engine-evaluated control node). All four used to leave `outputValues` at the
   * `undefined` `clearResult` writes, and the drill-in gates its whole Outputs
   * section on `outputValues !== undefined` — so a webhook's typed callback
   * payload, the one value an operator most wants after completing a wait,
   * rendered NOWHERE, and the other three read as "no result recorded" when the
   * result was recorded and was empty.
   *
   * `undefined` and `{}` are different claims on this field: `undefined` means
   * no terminal result is on record (what a never-reported row carries), `{}`
   * means one is and it is empty. Conflating them is the same fail-open shape
   * as manufacturing a default for an absent fact.
   */
  const parkedWebhook = (attemptId: string) =>
    envelope({
      type: 'externalWait.created',
      runId: 'r',
      nodeId: 'h',
      attemptId,
      dueAt: 1,
    });

  it('a completed webhook carries its callback payload as the node’s outputs', () => {
    const [done] = deriveNodeActivity([
      parkedWebhook('h#0'),
      envelope({
        type: 'externalWait.completed',
        runId: 'r',
        nodeId: 'h',
        previousAttemptId: 'h#0',
        outputs: { decision: 'ship it' },
      }),
    ]);
    expect(done!.outputValues).toEqual({ decision: 'ship it' });
  });

  it('a PRE-A16 completion with no `outputs` field folds to `{}`, not `undefined`', () => {
    // The field is `.optional()` for back-compat and the reducer defaults it to
    // `{}` (`onExternalWaitCompleted`) rather than to "no outputs recorded".
    // This reader agrees with the reducer instead of inventing a third answer.
    const [done] = deriveNodeActivity([
      parkedWebhook('h#0'),
      envelope({
        type: 'externalWait.completed',
        runId: 'r',
        nodeId: 'h',
        previousAttemptId: 'h#0',
      }),
    ]);
    expect(done!.outputValues).toEqual({});
  });

  it('a due timer records an EMPTY result, not no result', () => {
    const [wait] = deriveNodeActivity([
      envelope({
        type: 'timer.waitScheduled',
        runId: 'r',
        nodeId: 'w',
        attemptId: 'w#0',
        dueAt: 1,
      }),
      envelope({ type: 'timer.due', runId: 'r', nodeId: 'w', previousAttemptId: 'w#0' }),
    ]);
    expect(wait!.outputValues).toEqual({});
  });

  it('an evaluated `if` records an EMPTY result, not no result', () => {
    const [cond] = deriveNodeActivity([
      envelope({
        type: 'condition.evaluated',
        runId: 'r',
        nodeId: 'c',
        attemptId: 'c#0',
        branch: 'true',
      }),
    ]);
    expect(cond!.outputValues).toEqual({});
  });

  it('an evaluated `switch` records an EMPTY result, not no result', () => {
    const [sw] = deriveNodeActivity([
      envelope({
        type: 'switch.evaluated',
        runId: 'r',
        nodeId: 's',
        attemptId: 's#0',
        branch: 'case_b',
      }),
    ]);
    expect(sw!.outputValues).toEqual({});
  });

  it('a webhook RE-PARKED after completing shows no stale payload from the last attempt', () => {
    // A back-edge reset re-arms the wait; `externalWait.created` clears the row.
    // Leaving the previous callback's body on a node that is parked AGAIN would
    // present a superseded value as the current one.
    const [reparked] = deriveNodeActivity([
      parkedWebhook('h#0'),
      envelope({
        type: 'externalWait.completed',
        runId: 'r',
        nodeId: 'h',
        previousAttemptId: 'h#0',
        outputs: { decision: 'ship it' },
      }),
      parkedWebhook('h#1'),
    ]);
    expect(reparked!.status).toBe('external_wait_pending');
    expect(reparked!.outputValues).toBeUndefined();
  });

  it('an EXPIRED webhook fails, with a reason (the event carries no error text)', () => {
    const [expired] = deriveNodeActivity([
      envelope({
        type: 'externalWait.created',
        runId: 'r',
        nodeId: 'h',
        attemptId: 'h#0',
        dueAt: 1,
      }),
      envelope({
        type: 'externalWait.expired',
        runId: 'r',
        nodeId: 'h',
        previousAttemptId: 'h#0',
      }),
    ]);
    expect(expired!.status).toBe('failure');
    // Without this the detail column would be blank on a red row — the one
    // place the operator looks to find out WHY.
    expect(expired!.error).toBe('external wait expired before a callback arrived');
  });

  it('a control node (`if`/`switch`) appears and succeeds on its evaluation', () => {
    // Control nodes are never dispatched either: `condition.evaluated` /
    // `switch.evaluated` ARE their terminal-success event (reduce.ts
    // `onControlBranchEvaluated`), so without folding them an `if` node was
    // invisible in the monitor for the whole run.
    const [cond] = deriveNodeActivity([
      envelope({
        type: 'condition.evaluated',
        runId: 'r',
        nodeId: 'c',
        attemptId: 'c#0',
        branch: 'true',
      }),
    ]);
    expect(cond!.status).toBe('success');
    expect(cond!.attempts).toBe(1);

    const [sw] = deriveNodeActivity([
      envelope({
        type: 'switch.evaluated',
        runId: 'r',
        nodeId: 's',
        attemptId: 's#0',
        branch: 'case_b',
      }),
    ]);
    expect(sw!.status).toBe('success');
  });
});

describe('deriveNodeActivity — attempts for the never-dispatched activities (#483)', () => {
  it('counts a `fail` / `filter` control node, whose ONLY event is its terminal one', () => {
    // `fail` and `filter` are engine-evaluated: the reducer emits `failNode` /
    // `succeedControl` and the driver appends only the terminal event — there is
    // no `node.dispatched` to count. Without the unstarted rule both rows read
    // terminal after 0 attempts, i.e. "never ran".
    const [failed] = deriveNodeActivity([
      envelope({
        type: 'node.failed',
        runId: 'r',
        nodeId: 'z',
        attemptId: 'z#0',
        error: 'stop here',
        kind: 'permanent',
      }),
    ]);
    expect(failed!.attempts).toBe(1);
    expect(failed!.status).toBe('failure');

    const [filtered] = deriveNodeActivity([
      envelope({ type: 'node.succeeded', runId: 'r', nodeId: 'f', attemptId: 'f#0', outputs: {} }),
    ]);
    expect(filtered!.attempts).toBe(1);
    expect(filtered!.status).toBe('success');
  });

  it('counts a call node, whose only event is call.returned', () => {
    const [call] = deriveNodeActivity([
      envelope({
        type: 'call.returned',
        runId: 'r',
        callNodeId: 'c',
        attemptId: 'c#0',
        childRunId: 'run_child',
        childOutcome: 'success',
        outputs: {},
      }),
    ]);
    expect(call!.attempts).toBe(1);
    expect(call!.status).toBe('success');
  });

  it('does NOT double-count a node that WAS dispatched', () => {
    // The unstarted rule must be invisible on the ordinary path: a dispatched
    // node already has attempts >= 1 when its terminal event lands.
    const [a] = deriveNodeActivity([
      envelope({
        type: 'node.dispatched',
        runId: 'r',
        nodeId: 'a',
        attemptId: 'a#0',
        idempotent: true,
      }),
      envelope({ type: 'node.succeeded', runId: 'r', nodeId: 'a', attemptId: 'a#0', outputs: {} }),
    ]);
    expect(a!.attempts).toBe(1);
  });
});

// #750 — the advisory is a durable fact in the feed, deliberately NOT a node-row
// signal. The FE fold answers "is this node running / did it end", and a warning
// says nothing about either; the raw event trail is where it reads.
describe('activity.warned is inert in the FE fold (#750)', () => {
  const warned: EngineEvent = {
    type: 'activity.warned',
    runId: 'r',
    nodeId: 'n1',
    attemptId: 'n1#0',
    code: 'empty_truncated_completion',
    reason: 'the model returned no text',
  };

  it('creates no phantom node row on its own', () => {
    expect(deriveNodeActivity([envelope(warned)])).toEqual([]);
  });

  it('leaves an otherwise-normal node projection byte-identical', () => {
    const base: EngineEvent[] = [
      { type: 'run.started', runId: 'r', pipelineVersionId: 'pv', params: {} },
      { type: 'node.dispatched', runId: 'r', nodeId: 'n1', attemptId: 'n1#0', idempotent: true },
      { type: 'node.succeeded', runId: 'r', nodeId: 'n1', attemptId: 'n1#0', outputs: {} },
    ];
    // Stamps are pinned rather than left to the helper's sequence: since #867
    // the fold reads the envelope `ts`, and a seq-derived default would shift
    // the succeeded event's clock purely because a warning was spliced in
    // front of it — an artifact of the helper, not of production, where an
    // inserted event renumbers nothing.
    const without = deriveNodeActivity([
      envelope(base[0]!, 1_000),
      envelope(base[1]!, 1_100),
      envelope(base[2]!, 1_500),
    ]);
    seq = 0;
    const withWarning = deriveNodeActivity([
      envelope(base[0]!, 1_000),
      envelope(base[1]!, 1_100),
      envelope(warned, 1_200),
      envelope(base[2]!, 1_500),
    ]);
    expect(withWarning).toEqual(without);
  });

  it('does not alter the run lifecycle status', () => {
    const events = [
      envelope({ type: 'run.started', runId: 'r', pipelineVersionId: 'pv', params: {} }),
      envelope(warned),
    ];
    expect(deriveRunLifecycle(events)).toEqual({ status: 'running', waitingReason: null });
  });
});

describe('deriveNodeActivity — the failure CLASS and the declared outputs (U24 / #1 F0)', () => {
  const dispatched = (nodeId: string, attemptId: string): EngineEvent => ({
    type: 'node.dispatched',
    runId: 'r',
    nodeId,
    attemptId,
    idempotent: true,
  });

  it('captures `kind` and `code` off `node.failed`, not just the message', () => {
    // The regression this closes: F0 moved the failure class out of the message
    // string and into fields, and nothing in the monitor read them — so a
    // throttled call and a bad credential were indistinguishable on screen.
    const events = [
      envelope(dispatched('a', 'a#0')),
      envelope({
        type: 'node.failed',
        runId: 'r',
        nodeId: 'a',
        attemptId: 'a#0',
        error: 'boom',
        kind: 'transient',
        code: 'rate_limit',
      }),
    ];
    expect(deriveNodeActivity(events)[0]).toMatchObject({
      error: 'boom',
      failureKind: 'transient',
      failureCode: 'rate_limit',
    });
  });

  it('leaves `code` undefined when the producer stated none (it is optional)', () => {
    const events = [
      envelope(dispatched('a', 'a#0')),
      envelope({
        type: 'node.failed',
        runId: 'r',
        nodeId: 'a',
        attemptId: 'a#0',
        error: 'boom',
        kind: 'permanent',
      }),
    ];
    const [a] = deriveNodeActivity(events);
    expect(a!.failureKind).toBe('permanent');
    expect(a!.failureCode).toBeUndefined();
  });

  it('KEEPS the class through the retry hold, and clears it at both RE-OPEN sites', () => {
    // `error` is cleared in three branches — `node.dispatched`, the
    // `retryRequested`/`retryDue` re-open, and the `waitScheduled`/`created`
    // park — and deliberately KEPT on `retryScheduled` (the hold's reason). This
    // covers the first two and the hold; the PARK site has its own test below,
    // because this one never reaches it.
    const failed: EngineEvent = {
      type: 'node.failed',
      runId: 'r',
      nodeId: 'a',
      attemptId: 'a#0',
      error: 'boom',
      kind: 'transient',
      code: 'rate_limit',
    };

    const held = deriveNodeActivity([
      envelope(dispatched('a', 'a#0')),
      envelope(failed),
      envelope({
        type: 'node.retryScheduled',
        runId: 'r',
        nodeId: 'a',
        attemptId: 'a#0',
        nextAttemptAt: 10,
      }),
    ])[0];
    expect(held!).toMatchObject({
      status: 'retry_pending',
      error: 'boom',
      failureKind: 'transient',
    });

    const reopened = deriveNodeActivity([
      envelope(dispatched('a', 'a#0')),
      envelope(failed),
      envelope({
        type: 'node.retryDue',
        runId: 'r',
        nodeId: 'a',
        previousAttemptId: 'a#0',
      }),
    ])[0];
    expect(reopened!.error).toBeUndefined();
    expect(reopened!.failureKind).toBeUndefined();
    expect(reopened!.failureCode).toBeUndefined();

    const redispatched = deriveNodeActivity([
      envelope(dispatched('a', 'a#0')),
      envelope(failed),
      envelope(dispatched('a', 'a#1')),
    ])[0];
    expect(redispatched!.failureKind).toBeUndefined();
    expect(redispatched!.failureCode).toBeUndefined();
  });

  it('has NO class for an expired external wait — that failure carries no `node.failed`', () => {
    // #4 A13 fails the node from the expiry alarm itself, so there is no kind to
    // read. The panel must render the absence rather than manufacture one.
    const events = [
      envelope({
        type: 'externalWait.created',
        runId: 'r',
        nodeId: 'w',
        attemptId: 'w#0',
        dueAt: 5,
      }),
      envelope({
        type: 'externalWait.expired',
        runId: 'r',
        nodeId: 'w',
        previousAttemptId: 'w#0',
      }),
    ];
    const [w] = deriveNodeActivity(events);
    expect(w!.status).toBe('failure');
    expect(w!.error).toBeDefined();
    expect(w!.failureKind).toBeUndefined();
  });

  it('captures the DECLARED outputs off `node.succeeded`, distinct from the streamed count', () => {
    const events = [
      envelope(dispatched('a', 'a#0')),
      envelope({ type: 'node.output', runId: 'r', nodeId: 'a', name: 'text', value: 'hi' }),
      envelope({
        type: 'node.succeeded',
        runId: 'r',
        nodeId: 'a',
        attemptId: 'a#0',
        outputs: { text: 'hi there', tokens: 12 },
      }),
    ];
    const [a] = deriveNodeActivity(events);
    expect(a!.outputs).toBe(1); // the streamed observability count, unchanged
    expect(a!.outputValues).toEqual({ text: 'hi there', tokens: 12 });
  });

  it('captures a call node DECLARED outputs off `call.returned`, on either outcome', () => {
    // A call node never gets a `node.succeeded` — `call.returned` is its ONE
    // terminal event, so it is the only door its outputs can come through. The
    // `failure` half is not symmetry for its own sake: the event schema records
    // that a failed child may still carry projected outputs (the findings loop),
    // so gating the fold on success would drop that documented case silently.
    const returned = (callNodeId: string, childOutcome: 'success' | 'failure') =>
      envelope({
        type: 'call.returned' as const,
        runId: 'r',
        callNodeId,
        attemptId: `${callNodeId}#0`,
        childRunId: `run_${callNodeId}`,
        childOutcome,
        outputs: { findings: 3, report: 'ok' },
      });

    const [ok, bad] = deriveNodeActivity([returned('c', 'success'), returned('d', 'failure')]);
    expect(ok!.status).toBe('success');
    expect(ok!.outputValues).toEqual({ findings: 3, report: 'ok' });
    expect(bad!.status).toBe('failure');
    expect(bad!.outputValues).toEqual({ findings: 3, report: 'ok' });
  });

  it('names the INSTANCE a collapsed result came from, and nothing for an ordinary node', () => {
    // A parallel foreach's item instances (`w@1`) fold onto the one node the
    // author drew (`w`), last-write-wins. The row cannot avoid the collapse, but
    // it can say which instance the result on show belongs to.
    const [w] = deriveNodeActivity([
      envelope(dispatched('w@1', 'w@1#0')),
      envelope({
        type: 'node.succeeded',
        runId: 'r',
        nodeId: 'w@1',
        attemptId: 'w@1#0',
        outputs: { n: 1 },
      }),
    ]);
    expect(w!.nodeId).toBe('w');
    expect(w!.instanceId).toBe('w@1');

    const [a] = deriveNodeActivity([
      envelope(dispatched('a', 'a#0')),
      envelope({ type: 'node.succeeded', runId: 'r', nodeId: 'a', attemptId: 'a#0', outputs: {} }),
    ]);
    expect(a!.instanceId).toBeUndefined();
  });
});

describe('deriveNodeActivity — a row that folds TWO instances (U24)', () => {
  const dispatched = (nodeId: string, attemptId: string): EngineEvent => ({
    type: 'node.dispatched',
    runId: 'r',
    nodeId,
    attemptId,
    idempotent: true,
  });

  // A parallel foreach's item instances are NOT serialised — `reduce-a4b` pins
  // exactly this interleave — so both terminals land on the one canvas row. Each
  // terminal must therefore own the WHOLE result: without that, the row keeps
  // one instance's outputs beside another's failure, and `instanceId` then
  // attributes the pair to whichever wrote last.
  it('shows the LAST instance whole, never a green row wearing a red instance’s failure', () => {
    const [w] = deriveNodeActivity([
      envelope(dispatched('w@1', 'w@1#0')),
      envelope(dispatched('w@2', 'w@2#0')),
      envelope({
        type: 'node.failed',
        runId: 'r',
        nodeId: 'w@2',
        attemptId: 'w@2#0',
        error: 'boom',
        kind: 'transient',
        code: 'rate_limit',
      }),
      envelope({
        type: 'node.succeeded',
        runId: 'r',
        nodeId: 'w@1',
        attemptId: 'w@1#0',
        outputs: { v: 1 },
      }),
    ]);
    expect(w!.status).toBe('success');
    expect(w!.instanceId).toBe('w@1');
    expect(w!.outputValues).toEqual({ v: 1 });
    // The red instance's residue must be gone, or the row reads green while its
    // Detail column quotes a failure.
    expect(w!.error).toBeUndefined();
    expect(w!.failureKind).toBeUndefined();
    expect(w!.failureCode).toBeUndefined();
  });

  it('and the mirror — a red row carries no earlier instance’s outputs', () => {
    const [w] = deriveNodeActivity([
      envelope(dispatched('w@1', 'w@1#0')),
      envelope(dispatched('w@2', 'w@2#0')),
      envelope({
        type: 'node.succeeded',
        runId: 'r',
        nodeId: 'w@1',
        attemptId: 'w@1#0',
        outputs: { v: 1 },
      }),
      envelope({
        type: 'node.failed',
        runId: 'r',
        nodeId: 'w@2',
        attemptId: 'w@2#0',
        error: 'boom',
        kind: 'transient',
      }),
    ]);
    expect(w!.status).toBe('failure');
    expect(w!.instanceId).toBe('w@2');
    expect(w!.failureKind).toBe('transient');
    expect(w!.outputValues).toBeUndefined();
  });

  it('attributes a PARKED instance too, not only a dispatched one', () => {
    // `instanceId` is documented as "the raw id the result came from", so every
    // terminal branch must set it — a parked `webhook` instance included.
    const [w] = deriveNodeActivity([
      envelope({
        type: 'externalWait.created',
        runId: 'r',
        nodeId: 'w@3',
        attemptId: 'w@3#0',
        dueAt: 5,
      }),
      envelope({
        type: 'externalWait.expired',
        runId: 'r',
        nodeId: 'w@3',
        previousAttemptId: 'w@3#0',
      }),
    ]);
    expect(w!.nodeId).toBe('w');
    expect(w!.instanceId).toBe('w@3');
  });

  it('the PARK clears a previous failure’s class — the third clearResult site', () => {
    // The two re-open sites are covered above; this is the one a `wait`/`webhook`
    // reaches, and it is the site the earlier test's title did not actually reach.
    const [w] = deriveNodeActivity([
      envelope(dispatched('w', 'w#0')),
      envelope({
        type: 'node.failed',
        runId: 'r',
        nodeId: 'w',
        attemptId: 'w#0',
        error: 'boom',
        kind: 'transient',
        code: 'rate_limit',
      }),
      envelope({
        type: 'timer.waitScheduled',
        runId: 'r',
        nodeId: 'w',
        attemptId: 'w#1',
        dueAt: 10,
      }),
    ]);
    expect(w!.status).toBe('wait_pending');
    expect(w!.error).toBeUndefined();
    expect(w!.failureKind).toBeUndefined();
    expect(w!.failureCode).toBeUndefined();
  });

  it('a failure stored BEFORE F0 minted `kind` reads as unclassified, not as `permanent`', () => {
    // `EngineEventSchema` gives `kind` a `.default('permanent')` as a PARSE
    // boundary for exactly these events. Safe for the reducer, but reading the
    // parsed value would print a machine-readable class onto an event whose
    // producer never stated one — an absent fact dressed as a recorded one.
    const preF0: RunEvent = {
      id: 'evt_pre',
      runId: 'r',
      seq: 900,
      type: 'node.failed',
      payload: { type: 'node.failed', runId: 'r', nodeId: 'a', attemptId: 'a#0', error: 'boom' },
      ts: 900,
    };
    const [a] = deriveNodeActivity([envelope(dispatched('a', 'a#0')), preF0]);
    expect(a!.status).toBe('failure');
    expect(a!.error).toBe('boom');
    expect(a!.failureKind).toBeUndefined();
  });
});

describe("deriveNodeActivity — a rerun's COPIED frontier (#918)", () => {
  /**
   * The defect: `run.reseeded` is a SIXTH terminal-success event and the fold
   * treated it as inert, so a rerun-from-failed's copied nodes got no row from
   * the fold at all. `reconcileNodeActivity` then seeded one with
   * `outputValues: undefined` — "success · 0 attempts" and NO Outputs section,
   * over a result the engine demonstrably holds and every downstream
   * `${nodes.x.output.y}` resolves against.
   *
   * The event shape here is the producer's: `reseed.ts` appends
   * `run.started{rerunOf}` and this manifest in ONE transaction into a
   * brand-new run's empty log, so a reseed is always the second event and the
   * frontier ids are always top-level (RS2's contract).
   */
  function reseededLog(over: Partial<Extract<EngineEvent, { type: 'run.reseeded' }>> = {}) {
    return [
      envelope({
        type: 'run.started',
        runId: 'r2',
        pipelineVersionId: 'pv',
        params: {},
        /* This fold ignores `rerunOf`, but the fixture carries it because the
           producer must: it is what DEFERS dispatch, and a reseed appended
           after an ordinary `run.started` is refused outright by the reducer's
           `progressed` guard. A fixture that could not exist would pin this
           fold against a log the engine never writes. */
        rerunOf: 'r1',
      }),
      envelope({
        type: 'run.reseeded',
        runId: 'r2',
        sourceRunId: 'r1',
        frontier: ['a'],
        copiedOutputs: { a: { status: 200 } },
        copiedContainers: {},
        ...over,
      }),
    ];
  }

  it('makes a row per frontier node carrying the copied outputs and the source run', () => {
    const rows = deriveNodeActivity(
      reseededLog({
        frontier: ['a', 'b'],
        copiedOutputs: { a: { status: 200 }, b: { body: 'ok' } },
      }),
    );

    expect(rows).toEqual([
      {
        ...NO_LLM_ACTIVITY,
        nodeId: 'a',
        status: 'success',
        // ZERO, and it is the engine's own answer (`onReseeded` writes
        // `attempts: 0`): the node did not start in THIS run. `countIfUnstarted`
        // must not fire here — that helper is for a node whose ONE event is its
        // terminal, which did run.
        attempts: 0,
        outputs: 0,
        lastOutputName: undefined,
        error: undefined,
        failureKind: undefined,
        failureCode: undefined,
        outputValues: { status: 200 },
        copiedFromRunId: 'r1',
        instanceId: undefined,
        // No span, and no fabricated one: a copied node has no duration in this
        // run, so the panel must say so rather than print a `0ms` nobody
        // observed.
        startedAtMs: undefined,
        endedAtMs: undefined,
        /* #1007 — and no span either, for the same reason and with the same
           consequence: a copied node did not run in THIS run, so the timeline
           lists it as untimed rather than drawing it a bar. */
        spans: [],
      },
      {
        ...NO_LLM_ACTIVITY,
        nodeId: 'b',
        status: 'success',
        attempts: 0,
        outputs: 0,
        lastOutputName: undefined,
        error: undefined,
        failureKind: undefined,
        failureCode: undefined,
        outputValues: { body: 'ok' },
        copiedFromRunId: 'r1',
        instanceId: undefined,
        startedAtMs: undefined,
        endedAtMs: undefined,
        spans: [],
      },
    ]);
  });

  it('records an empty copied result as `{}` — the reducer\'s own fallback, not "no result"', () => {
    /* Not a live producer case: `reseedFrontier` writes `copiedOutputs[id]` for
       EVERY frontier id (`{...(outputs[id] ?? {})}`), so a missing key cannot
       arrive from the engine. It is pinned because the fold's `?? {}` must
       agree with the reducer's rather than invent a third answer, and because
       `{}` and `undefined` are DIFFERENT claims on this field — "recorded, and
       empty" versus "no terminal result on record", which the panel renders
       differently. */
    const [a] = deriveNodeActivity(reseededLog({ copiedOutputs: {} }));

    expect(a?.outputValues).toEqual({});
    expect(a?.outputValues).not.toBeUndefined();
  });

  it('makes no row for a copied CONTAINER — this table has no container rows', () => {
    const rows = deriveNodeActivity(
      reseededLog({
        frontier: ['a'],
        copiedContainers: { loop1: { status: 'success', round: 2, outputs: {} } },
      }),
    );

    expect(rows.map((n) => n.nodeId)).toEqual(['a']);
  });

  it('folds a literal `x@2` frontier id onto its canvas row and names the key it came from', () => {
    /* The instance-key collapse `ensure` applies everywhere, reaching this arm
       too. RS2's contract is top-level ids, so this is the LITERAL-id case the
       whole fold accepts as a known cost (save-time refuses such ids only for
       `batchCount >= 2`, and a doc-free view cannot tell the two apart). Pinned
       because the alternative — a row keyed `x@2` that no canvas node matches —
       is a row the operator cannot act on. */
    const [row] = deriveNodeActivity(
      reseededLog({ frontier: ['x@2'], copiedOutputs: { 'x@2': { ok: true } } }),
    );

    expect(row?.nodeId).toBe('x');
    expect(row?.instanceId).toBe('x@2');
    expect(row?.outputValues).toEqual({ ok: true });
  });

  it('leaves no stale failure beside the copied success on a log the reducer would refuse', () => {
    /* A FORGED log, and pinned as one. The producer appends this manifest into a
       brand-new run's empty log, so the reducer's `progressed` guard refuses
       exactly this shape — but the fold is doc-free and state-free, cannot make
       that check, and is TOTAL, so it will still do something here. What it must
       not do is leave the old failure's message and class sitting beside a green
       badge, which is why the arm calls `clearResult` like every other terminal
       branch rather than only assigning. */
    const failedFirst = [
      envelope({
        type: 'node.dispatched',
        runId: 'r2',
        nodeId: 'a',
        attemptId: 'att_0',
        idempotent: true,
      }),
      envelope({
        type: 'node.failed',
        runId: 'r2',
        nodeId: 'a',
        attemptId: 'att_0',
        error: 'boom',
        kind: 'permanent',
      }),
    ];

    /* THE FIXTURE'S OWN PREMISE, asserted rather than assumed. The first draft
       wrote the failure as `message` — the field is `error` — so
       `EngineEventSchema.safeParse` rejected the event, the fold skipped it
       silently, and there was nothing left for `clearResult` to clear: the test
       passed with the very line it claims to pin DELETED. Without this
       assertion the test cannot tell "the arm cleared the failure" from "there
       was never a failure". */
    expect(deriveNodeActivity(failedFirst)[0]?.error).toBe('boom');

    const rows = deriveNodeActivity([...failedFirst, ...reseededLog().slice(1)]);

    expect(rows[0]?.status).toBe('success');
    expect(rows[0]?.error).toBeUndefined();
    expect(rows[0]?.failureKind).toBeUndefined();
    expect(rows[0]?.copiedFromRunId).toBe('r1');
  });

  it('drops the copy claim when the node is re-dispatched, so it cannot outlive the result it describes', () => {
    /* Unreachable from today's producers — `reseedFrontier` excludes every
       top-level node in a back-edge loop body, and a copied node has no
       `currentAttemptId` for `resume` to pick up. Pinned anyway because the
       field is part of the node's RESULT: were a later producer to re-execute a
       copied node, a stale "reused from run r1" standing over a value this run
       computed is a wrong answer, not a cosmetic one. */
    const rows = deriveNodeActivity([
      ...reseededLog(),
      envelope({
        type: 'node.dispatched',
        runId: 'r2',
        nodeId: 'a',
        attemptId: 'att_1',
        idempotent: true,
      }),
    ]);

    expect(rows[0]?.copiedFromRunId).toBeUndefined();
    expect(rows[0]?.outputValues).toBeUndefined();
    expect(rows[0]?.status).toBe('dispatched');
  });
});

describe('reconcileNodeActivity', () => {
  /**
   * `a` fans out to `b` on success and `c` on failure, so a run in which `a`
   * succeeds leaves `c` ROUTED AROUND — the case the doc-free fold structurally
   * cannot show, because the reducer computes a skip and appends no event for
   * it. The projection is built by the REAL reducer rather than hand-written:
   * a fixture RunState I invented would pin my assumptions about `seedState`
   * rather than its behaviour.
   */
  const DOC: EngineDoc = {
    nodes: [
      { id: 'a', type: 'http_request', position: { x: 0, y: 0 }, config: {} },
      { id: 'b', type: 'http_request', position: { x: 200, y: 0 }, config: {} },
      { id: 'c', type: 'http_request', position: { x: 400, y: 0 }, config: {} },
    ],
    edges: [
      { id: 'e1', from: 'a', to: 'b', on: 'success' },
      { id: 'e2', from: 'a', to: 'c', on: 'failure' },
    ],
  };

  /** `run.started` + `a` dispatched and succeeded, so `c` is routed around. */
  function aSucceededLog(): RunEvent[] {
    const started = envelope({
      type: 'run.started',
      runId: 'r',
      pipelineVersionId: 'pv',
      params: {},
    });
    // Read the attempt id OFF the projection: `onDispatched` ignores an event
    // whose `attemptId` is not the one the reducer assigned, so a made-up id
    // folds to nothing and the test would assert against an empty state.
    const afterStart = projectRun(DOC, [started]);
    if (!afterStart.ok) throw new Error('fixture: run.started must project');
    const attemptId = afterStart.state.nodes.a?.currentAttemptId;
    if (attemptId === undefined) throw new Error('fixture: `a` must be ready with an attempt');
    return [
      started,
      envelope({ type: 'node.dispatched', runId: 'r', nodeId: 'a', attemptId, idempotent: false }),
      envelope({ type: 'node.succeeded', runId: 'r', nodeId: 'a', attemptId, outputs: {} }),
    ];
  }

  function stateOf(events: RunEvent[]) {
    const projection = projectRun(DOC, events);
    if (!projection.ok) throw new Error(`fixture: must project — ${projection.reason}`);
    return projection.state;
  }

  /** A folded row, for the precedence rules that need one to already exist. */
  function row(over: Partial<NodeActivity> & { nodeId: string }): NodeActivity {
    return {
      ...NO_LLM_ACTIVITY,
      status: 'dispatched',
      attempts: 1,
      outputs: 0,
      lastOutputName: undefined,
      error: undefined,
      failureKind: undefined,
      failureCode: undefined,
      outputValues: undefined,
      copiedFromRunId: undefined,
      instanceId: undefined,
      startedAtMs: undefined,
      endedAtMs: undefined,
      spans: [],
      ...over,
    };
  }

  it('gives a ROUTED-AROUND node a row that says `skipped` — the graph said so and the table said nothing', () => {
    const events = aSucceededLog();
    const folded = deriveNodeActivity(events);
    // The defect, stated as the premise: the fold has no row for `c` at all,
    // which on screen is indistinguishable from "the run never reached it".
    expect(folded.map((n) => n.nodeId)).toEqual(['a']);

    const reconciled = reconcileNodeActivity(folded, stateOf(events));
    const c = reconciled.find((n) => n.nodeId === 'c');
    expect(c).toBeDefined();
    expect(c!.status).toBe('skipped');
  });

  it('#866 — a SYNTHESIZED row carries an empty cost and no tool calls, as measured', () => {
    const reconciled = reconcileNodeActivity(
      deriveNodeActivity(aSucceededLog()),
      stateOf(aSucceededLog()),
    );
    const c = reconciled.find((n) => n.nodeId === 'c');
    // The row exists BECAUSE no event named this node, so nothing billed under
    // it: an empty cost is the measurement, not a stand-in for a missing one.
    expect(c!.cost).toEqual(emptyNodeCost());
    expect(c!.cost.complete).toBe(true);
    expect(c!.costSpansInstances).toBe(false);
    expect(c!.toolCalls).toEqual([]);
  });

  it('gives a node that never started a row, rather than leaving the operator to infer it', () => {
    const events = aSucceededLog();
    const reconciled = reconcileNodeActivity(deriveNodeActivity(events), stateOf(events));
    const b = reconciled.find((n) => n.nodeId === 'b');
    expect(b).toBeDefined();
    // `b` is the successor of a succeeded node, so the engine has already made
    // it ready — either way it is a state the log alone cannot report.
    expect(['pending', 'ready']).toContain(b!.status);
    // ZERO attempts, even though the ENGINE says one. The reducer bumps its
    // counter when it mints the attempt id at READY, so `engine.attempts` reads
    // 1 for a node that has not run — pinned here because it is the reason the
    // seeded row does not copy the field, and a future refactor that "tidies"
    // the 0 into `engine.attempts` must go red.
    expect(stateOf(events).nodes.b?.attempts).toBe(1);
    expect(b!.attempts).toBe(0);
  });

  it('keeps the folded rows FIRST and in their own order, with the engine-only rows after', () => {
    const events = aSucceededLog();
    const reconciled = reconcileNodeActivity(deriveNodeActivity(events), stateOf(events));
    expect(reconciled.map((n) => n.nodeId)).toEqual(['a', 'b', 'c']);
  });

  it('lets the ENGINE settle the status, since it sees routing and the doc and the fold does not', () => {
    const events = aSucceededLog();
    const reconciled = reconcileNodeActivity(
      [row({ nodeId: 'a', status: 'failure' })],
      stateOf(events),
    );
    expect(reconciled[0]!.status).toBe('success');
  });

  it('overrides ONLY the status — every column the projection does not carry stays the fold’s', () => {
    // The projection discards the failure message, its F0 class, the streamed
    // output count and the declared outputs. Taking the row wholesale from
    // `NodeRunState` would trade a rich row for a poorer one to buy a
    // consistency nothing was violating.
    const events = aSucceededLog();
    const rich = row({
      nodeId: 'a',
      status: 'failure',
      attempts: 3,
      outputs: 2,
      lastOutputName: 'text',
      error: 'boom',
      failureKind: 'transient',
      failureCode: 'rate_limit',
      outputValues: { body: 'hi' },
      instanceId: 'a@1',
    });
    const [reconciled] = reconcileNodeActivity([rich], stateOf(events));
    expect(reconciled).toEqual({ ...rich, status: 'success' });
  });

  it('leaves a row the projection has NO opinion about exactly as folded', () => {
    // A parallel foreach's body node is the real case: `seedState` deliberately
    // skips `parallelChildIds`, and the per-item keys its state lives under are
    // deleted as items complete — so `state.nodes[bare]` is absent whether the
    // node has never run, is running, or has finished. Reading absent as
    // `pending` would blank exactly the rows a parallel foreach lights up.
    const events = aSucceededLog();
    const body = row({ nodeId: 'w', status: 'dispatched', instanceId: 'w@1' });
    const [reconciled] = reconcileNodeActivity([body], stateOf(events));
    expect(reconciled).toEqual(body);
  });

  it('credits a parked call node its attempt, since a `startChild` park announces itself to nobody', () => {
    /* The one status whose absence from the fold does NOT mean "nothing started
       it": the engine parks a `call_pipeline` node with a COMMAND and appends
       no event until `call.returned`, bumping `attempts` as it does. Rendering
       0 would say "waiting (child run) · 0 attempts" over a child run that is
       genuinely on its first attempt. */
    const events = aSucceededLog();
    const state = stateOf(events);
    const parked = {
      ...state,
      nodes: {
        ...state.nodes,
        child: { status: 'waiting' as const, attempts: 1, retries: 0 },
      },
    };
    const child = reconcileNodeActivity([], parked).find((n) => n.nodeId === 'child');
    expect(child!.status).toBe('waiting');
    expect(child!.attempts).toBe(1);

    // …and the exception is NARROW: every other seeded status still reports 0,
    // because the engine bumps its counter at READY and this column counts
    // starts. `b` is ready with `engine.attempts === 1`.
    const b = reconcileNodeActivity([], parked).find((n) => n.nodeId === 'b');
    expect(b!.attempts).toBe(0);
  });

  it('does not mint a row for an INSTANCE key — `w@1` and `w@2` have no defensible single status', () => {
    const events = aSucceededLog();
    const state = stateOf(events);
    const withInstances = {
      ...state,
      nodes: {
        ...state.nodes,
        'w@1': { status: 'dispatched' as const, attempts: 1, retries: 0 },
        'w@2': { status: 'success' as const, attempts: 1, retries: 0 },
      },
    };
    const ids = reconcileNodeActivity([], withInstances).map((n) => n.nodeId);
    expect(ids).not.toContain('w@1');
    expect(ids).not.toContain('w@2');
    expect(ids).not.toContain('w');
  });

  it('#867 — drops an OPEN span when the engine reports the node terminal', () => {
    /* The reducer can settle a node with no node event at all:
       `container.timedOut` flips a live child to `skipped` through
       `abandonLiveChildren`. The fold is then left holding a start whose close
       can never arrive, and rendering that as an unsettled attempt describes a
       node that will never run again as still running. */
    const state = stateOf(aSucceededLog());
    const abandoned = {
      ...state,
      nodes: { ...state.nodes, a: { status: 'skipped' as const, attempts: 1, retries: 0 } },
    };
    const [only] = reconcileNodeActivity([row({ nodeId: 'a', startedAtMs: 1_000 })], abandoned);
    expect(only!.status).toBe('skipped');
    expect(only!.startedAtMs).toBeUndefined();
  });

  it('#867 — leaves an OPEN span alone while the engine still calls the node live', () => {
    // The other half of the rule above, and the one that keeps it a RULE rather
    // than "always drop": a node the engine reports as still running has an
    // attempt genuinely in flight, and its start is a real stamp.
    const state = stateOf(aSucceededLog());
    const live = {
      ...state,
      nodes: { ...state.nodes, a: { status: 'dispatched' as const, attempts: 1, retries: 0 } },
    };
    const [only] = reconcileNodeActivity([row({ nodeId: 'a', startedAtMs: 1_000 })], live);
    expect(only!.status).toBe('dispatched');
    expect(only!.startedAtMs).toBe(1_000);
  });

  it('#867 — leaves a CLOSED span alone, because it is a measurement that happened', () => {
    const state = stateOf(aSucceededLog());
    const done = {
      ...state,
      nodes: { ...state.nodes, a: { status: 'success' as const, attempts: 1, retries: 0 } },
    };
    const [only] = reconcileNodeActivity(
      [row({ nodeId: 'a', status: 'success', startedAtMs: 1_000, endedAtMs: 4_000 })],
      done,
    );
    expect(only!.startedAtMs).toBe(1_000);
    expect(only!.endedAtMs).toBe(4_000);
  });

  it('#1007 — retracts the trailing OPEN span too, but keeps the closed history beside it', () => {
    /* The same judgement as the first test in this group, reaching `spans`. The
       three tests above pass rows whose `spans` is empty, so NONE of them can
       tell whether the array is touched at all — this one carries a real history:
       one attempt that completed, then one still in flight when the engine
       settled the node. Only the in-flight entry may go. Keeping it would draw a
       bar the scalars have already retracted; dropping the closed one would
       delete an attempt that demonstrably ran. */
    const state = stateOf(aSucceededLog());
    const abandoned = {
      ...state,
      nodes: { ...state.nodes, a: { status: 'skipped' as const, attempts: 2, retries: 0 } },
    };
    const history: AttemptSpan[] = [
      {
        startedAtMs: 1_000,
        endedAtMs: 1_400,
        startedAs: 'dispatched',
        endedAs: 'failure',
        instanceId: undefined,
      },
      {
        startedAtMs: 2_000,
        endedAtMs: undefined,
        startedAs: 'dispatched',
        endedAs: undefined,
        instanceId: undefined,
      },
    ];
    const [only] = reconcileNodeActivity(
      [row({ nodeId: 'a', startedAtMs: 2_000, spans: history })],
      abandoned,
    );
    expect(only!.status).toBe('skipped');
    expect(only!.startedAtMs).toBeUndefined();
    expect(only!.spans).toEqual([history[0]]);
  });
});

/**
 * #867 — a node's DURATION span, stamped from the envelope `ts`.
 *
 * The events the log already carries are the only clock there is: the reducer
 * is pure and stamps no per-node time, and `activity.captured.latencyMs` is a
 * different number (one provider call, on two activity kinds). So a span is a
 * pair of append stamps, and the whole correctness question is WHICH pair.
 */
describe('deriveNodeActivity — duration span (#867)', () => {
  const rowFor = (events: RunEvent[], nodeId: string): NodeActivity => {
    const row = deriveNodeActivity(events).find((r) => r.nodeId === nodeId);
    if (row === undefined) throw new Error(`no row for ${nodeId}`);
    return row;
  };

  it('spans dispatch → terminal', () => {
    const events = [
      envelope(
        { type: 'node.dispatched', runId: 'r', nodeId: 'a', attemptId: 'a#0', idempotent: true },
        1_000,
      ),
      envelope(
        { type: 'node.succeeded', runId: 'r', nodeId: 'a', attemptId: 'a#0', outputs: {} },
        1_500,
      ),
    ];
    const row = rowFor(events, 'a');
    expect(row.startedAtMs).toBe(1_000);
    expect(row.endedAtMs).toBe(1_500);
  });

  it('measures the LATEST attempt, so a retry HOLD is excluded', () => {
    // The defect this pins: a first-dispatch→terminal span silently swallows
    // the `retryScheduled`→`retryDue` hold, which policy can set to minutes.
    // Per-attempt makes the hold fall BETWEEN two spans rather than inside one.
    const events = [
      envelope(
        { type: 'node.dispatched', runId: 'r', nodeId: 'a', attemptId: 'a#0', idempotent: true },
        1_000,
      ),
      envelope(
        {
          type: 'node.failed',
          runId: 'r',
          nodeId: 'a',
          attemptId: 'a#0',
          error: 'boom',
          kind: 'transient',
        },
        1_200,
      ),
      envelope(
        {
          type: 'node.retryScheduled',
          runId: 'r',
          nodeId: 'a',
          attemptId: 'a#0',
          nextAttemptAt: 61_000,
        },
        1_200,
      ),
      envelope(
        { type: 'node.retryDue', runId: 'r', nodeId: 'a', previousAttemptId: 'a#0' },
        61_000,
      ),
      envelope(
        { type: 'node.dispatched', runId: 'r', nodeId: 'a', attemptId: 'a#1', idempotent: true },
        61_010,
      ),
      envelope(
        { type: 'node.succeeded', runId: 'r', nodeId: 'a', attemptId: 'a#1', outputs: {} },
        61_310,
      ),
    ];
    const row = rowFor(events, 'a');
    expect(row.startedAtMs).toBe(61_010);
    expect(row.endedAtMs).toBe(61_310);
  });

  it('re-opens the span on a re-dispatch, so a retrying node is not still holding its last end', () => {
    const events = [
      envelope(
        { type: 'node.dispatched', runId: 'r', nodeId: 'a', attemptId: 'a#0', idempotent: true },
        1_000,
      ),
      envelope(
        {
          type: 'node.failed',
          runId: 'r',
          nodeId: 'a',
          attemptId: 'a#0',
          error: 'boom',
          kind: 'transient',
        },
        1_200,
      ),
      envelope(
        { type: 'node.dispatched', runId: 'r', nodeId: 'a', attemptId: 'a#1', idempotent: true },
        9_000,
      ),
    ];
    const row = rowFor(events, 'a');
    expect(row.startedAtMs).toBe(9_000);
    expect(row.endedAtMs).toBeUndefined();
  });

  it("spans a wait's PARK, because for a parked node waiting is the work", () => {
    // `timer.due` IS the success event for a `wait` — no `node.succeeded`
    // follows it — so a terminal set of {succeeded, failed} would leave every
    // parked node with an open span reading "so far" forever.
    const events = [
      envelope(
        {
          type: 'timer.waitScheduled',
          runId: 'r',
          nodeId: 'w',
          attemptId: 'w#0',
          dueAt: 30_000,
        },
        1_000,
      ),
      envelope({ type: 'timer.due', runId: 'r', nodeId: 'w', previousAttemptId: 'w#0' }, 30_050),
    ];
    const row = rowFor(events, 'w');
    expect(row.startedAtMs).toBe(1_000);
    expect(row.endedAtMs).toBe(30_050);
  });

  it('spans an external wait to its expiry, which is that node’s failure', () => {
    const events = [
      envelope(
        {
          type: 'externalWait.created',
          runId: 'r',
          nodeId: 'h',
          attemptId: 'h#0',
          dueAt: 50_000,
        },
        2_000,
      ),
      envelope(
        { type: 'externalWait.expired', runId: 'r', nodeId: 'h', previousAttemptId: 'h#0' },
        50_100,
      ),
    ];
    const row = rowFor(events, 'h');
    expect(row.startedAtMs).toBe(2_000);
    expect(row.endedAtMs).toBe(50_100);
  });

  it('gives an if/switch NO span, because its one event is both start and terminal', () => {
    // `condition.evaluated` is the whole life of an `if`: it starts it AND
    // succeeds it. Stamping a start off it would leave an end that never
    // arrives, and a long-finished branch node would read "3h so far".
    const events = [
      envelope(
        {
          type: 'condition.evaluated',
          runId: 'r',
          nodeId: 'c',
          attemptId: 'c#0',
          branch: 'true',
        },
        1_000,
      ),
    ];
    const row = rowFor(events, 'c');
    expect(row.startedAtMs).toBeUndefined();
    expect(row.endedAtMs).toBeUndefined();
  });

  it('gives a `fail` control node no START, so no span is claimed for it', () => {
    // Its `node.failed` is its only event. We hold an end stamp and no start,
    // which is exactly "no span" — never a manufactured `0ms`.
    const events = [
      envelope(
        {
          type: 'node.failed',
          runId: 'r',
          nodeId: 'f',
          attemptId: 'f#0',
          error: 'stopped',
          kind: 'permanent',
        },
        1_000,
      ),
    ];
    const row = rowFor(events, 'f');
    expect(row.startedAtMs).toBeUndefined();
  });

  it('drops the span when a terminal comes from a DIFFERENT foreach instance', () => {
    // `w@1`/`w@2` fold onto one `w` row, last-write-wins. Pairing w@1's start
    // with w@2's terminal would render a number that is not any item's runtime
    // — a fabricated fact, which is worse than the em-dash this leaves.
    const events = [
      envelope(
        {
          type: 'node.dispatched',
          runId: 'r',
          nodeId: 'w@1',
          attemptId: 'w@1#0',
          idempotent: true,
        },
        1_000,
      ),
      envelope(
        { type: 'node.succeeded', runId: 'r', nodeId: 'w@2', attemptId: 'w@2#0', outputs: {} },
        9_000,
      ),
    ];
    const row = rowFor(events, 'w');
    expect(row.startedAtMs).toBeUndefined();
    expect(row.endedAtMs).toBeUndefined();
  });

  it('forgets the previous attempt\u2019s span while a node is re-opened for retry', () => {
    // The window between `node.retryDue` and the re-dispatch is a real live-tail
    // frame — and it freezes permanently if the process dies after the boot
    // reconciler's `node.retryRequested`. Keeping the old span there shows the
    // duration of the attempt BEFORE last beside a node that is running again,
    // under a label that says "the latest attempt".
    const events = [
      envelope(
        { type: 'node.dispatched', runId: 'r', nodeId: 'a', attemptId: 'a#0', idempotent: true },
        1_000,
      ),
      envelope(
        {
          type: 'node.failed',
          runId: 'r',
          nodeId: 'a',
          attemptId: 'a#0',
          error: 'boom',
          kind: 'transient',
        },
        1_200,
      ),
      envelope(
        { type: 'node.retryDue', runId: 'r', nodeId: 'a', previousAttemptId: 'a#0' },
        61_000,
      ),
    ];
    const row = rowFor(events, 'a');
    expect(row.status).toBe('dispatched');
    expect(row.startedAtMs).toBeUndefined();
    expect(row.endedAtMs).toBeUndefined();
  });

  it('keeps the span when the SAME foreach instance starts and terminates', () => {
    const events = [
      envelope(
        {
          type: 'node.dispatched',
          runId: 'r',
          nodeId: 'w@1',
          attemptId: 'w@1#0',
          idempotent: true,
        },
        1_000,
      ),
      envelope(
        { type: 'node.succeeded', runId: 'r', nodeId: 'w@1', attemptId: 'w@1#0', outputs: {} },
        1_400,
      ),
    ];
    const row = rowFor(events, 'w');
    expect(row.startedAtMs).toBe(1_000);
    expect(row.endedAtMs).toBe(1_400);
  });
});

describe('deriveNodeActivity — the span HISTORY behind U12a (#1007)', () => {
  const rowFor = (events: RunEvent[], nodeId: string): NodeActivity => {
    const row = deriveNodeActivity(events).find((r) => r.nodeId === nodeId);
    if (row === undefined) throw new Error(`no row for ${nodeId}`);
    return row;
  };

  const dispatched = (nodeId: string, attempt: number, ts: number): RunEvent =>
    envelope(
      {
        type: 'node.dispatched',
        runId: 'r',
        nodeId,
        attemptId: `${nodeId}#${attempt}`,
        idempotent: true,
      },
      ts,
    );

  const succeeded = (nodeId: string, attempt: number, ts: number): RunEvent =>
    envelope(
      { type: 'node.succeeded', runId: 'r', nodeId, attemptId: `${nodeId}#${attempt}`, outputs: {} },
      ts,
    );

  const failed = (nodeId: string, attempt: number, ts: number): RunEvent =>
    envelope(
      {
        type: 'node.failed',
        runId: 'r',
        nodeId,
        attemptId: `${nodeId}#${attempt}`,
        error: 'boom',
        kind: 'transient',
      },
      ts,
    );

  it('KEEPS the failed attempt when a policy retry drops the span — the history the scalars cannot hold', () => {
    /* The defect this pins, and the whole reason `spans` is kept BESIDE the two
       scalars instead of being their source. `node.retryDue` calls `dropSpan`,
       which the scalars NEED (between the retry firing and the re-dispatch the
       row must not show attempt 1's completed duration beside a running status).
       Derive the array from the scalars and that drop deletes attempt 1
       outright, so every policy retry — the single most important thing an
       attempt timeline has to draw — erases the attempt it retried. */
    const events = [
      dispatched('a', 0, 1_000),
      failed('a', 0, 1_200),
      envelope(
        {
          type: 'node.retryScheduled',
          runId: 'r',
          nodeId: 'a',
          attemptId: 'a#0',
          nextAttemptAt: 61_000,
        },
        1_200,
      ),
      envelope(
        { type: 'node.retryDue', runId: 'r', nodeId: 'a', previousAttemptId: 'a#0' },
        61_000,
      ),
      dispatched('a', 1, 61_010),
      succeeded('a', 1, 61_310),
    ];

    const row = rowFor(events, 'a');
    expect(row.spans).toEqual([
      {
        startedAtMs: 1_000,
        endedAtMs: 1_200,
        startedAs: 'dispatched',
        endedAs: 'failure',
        instanceId: undefined,
      },
      {
        startedAtMs: 61_010,
        endedAtMs: 61_310,
        startedAs: 'dispatched',
        endedAs: 'success',
        instanceId: undefined,
      },
    ]);
    // And the scalars still describe only the LATEST, unchanged by #1007.
    expect(row.startedAtMs).toBe(61_010);
    expect(row.endedAtMs).toBe(61_310);
    // The hold falls BETWEEN the two spans rather than inside either — which is
    // what makes it visible as a gap instead of being billed as runtime.
    expect(row.spans[1]!.startedAtMs - row.spans[0]!.endedAtMs!).toBe(59_810);
  });

  it('DISCARDS an open span that is dropped, because nothing was measured', () => {
    /* The boot reconciler's crash-recovery decision: the process died mid-flight,
       so `node.dispatched` has no terminal and `node.retryRequested` re-opens the
       node. That span has a start and will never have an end — retiring it into
       the history would draw a bar for an attempt whose length nobody knows. */
    const events = [
      dispatched('a', 0, 1_000),
      envelope(
        {
          type: 'node.retryRequested',
          runId: 'r',
          nodeId: 'a',
          previousAttemptId: 'a#0',
          reason: 'interrupted',
        },
        5_000,
      ),
      dispatched('a', 1, 5_010),
      succeeded('a', 1, 5_300),
    ];

    const row = rowFor(events, 'a');
    expect(row.spans).toEqual([
      {
        startedAtMs: 5_010,
        endedAtMs: 5_300,
        startedAs: 'dispatched',
        endedAs: 'success',
        instanceId: undefined,
      },
    ]);
  });

  it('records a PARK as its own span, saying which park it was', () => {
    // A `wait` node is never dispatched: `timer.waitScheduled` starts it and
    // `timer.due` is its success event. The span IS the park, and `startedAs`
    // is what lets a reader colour it as a hold rather than as execution.
    const events = [
      envelope(
        {
          type: 'timer.waitScheduled',
          runId: 'r',
          nodeId: 'w',
          attemptId: 'w#0',
          dueAt: 31_000,
        },
        1_000,
      ),
      envelope({ type: 'timer.due', runId: 'r', nodeId: 'w', previousAttemptId: 'w#0' }, 31_050),
    ];

    expect(rowFor(events, 'w').spans).toEqual([
      {
        startedAtMs: 1_000,
        endedAtMs: 31_050,
        startedAs: 'wait_pending',
        endedAs: 'success',
        instanceId: undefined,
      },
    ]);
  });

  it('leaves an in-flight span OPEN, claiming no length', () => {
    const row = rowFor([dispatched('a', 0, 9_000)], 'a');
    expect(row.spans).toEqual([
      {
        startedAtMs: 9_000,
        endedAtMs: undefined,
        startedAs: 'dispatched',
        endedAs: undefined,
        instanceId: undefined,
      },
    ]);
  });

  it('accumulates a span per ROUND of a sequential foreach, which are not attempts', () => {
    /* `reduce.ts` re-dispatches the bare node id each round, so these are three
       measured runs of one node with no failure anywhere. The array records what
       happened; it is the READER's job not to label entry n "attempt n". */
    const events = [
      dispatched('w', 0, 1_000),
      succeeded('w', 0, 1_100),
      dispatched('w', 1, 1_200),
      succeeded('w', 1, 1_300),
      dispatched('w', 2, 1_400),
      succeeded('w', 2, 1_500),
    ];
    expect(rowFor(events, 'w').spans.map((s) => [s.startedAtMs, s.endedAtMs])).toEqual([
      [1_000, 1_100],
      [1_200, 1_300],
      [1_400, 1_500],
    ]);
  });

  it('records NOTHING for a PARALLEL foreach, rather than a span across two items', () => {
    /* Two items run concurrently and fold onto one `w` row, so the array would
       have to hold two overlapping spans to be honest — and the fold tracks one.
       Subtracting `dispatched w@1` from `succeeded w@2` measures neither item, so
       the pair is dropped. This matches what the scalars already do (#867); it is
       pinned here because an array LOOKS like it could represent the overlap. */
    const events = [
      dispatched('w@1', 0, 1_000),
      dispatched('w@2', 0, 1_050),
      succeeded('w@1', 0, 1_400),
      succeeded('w@2', 0, 1_600),
    ];
    const row = rowFor(events, 'w');
    expect(row.spans).toEqual([]);
    expect(row.startedAtMs).toBeUndefined();
  });

  it('retires a CLOSED span when a mismatched terminal drops the open one — the second divergence', () => {
    /* The docblock's exception has TWO producers, and this is the one no test
       reached: `closeSpan`'s instance-mismatch arm calls the same `dropSpan` as
       `node.retryDue`. A foreach row that already holds one COMPLETED attempt,
       opens a second, and then receives a terminal from a THIRD item ends with
       the scalars retracted while the array still holds the completed one.

       Both halves matter. Popping the closed span too would delete an attempt
       that demonstrably ran; keeping the open one would draw a bar for an
       attempt whose end will never arrive and which measured nothing. */
    const events = [
      dispatched('w@1', 0, 1_000),
      succeeded('w@1', 0, 1_400),
      dispatched('w@2', 0, 2_000),
      succeeded('w@3', 0, 2_400),
    ];

    const row = rowFor(events, 'w');
    expect(row.spans).toEqual([
      {
        startedAtMs: 1_000,
        endedAtMs: 1_400,
        startedAs: 'dispatched',
        endedAs: 'success',
        instanceId: 'w@1',
      },
    ]);
    // …and the scalars say no span at all, which is the divergence itself.
    expect(row.startedAtMs).toBeUndefined();
    expect(row.endedAtMs).toBeUndefined();
  });

  it('records NO span for a node whose only event is its terminal', () => {
    // A `fail`/`filter` node, and a `call_pipeline` node until #796 appends
    // `call.started`. There is no start to pair, so there is no measurement —
    // and `0ms` would be a number nothing measured.
    const events = [
      failed('boom', 0, 2_000),
      envelope(
        {
          type: 'call.returned',
          runId: 'r',
          callNodeId: 'c',
          attemptId: 'c#0',
          childRunId: 'child',
          childOutcome: 'success',
          outputs: {},
        },
        3_000,
      ),
    ];
    expect(rowFor(events, 'boom').spans).toEqual([]);
    expect(rowFor(events, 'c').spans).toEqual([]);
  });
});

describe('deriveNodeActivity — per-node cost and tool calls (#866)', () => {
  const started: EngineEvent = {
    type: 'run.started',
    runId: 'r',
    pipelineVersionId: 'pv',
    params: {},
  };
  const dispatch = (nodeId: string, attemptId: string): EngineEvent => ({
    type: 'node.dispatched',
    runId: 'r',
    nodeId,
    attemptId,
    idempotent: true,
  });
  const metered = (nodeId: string, fields: Partial<EngineEvent> = {}): EngineEvent =>
    ({
      type: 'activity.metered',
      runId: 'r',
      nodeId,
      attemptId: `${nodeId}#0`,
      provider: 'anthropic_api',
      model: 'claude-opus-4-8',
      meteringStatus: 'metered',
      ...fields,
    }) as EngineEvent;
  const toolCall = (nodeId: string, fields: Partial<EngineEvent> = {}): EngineEvent =>
    ({
      type: 'activity.toolCalled',
      runId: 'r',
      nodeId,
      attemptId: `${nodeId}#0`,
      round: 0,
      toolName: 'read_file',
      argsChars: 12,
      resultChars: 340,
      isError: false,
      ...fields,
    }) as EngineEvent;
  const rowFor = (events: EngineEvent[], nodeId: string): NodeActivity => {
    const row = deriveNodeActivity(events.map((e) => envelope(e))).find((r) => r.nodeId === nodeId);
    if (row === undefined) throw new Error(`no row for ${nodeId}`);
    return row;
  };

  it('attributes a metered response to the node that billed it', () => {
    const row = rowFor(
      [
        started,
        dispatch('n1', 'n1#0'),
        metered('n1', { inputTokens: 100, outputTokens: 20, costEstimate: 0.0055 }),
        { type: 'node.succeeded', runId: 'r', nodeId: 'n1', attemptId: 'n1#0', outputs: {} },
      ],
      'n1',
    );
    expect(row.cost.responseCount).toBe(1);
    expect(row.cost.totalCostEstimate).toBeCloseTo(0.0055, 10);
    expect(row.cost.inputTokens).toBe(100);
    expect(row.cost.complete).toBe(true);
    expect(row.cost.models).toEqual(['claude-opus-4-8']);
  });

  it('does NOT spread one node’s cost across the others', () => {
    const rows = deriveNodeActivity(
      [
        started,
        dispatch('n1', 'n1#0'),
        dispatch('n2', 'n2#0'),
        metered('n1', { inputTokens: 5, outputTokens: 5, costEstimate: 0.25 }),
      ].map((e) => envelope(e)),
    );
    expect(rows.find((r) => r.nodeId === 'n1')?.cost.totalCostEstimate).toBeCloseTo(0.25, 10);
    expect(rows.find((r) => r.nodeId === 'n2')?.cost.totalCostEstimate).toBe(0);
    expect(rows.find((r) => r.nodeId === 'n2')?.cost.responseCount).toBe(0);
  });

  it('SUMS across a retry — the money was spent on each attempt', () => {
    const row = rowFor(
      [
        started,
        dispatch('n1', 'n1#0'),
        metered('n1', { attemptId: 'n1#0', inputTokens: 10, outputTokens: 1, costEstimate: 0.01 }),
        {
          type: 'node.failed',
          runId: 'r',
          nodeId: 'n1',
          attemptId: 'n1#0',
          error: 'throttled',
          kind: 'transient',
        },
        dispatch('n1', 'n1#1'),
        metered('n1', { attemptId: 'n1#1', inputTokens: 10, outputTokens: 1, costEstimate: 0.02 }),
        { type: 'node.succeeded', runId: 'r', nodeId: 'n1', attemptId: 'n1#1', outputs: {} },
      ],
      'n1',
    );
    // The re-open resets the node's RESULT (error/outputs), never its spend.
    expect(row.error).toBeUndefined();
    expect(row.cost.responseCount).toBe(2);
    expect(row.cost.totalCostEstimate).toBeCloseTo(0.03, 10);
  });

  it('folds a parallel foreach ITEM instance’s spend onto the canvas node, summed', () => {
    const row = rowFor(
      [
        started,
        dispatch('w@1', 'w@1#0'),
        dispatch('w@2', 'w@2#0'),
        metered('w@1', { inputTokens: 1, outputTokens: 1, costEstimate: 0.1 }),
        metered('w@2', { inputTokens: 1, outputTokens: 1, costEstimate: 0.2 }),
      ],
      'w',
    );
    expect(row.cost.responseCount).toBe(2);
    expect(row.cost.totalCostEstimate).toBeCloseTo(0.3, 10);
    // The panel must be able to SAY the sum spans instances, because the row's
    // own outputs are one instance's, not all of them.
    expect(row.costSpansInstances).toBe(true);
  });

  it('does not claim an instance span for an ordinary node', () => {
    const row = rowFor(
      [started, dispatch('n1', 'n1#0'), metered('n1', { costEstimate: 0.1 })],
      'n1',
    );
    expect(row.costSpansInstances).toBe(false);
  });

  it('records the token-REPORT count, so an agent_cli’s absent counts are not zeros', () => {
    const row = rowFor(
      [
        started,
        dispatch('a1', 'a1#0'),
        // `cliSpendFact` — provider `agent_cli`, unpriced, NO token counts at all.
        metered('a1', { provider: 'agent_cli', model: 'claude', meteringStatus: 'unpriced' }),
      ],
      'a1',
    );
    expect(row.cost.responseCount).toBe(1);
    expect(row.cost.inputTokens).toBe(0);
    expect(row.cost.inputReportedResponseCount).toBe(0);
    expect(row.cost.outputReportedResponseCount).toBe(0);
    expect(row.cost.providers).toEqual(['agent_cli']);
    // An unpriced subscription call is NOT a measurement gap.
    expect(row.cost.complete).toBe(true);
    expect(row.cost.unpricedResponseCount).toBe(1);
  });

  it('creates NO row for a metered event naming a node the fold never saw', () => {
    // Unreachable in production (`node.dispatched` precedes any activity event
    // and the stream replays uncapped), but the rule is the one the inert
    // `activity.*` group has always had: observability never invents a node.
    expect(deriveNodeActivity([envelope(metered('ghost', { costEstimate: 1 }))])).toEqual([]);
  });

  it('lists tool calls in log order with their round, attempt and instance', () => {
    const row = rowFor(
      [
        started,
        dispatch('n1', 'n1#0'),
        toolCall('n1', { round: 0, toolName: 'read_file' }),
        toolCall('n1', { round: 0, toolName: 'grep', isError: true, resultChars: 9 }),
        toolCall('n1', { round: 1, toolName: 'write_file', callId: 'toolu_1' }),
      ],
      'n1',
    );
    expect(row.toolCalls).toEqual([
      {
        round: 0,
        toolName: 'read_file',
        callId: undefined,
        isError: false,
        argsChars: 12,
        resultChars: 340,
        attempt: 1,
        instanceId: undefined,
      },
      {
        round: 0,
        toolName: 'grep',
        callId: undefined,
        isError: true,
        argsChars: 12,
        resultChars: 9,
        attempt: 1,
        instanceId: undefined,
      },
      {
        round: 1,
        toolName: 'write_file',
        callId: 'toolu_1',
        isError: false,
        argsChars: 12,
        resultChars: 340,
        attempt: 1,
        instanceId: undefined,
      },
    ]);
  });

  it('stamps the ATTEMPT, so a retry’s repeated round 0 is not ambiguous', () => {
    const row = rowFor(
      [
        started,
        dispatch('n1', 'n1#0'),
        toolCall('n1', { attemptId: 'n1#0', round: 0 }),
        {
          type: 'node.failed',
          runId: 'r',
          nodeId: 'n1',
          attemptId: 'n1#0',
          error: 'boom',
          kind: 'transient',
        },
        dispatch('n1', 'n1#1'),
        toolCall('n1', { attemptId: 'n1#1', round: 0 }),
      ],
      'n1',
    );
    expect(row.toolCalls.map((t) => t.attempt)).toEqual([1, 2]);
  });

  it('stamps the INSTANCE, so sibling foreach items’ colliding rounds are separable', () => {
    const row = rowFor(
      [
        started,
        dispatch('w@1', 'w@1#0'),
        dispatch('w@2', 'w@2#0'),
        toolCall('w@1', { round: 0 }),
        toolCall('w@2', { round: 0 }),
      ],
      'w',
    );
    expect(row.toolCalls.map((t) => t.instanceId)).toEqual(['w@1', 'w@2']);
  });

  it('counts a sibling foreach item’s attempt PER ITEM, not per row', () => {
    /* The row folds `w@1` and `w@2` together, so the row's `attempts` counts
       BOTH dispatches. Stamping that on a tool call says `w@2`'s first exchange
       happened on attempt 2 — it was that item's attempt ONE. The interleaving
       matters: dispatch/tool/dispatch/tool is what exposes it, because the two
       calls then read 1 and 2 and the panel grows an "Attempt" column to show a
       difference that is not there. */
    const row = rowFor(
      [
        started,
        dispatch('w@1', 'w@1#0'),
        toolCall('w@1', { round: 0 }),
        dispatch('w@2', 'w@2#0'),
        toolCall('w@2', { round: 0 }),
      ],
      'w',
    );
    expect(row.toolCalls.map((t) => t.attempt)).toEqual([1, 1]);
  });

  it('still counts a RETRY of one item as that item’s second attempt', () => {
    const row = rowFor(
      [
        started,
        dispatch('w@1', 'w@1#0'),
        toolCall('w@1', { attemptId: 'w@1#0', round: 0 }),
        {
          type: 'node.failed',
          runId: 'r',
          nodeId: 'w@1',
          attemptId: 'w@1#0',
          error: 'boom',
          kind: 'transient',
        },
        dispatch('w@1', 'w@1#1'),
        toolCall('w@1', { attemptId: 'w@1#1', round: 0 }),
      ],
      'w',
    );
    expect(row.toolCalls.map((t) => t.attempt)).toEqual([1, 2]);
  });

  it('creates NO row for a tool call naming a node the fold never saw', () => {
    expect(deriveNodeActivity([envelope(toolCall('ghost'))])).toEqual([]);
  });

  it('keeps a node with no LLM activity at an empty, complete cost and no tool calls', () => {
    const row = rowFor(
      [
        started,
        dispatch('h1', 'h1#0'),
        { type: 'node.succeeded', runId: 'r', nodeId: 'h1', attemptId: 'h1#0', outputs: {} },
      ],
      'h1',
    );
    expect(row.cost.responseCount).toBe(0);
    expect(row.cost.complete).toBe(true);
    expect(row.toolCalls).toEqual([]);
  });
});
