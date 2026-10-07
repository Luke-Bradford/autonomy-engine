import { describe, expect, it } from 'vitest';
import type { Pipeline, PipelineSummary } from '@autonomy-studio/shared';
import {
  nextPipelineSort,
  pipelineSortParams,
  readPipelineSort,
  sortPipelines,
} from './pipelinesGridSort';

const pipe = (id: string, name: string) => ({ id, name }) as Pipeline;
const summary = (pipelineId: string, over: Partial<PipelineSummary> = {}) =>
  ({
    pipelineId,
    lastRun: null,
    window: {
      days: 7,
      runs: 0,
      succeeded: 0,
      failed: 0,
      successRate: null,
      p50Ms: null,
      p95Ms: null,
    },
    triggers: { total: 0, enabled: 0, items: [] },
    nextFireAt: null,
    activities: null,
    modifiedAt: 0,
    ...over,
  }) as PipelineSummary;

describe('pipelines grid sort (#1569 OR37)', () => {
  it('reads the URL, falling back on a junk key or direction', () => {
    expect(readPipelineSort(new URLSearchParams())).toEqual({ key: 'name', dir: 'asc' });
    expect(readPipelineSort(new URLSearchParams('sort=lastRun'))).toEqual({
      key: 'lastRun',
      dir: 'desc',
    });
    expect(readPipelineSort(new URLSearchParams('sort=bogus&dir=up'))).toEqual({
      key: 'name',
      dir: 'asc',
    });
  });

  it('writes nothing for the default order and no dir for a natural one', () => {
    expect(pipelineSortParams({ key: 'name', dir: 'asc' })).toEqual({ sort: '', dir: '' });
    expect(pipelineSortParams({ key: 'lastRun', dir: 'desc' })).toEqual({
      sort: 'lastRun',
      dir: '',
    });
    expect(pipelineSortParams({ key: 'lastRun', dir: 'asc' })).toEqual({
      sort: 'lastRun',
      dir: 'asc',
    });
    // Round trip.
    const back = new URLSearchParams(pipelineSortParams({ key: 'name', dir: 'desc' }));
    expect(readPipelineSort(back)).toEqual({ key: 'name', dir: 'desc' });
  });

  it('flips the sorted column; another opens in its natural direction', () => {
    expect(nextPipelineSort({ key: 'lastRun', dir: 'desc' }, 'lastRun')).toEqual({
      key: 'lastRun',
      dir: 'asc',
    });
    expect(nextPipelineSort({ key: 'name', dir: 'asc' }, 'successRate')).toEqual({
      key: 'successRate',
      dir: 'asc',
    });
  });

  it('sorts by last run, empties last in both directions, ties by name, without mutating', () => {
    const list = [pipe('a', 'Alpha'), pipe('b', 'Beta'), pipe('c', 'Gamma'), pipe('d', 'Delta')];
    const run = (startedAt: number) => ({
      runId: `r${String(startedAt)}`,
      status: 'success' as const,
      startedAt,
      finishedAt: startedAt + 1,
    });
    const summaries = new Map([
      ['a', summary('a', { lastRun: run(10) })],
      ['b', summary('b')],
      ['c', summary('c', { lastRun: run(30) })],
      ['d', summary('d', { lastRun: run(10) })],
    ]);
    const names = (key: 'lastRun', dir: 'asc' | 'desc') =>
      sortPipelines(list, summaries, { key, dir }).map((p) => p.name);
    expect(names('lastRun', 'desc')).toEqual(['Gamma', 'Alpha', 'Delta', 'Beta']);
    expect(names('lastRun', 'asc')).toEqual(['Alpha', 'Delta', 'Gamma', 'Beta']);
    expect(list.map((p) => p.name)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
  });

  it('puts every row in name order while summaries are unread', () => {
    const list = [pipe('b', 'Beta'), pipe('a', 'Alpha')];
    expect(
      sortPipelines(list, undefined, { key: 'successRate', dir: 'asc' }).map((p) => p.id),
    ).toEqual(['a', 'b']);
  });
});
