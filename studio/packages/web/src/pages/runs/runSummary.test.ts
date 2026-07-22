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
        attempts: 0,
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
