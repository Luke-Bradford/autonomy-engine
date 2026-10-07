import type { ActivityRun, ActivityRunGroup } from '@autonomy-studio/shared';
import { describe, expect, it } from 'vitest';
import { activityRunEntries, activityRunOfNode } from './activityRunsTree';
import { activityRun } from '../../testing/activityRun';

const row = (key: string, extra: Partial<ActivityRun> = {}): ActivityRun =>
  activityRun({ key, nodeId: key, activityId: key, ...extra });
const inItem = (key: string, index: number): ActivityRun =>
  row(key, {
    activityId: 'w',
    containerId: 'fe',
    iteration: { containerId: 'fe', index, count: 2, item: null },
  });
const group = (extra: Partial<ActivityRunGroup> = {}): ActivityRunGroup => ({
  containerId: 'fe',
  kind: 'foreach',
  status: 'success',
  reason: null,
  skipReason: null,
  reused: false,
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  itemCount: 2,
  iterations: [0, 1].map((index) => ({
    index,
    count: 2,
    item: null,
    status: 'success' as const,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
  })),
  position: 1,
  ...extra,
});

const shape = (rows: ActivityRun[], groups: ActivityRunGroup[]) =>
  activityRunEntries(rows, groups).map((e) => [e.key, e.depth, e.parents.join(' ')]);

describe('#1484 M2 activityRunEntries', () => {
  it('puts a ForEach where it started, an item line per iteration, and its rows under each', () => {
    // The parallel items' rows interleave in the log; the table reads by item.
    const rows = [row('a'), inItem('w@1', 1), inItem('w@0', 0), row('z')];
    expect(shape(rows, [group()])).toEqual([
      ['a', 0, ''],
      ['group:fe', 0, ''],
      ['iter:fe:0', 1, 'group:fe'],
      ['w@0', 2, 'group:fe iter:fe:0'],
      ['iter:fe:1', 1, 'group:fe'],
      ['w@1', 2, 'group:fe iter:fe:1'],
      ['z', 0, ''],
    ]);
  });

  it('puts the rows of a group with no iterations directly under it', () => {
    const rows = [row('a', { containerId: 'stg' }), row('b', { containerId: 'stg' })];
    const stage = group({ containerId: 'stg', kind: 'stage', iterations: [], position: 0 });
    expect(shape(rows, [stage])).toEqual([
      ['group:stg', 0, ''],
      ['a', 1, 'group:stg'],
      ['b', 1, 'group:stg'],
    ]);
  });

  it('keeps a group with no rows, at its place, and one placed past the last row at the end', () => {
    const rows = [row('a'), row('b')];
    const skipped = group({ containerId: 'sk', iterations: [], position: 1 });
    const late = group({ containerId: 'late', iterations: [], position: 2 });
    expect(shape(rows, [late, skipped])).toEqual([
      ['a', 0, ''],
      ['group:sk', 0, ''],
      ['b', 0, ''],
      ['group:late', 0, ''],
    ]);
  });

  it('drops no row: one naming a container that is not a group stays in place', () => {
    expect(shape([row('a', { containerId: 'gone' })], [])).toEqual([['a', 0, '']]);
  });
});

describe('#1484 M2 activityRunOfNode — the activity run a graph node opens', () => {
  const failed = (key: string, index: number) => ({
    ...inItem(key, index),
    status: 'failure' as const,
  });

  it('a node that ended failed opens its last failed run, not a later item that succeeded', () => {
    const rows = [inItem('w#0', 0), failed('w#1', 1), inItem('w#2', 0), row('other')];
    expect(activityRunOfNode(rows, 'w', true)?.key).toBe('w#1');
  });

  it('a node that recovered opens its last run, not the attempt that failed', () => {
    const rows = [failed('w#0', 0), inItem('w#1', 0), row('other')];
    expect(activityRunOfNode(rows, 'w', false)?.key).toBe('w#1');
  });

  it('a failed node with no failed row still opens its last run', () => {
    expect(activityRunOfNode([inItem('w#0', 0), inItem('w#1', 1)], 'w', true)?.key).toBe('w#1');
  });

  it('a parallel item is found by its canvas node, not its instance key', () => {
    const rows = [{ ...inItem('w#3', 1), nodeId: 'w@1' }];
    expect(activityRunOfNode(rows, 'w', false)?.key).toBe('w#3');
  });

  it('a node with no run opens nothing', () => {
    expect(activityRunOfNode([row('other')], 'w', false)).toBeNull();
  });
});
