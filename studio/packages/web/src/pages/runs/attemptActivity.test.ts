import { describe, expect, it } from 'vitest';
import type { ActivityRun, EngineEvent, RunEvent } from '@autonomy-studio/shared';
import { activityOfRow, attemptEvents } from './attemptActivity';
import { deriveNodeActivity } from './runSummary';

let seq = 0;
function envelope(event: EngineEvent, ts = seq + 1000): RunEvent {
  return { id: `evt_${seq}`, runId: event.runId, seq: seq++, type: event.type, payload: event, ts };
}

const input = (text: string) => ({ text, chars: text.length });
const dispatched = (nodeId: string, attemptId: string, text: string, ts?: number) =>
  envelope(
    {
      type: 'node.dispatched',
      runId: 'r1',
      nodeId,
      attemptId,
      idempotent: true,
      input: input(text),
    },
    ts,
  );
const succeeded = (nodeId: string, attemptId: string, outputs: Record<string, unknown>) =>
  envelope({ type: 'node.succeeded', runId: 'r1', nodeId, attemptId, outputs });
const output = (nodeId: string, name: string, value: unknown) =>
  envelope({ type: 'node.output', runId: 'r1', nodeId, name, value });

function row(over: Partial<ActivityRun>): ActivityRun {
  return {
    key: over.attemptId ?? 'k',
    nodeId: 'c',
    activityId: 'c',
    containerId: null,
    attemptId: null,
    attempt: 1,
    status: 'success',
    reused: false,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    iteration: null,
    branch: null,
    rowsRead: null,
    rowsWritten: null,
    bytesRead: null,
    bytesWritten: null,
    childRunId: null,
    childRun: null,
    error: null,
    skipReason: null,
    ...over,
  };
}

/** A sequential ForEach over two files: one body node, two attempts. */
function twoItems(): RunEvent[] {
  return [
    dispatched('c', 'c#0', '{"file":"a.csv"}', 10),
    output('c', 'progress', 'batch a'),
    succeeded('c', 'c#0', { rows: 49 }),
    dispatched('c', 'c#1', '{"file":"b.csv"}', 20),
    output('c', 'progress', 'batch b'),
    succeeded('c', 'c#1', { rows: 43 }),
  ];
}

describe('attemptEvents (#1484 M2 drawer)', () => {
  it("keeps one attempt's events, and the node outputs streamed while it ran", () => {
    const log = twoItems();
    expect(attemptEvents(log, 'c#0').map((e) => e.seq)).toEqual([
      log[0]!.seq,
      log[1]!.seq,
      log[2]!.seq,
    ]);
    expect(attemptEvents(log, 'c#1').map((e) => e.seq)).toEqual([
      log[3]!.seq,
      log[4]!.seq,
      log[5]!.seq,
    ]);
  });

  it('keeps the timer that settles a parked attempt, which names it as the previous one', () => {
    const log = [
      envelope({
        type: 'timer.waitScheduled',
        runId: 'r1',
        nodeId: 'w',
        attemptId: 'w#0',
        dueAt: 5,
      }),
      envelope({ type: 'timer.due', runId: 'r1', nodeId: 'w', previousAttemptId: 'w#0' }),
    ];
    expect(attemptEvents(log, 'w#0')).toHaveLength(2);
  });
});

describe('activityOfRow (#1484 M2 drawer)', () => {
  it("reads each ForEach item's own input and outputs, not the latest item's", () => {
    const log = twoItems();
    const nodes = deriveNodeActivity(log);
    const first = activityOfRow(
      log,
      nodes,
      row({ attemptId: 'c#0', startedAt: 10, finishedAt: 15 }),
    );
    const second = activityOfRow(
      log,
      nodes,
      row({ attemptId: 'c#1', startedAt: 20, finishedAt: 29 }),
    );
    expect(first.input?.text).toBe('{"file":"a.csv"}');
    expect(first.outputValues).toEqual({ rows: 49 });
    expect(first.lastOutputName).toBe('progress');
    expect(first.outputs).toBe(1);
    expect(second.input?.text).toBe('{"file":"b.csv"}');
    expect(second.outputValues).toEqual({ rows: 43 });
    // The row's own times, not the fold's.
    expect([first.startedAtMs, first.endedAtMs]).toEqual([10, 15]);
  });

  it("keeps a retried attempt's input and error, though a retry re-opened the node after it", () => {
    const log = [
      dispatched('h', 'h#0', 'GET /flaky'),
      envelope({
        type: 'node.failed',
        runId: 'r1',
        nodeId: 'h',
        attemptId: 'h#0',
        error: 'HTTP 503',
        kind: 'transient',
      }),
      envelope({
        type: 'node.retryScheduled',
        runId: 'r1',
        nodeId: 'h',
        attemptId: 'h#0',
        nextAttemptAt: 9,
      }),
      envelope({ type: 'node.retryDue', runId: 'r1', nodeId: 'h', previousAttemptId: 'h#0' }),
      dispatched('h', 'h#1', 'GET /flaky again'),
      succeeded('h', 'h#1', { status: 200 }),
    ];
    const failed = activityOfRow(
      log,
      deriveNodeActivity(log),
      row({
        nodeId: 'h',
        activityId: 'h',
        attemptId: 'h#0',
        status: 'failure',
        startedAt: 1,
        finishedAt: 2,
        error: { message: 'HTTP 503', kind: 'transient', code: null, connectionId: null },
      }),
    );
    expect(failed.status).toBe('failure');
    expect(failed.input?.text).toBe('GET /flaky');
    expect(failed.error).toBe('HTTP 503');
    expect(failed.failureKind).toBe('transient');
    expect(failed.outputValues).toBeUndefined();
  });

  it("reads a parallel item's attempt under its instance key", () => {
    const log = [
      dispatched('c@0', 'c@0#0', 'a'),
      dispatched('c@1', 'c@1#0', 'b'),
      succeeded('c@1', 'c@1#0', { n: 2 }),
      succeeded('c@0', 'c@0#0', { n: 1 }),
    ];
    const got = activityOfRow(
      log,
      deriveNodeActivity(log),
      row({ nodeId: 'c@0', attemptId: 'c@0#0' }),
    );
    expect(got.nodeId).toBe('c');
    expect(got.input?.text).toBe('a');
    expect(got.outputValues).toEqual({ n: 1 });
  });

  it('settles an abandoned attempt the row says was skipped, so it does not count up', () => {
    const log = [dispatched('c', 'c#0', 'x', 10)];
    const got = activityOfRow(
      log,
      deriveNodeActivity(log),
      row({ attemptId: 'c#0', status: 'skipped', startedAt: 10, finishedAt: 40 }),
    );
    expect(got.status).toBe('skipped');
    expect(got.endedAtMs).toBe(40);
  });

  it('gives a skip with no attempt a blank skipped record', () => {
    const got = activityOfRow([], [], row({ status: 'skipped', attempt: null }));
    expect(got).toMatchObject({ nodeId: 'c', status: 'skipped', attempts: 0, input: undefined });
  });

  it('names the source run of a reused row the node fold has no record of', () => {
    const log = [
      envelope({
        type: 'run.reseeded',
        runId: 'r1',
        sourceRunId: 'r0',
        frontier: [],
        copiedOutputs: {},
        copiedContainers: {},
      }),
    ];
    const got = activityOfRow(log, [], row({ reused: true, attempt: null, status: 'success' }));
    expect(got).toMatchObject({ status: 'success', copiedFromRunId: 'r0' });
  });
});
