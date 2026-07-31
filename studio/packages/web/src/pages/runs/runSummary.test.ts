import { describe, expect, it } from 'vitest';
import type { EngineEvent, RunEvent } from '@autonomy-studio/shared';
import { deriveNodeActivity, deriveRunLifecycle, runStreamUrl } from './runSummary';

let seq = 0;
/** Wrap a typed EngineEvent in the durable envelope shape the log/stream carry
 * (the whole EngineEvent is stored as `payload`, per `run/events.ts`). */
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
      envelope({
        type: 'node.dispatched',
        runId: 'r',
        nodeId: 'a',
        attemptId: 'a#0',
        idempotent: true,
      }),
      envelope({ type: 'node.output', runId: 'r', nodeId: 'a', name: 'text', value: 'hi' }),
      envelope({ type: 'node.output', runId: 'r', nodeId: 'a', name: 'text', value: 'there' }),
      envelope({ type: 'node.succeeded', runId: 'r', nodeId: 'a', attemptId: 'a#0', outputs: {} }),
      envelope({
        type: 'node.dispatched',
        runId: 'r',
        nodeId: 'b',
        attemptId: 'b#0',
        idempotent: true,
      }),
      envelope({
        type: 'node.failed',
        runId: 'r',
        nodeId: 'b',
        attemptId: 'b#0',
        error: 'boom',
        kind: 'permanent',
      }),
    ];
    const activity = deriveNodeActivity(events);
    expect(activity).toEqual([
      {
        nodeId: 'a',
        status: 'success',
        attempts: 1,
        outputs: 2,
        lastOutputName: 'text',
        error: undefined,
      },
      {
        nodeId: 'b',
        status: 'failure',
        attempts: 1,
        outputs: 0,
        lastOutputName: undefined,
        error: 'boom',
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
    expect(a).toMatchObject({ nodeId: 'a', status: 'running', attempts: 2 });
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
  it('is null before any lifecycle event (caller falls back to the REST status)', () => {
    expect(deriveRunLifecycle([])).toBeNull();
  });
  it('tracks started → finished', () => {
    const events = [
      envelope({ type: 'run.started', runId: 'r', pipelineVersionId: 'pv', params: {} }),
    ];
    expect(deriveRunLifecycle(events)).toBe('running');
    events.push(envelope({ type: 'run.finished', runId: 'r', outcome: 'success' }));
    expect(deriveRunLifecycle(events)).toBe('success');
  });
  it('maps run.interrupted', () => {
    const events = [envelope({ type: 'run.interrupted', runId: 'r', reason: 'boot' })];
    expect(deriveRunLifecycle(events)).toBe('interrupted');
  });
  it('#5 S3 — a run.waiting tailing after run.started shows `waiting` (live park view)', () => {
    const events = [
      envelope({ type: 'run.started', runId: 'r', pipelineVersionId: 'pv', params: {} }),
      envelope({ type: 'run.waiting', runId: 'r', reason: 'waiting_external' }),
    ];
    expect(deriveRunLifecycle(events)).toBe('waiting');
  });
  it('#5 S3 — a run.resumed/started after a run.waiting returns the VIEW to running', () => {
    // The live-view reverse edge (the reducer defers the waiting→running producer
    // to S4/S6, but the monitor must un-park a run the moment it advances again).
    const events = [
      envelope({ type: 'run.started', runId: 'r', pipelineVersionId: 'pv', params: {} }),
      envelope({ type: 'run.waiting', runId: 'r', reason: 'waiting_timer' }),
      envelope({ type: 'run.resumed', runId: 'r', reason: 'boot_reconcile' }),
    ];
    expect(deriveRunLifecycle(events)).toBe('running');
  });
  it('a resume AFTER a terminal shows running again — the VIEW rule, not the log rule', () => {
    // This is the deliberate divergence from the server's `terminalFactFromLog`
    // (#443), which reads the last TERMINAL fact and must never let a resume erase
    // it. This is a live view: a resume tailing in means the run is going again.
    // Pinned so a later "unify these two" fire cannot silently break one of them.
    const events = [
      envelope({ type: 'run.started', runId: 'r', pipelineVersionId: 'pv', params: {} }),
      envelope({ type: 'run.finished', runId: 'r', outcome: 'success' }),
      envelope({ type: 'run.resumed', runId: 'r', reason: 'boot_reconcile' }),
    ];
    expect(deriveRunLifecycle(events)).toBe('running');
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

  it('a HELD node reads `retrying`, not the red `failure` its node.failed set', () => {
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
    expect(a!.status).toBe('retrying');
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
        nodeId: 'a',
        status: 'success',
        attempts: 2,
        outputs: 0,
        lastOutputName: undefined,
        error: undefined,
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
    expect(a!.status).toBe('running');
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
    expect(waiting!.status).toBe('waiting');
    expect(waiting!.attempts).toBe(1);

    const [done] = deriveNodeActivity([
      ...parked,
      envelope({ type: 'timer.due', runId: 'r', nodeId: 'w', previousAttemptId: 'w#0' }),
    ]);
    expect(done!.status).toBe('success');
  });

  it('a parked `webhook` node reads `waiting`, then succeeds on its callback', () => {
    const parked = [
      envelope({
        type: 'externalWait.created',
        runId: 'r',
        nodeId: 'h',
        attemptId: 'h#0',
        dueAt: 1_700_000_000_000,
      }),
    ];
    expect(deriveNodeActivity(parked)[0]!.status).toBe('waiting');

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
    const without = deriveNodeActivity(base.map(envelope));
    seq = 0;
    const withWarning = deriveNodeActivity([base[0]!, base[1]!, warned, base[2]!].map(envelope));
    expect(withWarning).toEqual(without);
  });

  it('does not alter the run lifecycle status', () => {
    const events = [
      envelope({ type: 'run.started', runId: 'r', pipelineVersionId: 'pv', params: {} }),
      envelope(warned),
    ];
    expect(deriveRunLifecycle(events)).toBe('running');
  });
});
