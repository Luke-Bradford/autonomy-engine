import type { ActivityRun, ActivityRunGroup } from '@autonomy-studio/shared';
import { describe, expect, it } from 'vitest';
import { activityRunEntries } from './activityRunsTree';
import {
  ACTIVITY_RUNS_PARAMS,
  activityRunsViewParams,
  nextActivityRunSort,
  readActivityRunsView,
  viewEntries,
  type ActivityRunsView,
  type RowFacts,
} from './activityRunsView';
import { activityRun } from '../../testing/activityRun';

const ROW: ActivityRun = activityRun({
  key: 'a#0',
  attemptId: 'a#0',
  attempt: 1,
  startedAt: 1_000,
  finishedAt: 2_000,
  durationMs: 1_000,
});

const row = (key: string, over: Partial<ActivityRun> = {}): ActivityRun => ({
  ...ROW,
  key,
  nodeId: key,
  activityId: key,
  attemptId: `${key}#0`,
  ...over,
});

const NAMES: Record<string, string> = { a: 'Copy 1', b: 'Lookup 1', c: 'Copy 2', d: 'Wait 1' };
const TYPES: Record<string, string> = { a: 'Copy', b: 'Lookup', c: 'Copy', d: 'Wait' };
const facts = (r: ActivityRun): RowFacts => ({
  name: NAMES[r.activityId] ?? null,
  type: TYPES[r.activityId] ?? null,
  statusLabel: r.reused ? 'reused' : r.status,
  text: [NAMES[r.activityId], r.nodeId, r.error?.message].join(' ').toLowerCase(),
});

const NONE: ActivityRunsView = { status: null, type: null, q: null, sort: null };
const keys = (view: ActivityRunsView, rows: ActivityRun[], groups: ActivityRunGroup[] = []) =>
  viewEntries(activityRunEntries(rows, groups), view, facts, String).map((e) => e.key);

const GROUP: ActivityRunGroup = {
  containerId: 'fe',
  kind: 'foreach',
  status: 'failure',
  reason: null,
  skipReason: null,
  reused: false,
  startedAt: 1_000,
  finishedAt: 3_000,
  durationMs: 2_000,
  itemCount: 2,
  iterations: [
    {
      index: 0,
      count: 2,
      item: 'x.csv',
      status: 'success',
      startedAt: 1,
      finishedAt: 2,
      durationMs: 1,
    },
    {
      index: 1,
      count: 2,
      item: 'y.csv',
      status: 'failure',
      startedAt: 2,
      finishedAt: 3,
      durationMs: 1,
    },
  ],
  position: 1,
};

describe('#1484 M2 readActivityRunsView / activityRunsViewParams', () => {
  it('round-trips a view through the URL', () => {
    const view: ActivityRunsView = {
      status: 'failure',
      type: 'Copy',
      q: 'orders',
      sort: { key: 'duration', dir: 'asc' },
    };
    const params = new URLSearchParams(activityRunsViewParams(view));
    expect(readActivityRunsView(params)).toEqual(view);
  });

  it('drops a status, sort or direction it does not know, and an empty search', () => {
    const params = new URLSearchParams({
      [ACTIVITY_RUNS_PARAMS.status]: 'exploded',
      [ACTIVITY_RUNS_PARAMS.sort]: 'colour',
      [ACTIVITY_RUNS_PARAMS.q]: '   ',
    });
    expect(readActivityRunsView(params)).toEqual(NONE);
  });

  it('opens a sort in its natural direction when the URL names none', () => {
    const params = new URLSearchParams({ [ACTIVITY_RUNS_PARAMS.sort]: 'duration' });
    expect(readActivityRunsView(params).sort).toEqual({ key: 'duration', dir: 'desc' });
  });

  it('writes nothing for the plain view, so run order keeps a plain URL', () => {
    expect(Object.values(activityRunsViewParams(NONE)).every((v) => v === '')).toBe(true);
  });

  it('keeps "reused" as a status, beside the engine vocabulary', () => {
    const params = new URLSearchParams({ [ACTIVITY_RUNS_PARAMS.status]: 'reused' });
    expect(readActivityRunsView(params).status).toBe('reused');
  });
});

describe('#1484 M2 nextActivityRunSort', () => {
  it('opens in the natural direction, flips, then returns to run order', () => {
    const first = nextActivityRunSort(null, 'duration');
    expect(first).toEqual({ key: 'duration', dir: 'desc' });
    const second = nextActivityRunSort(first, 'duration');
    expect(second).toEqual({ key: 'duration', dir: 'asc' });
    expect(nextActivityRunSort(second, 'duration')).toBeNull();
    expect(nextActivityRunSort(second, 'activity')).toEqual({ key: 'activity', dir: 'asc' });
  });
});

