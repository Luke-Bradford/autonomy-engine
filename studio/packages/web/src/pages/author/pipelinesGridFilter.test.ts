import { describe, expect, it } from 'vitest';
import type { Pipeline, PipelineSummary } from '@autonomy-studio/shared';
import type { LiveStateKey } from '../pipeline/editorState';
import {
  filterPipelines,
  filtersAwaitFacts,
  hasPipelineFilters,
  LAST_RUN_FILTERS,
  lastRunParam,
  liveFactsLoaded,
  NO_FOLDER,
  readPipelineFilters,
  type RowFacts,
} from './pipelinesGridFilter';

const pipe = (id: string, name: string, folder: string | null = null) =>
  ({ id, name, folder }) as Pipeline;
const summary = (over: Partial<PipelineSummary> = {}) =>
  ({
    pipelineId: 'x',
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
    description: '',
    annotations: [],
    ...over,
  }) as PipelineSummary;
const lastRun = (status: 'success' | 'failure') => ({
  runId: `r-${status}`,
  status,
  startedAt: 1,
  finishedAt: 2,
});

const read = (q: string) => readPipelineFilters(new URLSearchParams(q));
const ids = (rows: readonly Pipeline[]) => rows.map((p) => p.id);

describe('pipelines grid filters (#1569 OR37 slice 2)', () => {
  it('reads the URL, dropping values outside each vocabulary', () => {
    expect(read('')).toEqual({
      q: undefined,
      folder: undefined,
      last: [],
      triggers: undefined,
      live: undefined,
      archived: false,
    });
    expect(
      read('q=%20Orders%20&folder=etl&last=never,failure,bogus&triggers=active&live=behind'),
    ).toEqual({
      q: 'orders',
      folder: 'etl',
      last: ['failure', 'never'],
      triggers: 'active',
      live: 'behind',
      archived: false,
    });
    expect(read('triggers=some&live=green')).toMatchObject({
      triggers: undefined,
      live: undefined,
    });
  });

  it('ignores the fact filters in the archived view, which has no facts', () => {
    expect(read('archived=1&q=a&folder=f&last=failure&triggers=any&live=live')).toEqual({
      q: 'a',
      folder: 'f',
      last: [],
      triggers: undefined,
      live: undefined,
      archived: true,
    });
    // So Clear does not show for a filter that is not applied.
    expect(hasPipelineFilters(read('archived=1&last=failure'))).toBe(false);
    expect(hasPipelineFilters(read('archived=1'))).toBe(false);
    expect(hasPipelineFilters(read('q=x'))).toBe(true);
  });

  it('spells a last-run selection once, and writes nothing for none or all', () => {
    expect(lastRunParam(['never', 'failure'])).toBe('failure,never');
    expect(lastRunParam([])).toBe('');
    expect(lastRunParam([...LAST_RUN_FILTERS])).toBe('');
  });

  const rows = [pipe('a', 'Orders load', 'etl'), pipe('b', 'Cleanup'), pipe('c', 'Digest', 'ops')];
  const facts: Record<string, RowFacts> = {
    a: {
      summary: summary({
        lastRun: lastRun('success'),
        triggers: { total: 2, enabled: 1, items: [] },
        nextFireAt: 5,
        description: 'Loads the ORDERS feed',
      }),
      liveKeys: ['live'],
    },
    b: {
      summary: summary({ lastRun: lastRun('failure'), annotations: ['Finance'] }),
      liveKeys: ['live', 'behind'],
    },
    c: {
      summary: summary({ triggers: { total: 1, enabled: 0, items: [] } }),
      liveKeys: ['unpublished'],
    },
  };
  const filter = (q: string, of: (p: Pipeline) => RowFacts = (p) => facts[p.id]!) =>
    ids(filterPipelines(rows, of, read(q)));

  it('searches name, folder, description and annotations, ignoring case', () => {
    expect(filter('q=orders')).toEqual(['a']);
    expect(filter('q=feed')).toEqual(['a']);
    expect(filter('q=finance')).toEqual(['b']);
    expect(filter('q=OPS')).toEqual(['c']);
    expect(filter('q=nothing')).toEqual([]);
  });

  it('narrows by folder, with "/" for the pipelines in no folder', () => {
    expect(filter('folder=etl')).toEqual(['a']);
    expect(filter(`folder=${encodeURIComponent(NO_FOLDER)}`)).toEqual(['b']);
  });

  it('narrows by last run, never-run included', () => {
    expect(filter('last=failure')).toEqual(['b']);
    expect(filter('last=never')).toEqual(['c']);
    expect(filter('last=success,never')).toEqual(['a', 'c']);
  });

  it('narrows by triggers: any, active, scheduled', () => {
    expect(filter('triggers=any')).toEqual(['a', 'c']);
    expect(filter('triggers=active')).toEqual(['a']);
    expect(filter('triggers=scheduled')).toEqual(['a']);
  });

  it('narrows by live state, a row matching each key it carries', () => {
    expect(filter('live=live')).toEqual(['a', 'b']);
    expect(filter('live=behind')).toEqual(['b']);
    expect(filter('live=unpublished')).toEqual(['c']);
  });

  it('combines filters, and keeps the given order', () => {
    expect(filter('live=live&last=failure')).toEqual(['b']);
    expect(filter('')).toEqual(['a', 'b', 'c']);
  });

  it('never matches a fact filter on a row whose facts are unread', () => {
    const unread = (): RowFacts => ({ summary: undefined, liveKeys: undefined });
    expect(filter('last=never', unread)).toEqual([]);
    expect(filter('triggers=any', unread)).toEqual([]);
    expect(filter('live=saved', unread)).toEqual([]);
    // The name and folder are the row's own: they still filter.
    expect(filter('q=digest', unread)).toEqual(['c']);
  });

  it('says when a filter is waiting on facts that have not been read', () => {
    const loaded = { summaries: true, liveStates: true };
    expect(filtersAwaitFacts(read('last=failure'), { ...loaded, summaries: false })).toBe(true);
    expect(filtersAwaitFacts(read('triggers=any'), { ...loaded, summaries: false })).toBe(true);
    expect(filtersAwaitFacts(read('live=live'), { ...loaded, liveStates: false })).toBe(true);
    expect(filtersAwaitFacts(read('live=live'), { ...loaded, summaries: false })).toBe(false);
    expect(filtersAwaitFacts(read('q=x'), { summaries: false, liveStates: false })).toBe(false);
    expect(filtersAwaitFacts(read('last=failure'), loaded)).toBe(false);
  });

  it('judges the live-state facts loaded per key', () => {
    const at = (live: LiveStateKey, gitConnected: boolean | undefined, sync: unknown) =>
      liveFactsLoaded(live, { states: true, gitConnected, sync });
    expect(liveFactsLoaded('unsaved', { states: false, gitConnected: true, sync: {} })).toBe(false);
    expect(at('unsaved', undefined, undefined)).toBe(true);
    // Whether git is connected decides what every other key means.
    expect(at('saved', undefined, undefined)).toBe(false);
    expect(at('live', true, undefined)).toBe(true);
    // Drift needs the sync reading, in a git workspace only.
    expect(at('uncommitted', true, undefined)).toBe(false);
    expect(at('uncommitted', true, null)).toBe(false);
    expect(at('uncommitted', true, {})).toBe(true);
    expect(at('uncommitted', false, undefined)).toBe(true);
  });
});
