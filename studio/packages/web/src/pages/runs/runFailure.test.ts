import type { ActivityRun, RunState } from '@autonomy-studio/shared';
import { describe, expect, it } from 'vitest';
import { runFailure, runFinished, runStartedAt } from './runFailure';

const row = (over: Partial<ActivityRun>): ActivityRun => ({
  key: 'k',
  nodeId: 'a',
  activityId: 'a',
  attemptId: null,
  attempt: 1,
  status: 'failure',
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
  ...over,
});

const container = (reason?: string): RunState['containers'][string] => ({
  status: 'failure',
  round: 0,
  outputs: {},
  ...(reason === undefined ? {} : { reason }),
});

describe('runFailure (#1484 M2 — the failure banner reads the engine’s blame)', () => {
  it('names the blamed activity and its LAST failed attempt', () => {
    const rows = [
      row({ key: 'a1', attempt: 1 }),
      row({ key: 'b', nodeId: 'b', activityId: 'b' }),
      row({ key: 'a2', attempt: 2 }),
    ];
    const f = runFailure('node_failed:a', {}, rows);
    expect(f).toEqual({ kind: 'activity', nodeId: 'a', activityId: 'a', row: rows[2] });
  });

  it('follows a container’s child_failed blame down to the child, not to a later absorbed failure', () => {
    const rows = [
      row({ key: 'inner', nodeId: 'inner', activityId: 'inner' }),
      // A handled failure inside the same container, AFTER the blamed one.
      row({ key: 'handled', nodeId: 'handled', activityId: 'handled' }),
    ];
    const containers = {
      outer: container('child_failed:mid'),
      mid: container('child_failed:inner'),
    };
    const f = runFailure('node_failed:outer', containers, rows);
    expect(f.kind === 'activity' && f.row?.key).toBe('inner');
  });

  it('matches a parallel item’s exact instance before its canvas node', () => {
    const rows = [
      row({ key: 'w@1', nodeId: 'w@1', activityId: 'w' }),
      row({ key: 'w@0', nodeId: 'w@0', activityId: 'w' }),
    ];
    const f = runFailure('node_failed:fe', { fe: container('child_failed:w@1') }, rows);
    expect(f).toMatchObject({ kind: 'activity', nodeId: 'w@1', activityId: 'w' });
    expect(f.kind === 'activity' && f.row?.key).toBe('w@1');
  });

  it('says a container failed on its own (a timeout has no child to blame)', () => {
    expect(runFailure('node_failed:loop', { loop: container('timeout') }, [row({})])).toEqual({
      kind: 'container',
      containerId: 'loop',
      reason: 'timeout',
    });
  });

  it('without the projected state, names the blamed id and attaches no guessed child', () => {
    expect(runFailure('node_failed:outer', null, [row({})])).toEqual({
      kind: 'activity',
      nodeId: 'outer',
      activityId: 'outer',
      row: null,
    });
  });

  it('a run-level reason (stalled, capped) or none is the run’s, not an activity’s', () => {
    expect(runFailure('stalled', {}, [row({})])).toEqual({ kind: 'run', reason: 'stalled' });
    expect(runFailure(null, {}, [row({})])).toEqual({ kind: 'run', reason: null });
  });

  it('a cycle of child_failed reasons cannot spin', () => {
    const f = runFailure(
      'node_failed:x',
      { x: container('child_failed:y'), y: container('child_failed:x') },
      [],
    );
    expect(f.kind).toBe('activity');
  });
});

describe('runFinished', () => {
  it('reads the reason and time of the run.finished event, and null before one', () => {
    expect(runFinished([{ type: 'node.failed', payload: {}, ts: 1 }])).toBeNull();
    expect(
      runFinished([
        { type: 'node.failed', payload: {}, ts: 1 },
        { type: 'run.finished', payload: { outcome: 'failure', reason: 'node_failed:a' }, ts: 7 },
      ]),
    ).toEqual({ reason: 'node_failed:a', ts: 7 });
    expect(runFinished([{ type: 'run.finished', payload: { outcome: 'success' }, ts: 9 }])).toEqual(
      {
        reason: null,
        ts: 9,
      },
    );
  });
});

describe('runFinished — an interrupted run ended too', () => {
  it('takes the run.interrupted stamp, with no outcome reason', () => {
    expect(
      runFinished([{ type: 'run.interrupted', payload: { reason: 'lease_reclaim' }, ts: 5 }]),
    ).toEqual({
      reason: null,
      ts: 5,
    });
  });
});

describe('runStartedAt', () => {
  it('reads the last run.started stamp, and null without one', () => {
    expect(runStartedAt([])).toBeNull();
    expect(runStartedAt([{ type: 'run.started', payload: {} }])).toBeNull();
    expect(
      runStartedAt([
        { type: 'run.started', payload: { startedAt: '2026-10-04T12:00:00.000Z' } },
        { type: 'run.started', payload: { startedAt: '2026-10-04T12:00:05.250Z' } },
      ]),
    ).toBe(Date.UTC(2026, 9, 4, 12, 0, 5, 250));
  });
});