describe('#1484 M2 viewEntries', () => {
  it('passes the tree through untouched when nothing is filtered', () => {
    const rows = [row('a'), row('b', { containerId: 'fe' })];
    const entries = activityRunEntries(rows, [{ ...GROUP, iterations: [] }]);
    expect(viewEntries(entries, NONE, facts, String)).toBe(entries);
  });

  it('keeps a matching row with the group and item it sits in, and drops the rest', () => {
    const rows = [
      row('a'),
      row('b', {
        containerId: 'fe',
        iteration: { containerId: 'fe', index: 0, count: 2, item: 'x.csv' },
      }),
      row('c', {
        containerId: 'fe',
        status: 'failure',
        iteration: { containerId: 'fe', index: 1, count: 2, item: 'y.csv' },
      }),
    ];
    expect(keys({ ...NONE, status: 'failure' }, rows, [GROUP])).toEqual([
      'group:fe',
      'iter:fe:1',
      'c',
    ]);
  });

  it('filters by type and by search text, case-blind', () => {
    const rows = [
      row('a'),
      row('b'),
      row('c', {
        error: { message: 'Database is LOCKED', kind: null, code: null, connectionId: null },
      }),
    ];
    expect(keys({ ...NONE, type: 'Copy' }, rows)).toEqual(['a', 'c']);
    expect(keys({ ...NONE, q: 'locked' }, rows)).toEqual(['c']);
    expect(keys({ ...NONE, type: 'Copy', q: 'copy 1' }, rows)).toEqual(['a']);
  });

  it('matches a status by its wording, so keys that read alike filter together', () => {
    const rows = [row('a', { status: 'pending' }), row('b', { status: 'ready' }), row('c')];
    const alike = (k: string) => (k === 'pending' || k === 'ready' ? 'not run' : k);
    const entries = activityRunEntries(rows, []);
    const byWording = (r: ActivityRun): RowFacts => ({ ...facts(r), statusLabel: alike(r.status) });
    expect(
      viewEntries(entries, { ...NONE, status: 'ready' }, byWording, alike).map((e) => e.key),
    ).toEqual(['a', 'b']);
  });

  it('tells a reused row from one that ran', () => {
    const rows = [row('a', { reused: true }), row('b')];
    expect(keys({ ...NONE, status: 'reused' }, rows)).toEqual(['a']);
    expect(keys({ ...NONE, status: 'success' }, rows)).toEqual(['b']);
  });

  it('sorts into one flat list, empty values last either way, ties in run order', () => {
    const rows = [
      row('a', { durationMs: 50 }),
      row('b', { durationMs: null, containerId: 'fe' }),
      row('c', { durationMs: 900 }),
      row('d', { durationMs: 50 }),
    ];
    const groups = [{ ...GROUP, iterations: [] }];
    const desc = viewEntries(
      activityRunEntries(rows, groups),
      { ...NONE, sort: { key: 'duration', dir: 'desc' } },
      facts,
      String,
    );
    expect(desc.map((e) => e.key)).toEqual(['c', 'a', 'd', 'b']);
    expect(desc.every((e) => e.kind === 'row' && e.depth === 0 && e.parents.length === 0)).toBe(
      true,
    );
    expect(keys({ ...NONE, sort: { key: 'duration', dir: 'asc' } }, rows, groups)).toEqual([
      'a',
      'd',
      'c',
      'b',
    ]);
  });

  it('sorts by name, falling back to the node id, and by bytes moved either way', () => {
    const rows = [
      row('c', { bytesRead: 10 }),
      row('a', { bytesWritten: 500 }),
      row('zz'),
      row('b', { bytesRead: 100, bytesWritten: 100 }),
    ];
    expect(keys({ ...NONE, sort: { key: 'activity', dir: 'asc' } }, rows)).toEqual([
      'a',
      'c',
      'b',
      'zz',
    ]);
    expect(keys({ ...NONE, sort: { key: 'bytes', dir: 'desc' } }, rows)).toEqual([
      'a',
      'b',
      'c',
      'zz',
    ]);
  });

  it('filters before it sorts', () => {
    const rows = [
      row('a', { durationMs: 1 }),
      row('b', { durationMs: 9 }),
      row('c', { durationMs: 5 }),
    ];
    expect(keys({ ...NONE, type: 'Copy', sort: { key: 'duration', dir: 'desc' } }, rows)).toEqual([
      'c',
      'a',
    ]);
  });
});
