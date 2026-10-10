import type { Pipeline, PipelineSummary } from '@autonomy-studio/shared';
import {
  nextUrlSort,
  readUrlSort,
  urlSortParams,
  type UrlSort,
  type UrlSortSpec,
} from '../../lib/urlSort';

/**
 * #1569 OR37 — the pipelines grid's sort, kept in the URL (`?sort=&dir=`) so a
 * sorted list survives a reload and can be linked. The rules are `lib/urlSort`'s,
 * shared with the runs grid and a run's activity runs.
 */
export const PIPELINE_SORT_KEYS = [
  'name',
  'lastRun',
  'successRate',
  'runs',
  'duration',
  'nextRun',
  'triggers',
  'activities',
  'modified',
] as const;
export type PipelineSortKey = (typeof PIPELINE_SORT_KEYS)[number];
export type PipelineSort = UrlSort<PipelineSortKey>;

export const PIPELINE_SORT_PARAMS = { sort: 'sort', dir: 'dir' } as const;

const PIPELINE_URL_SORT: UrlSortSpec<PipelineSortKey> = {
  keys: PIPELINE_SORT_KEYS,
  /** The direction a column opens in: newest, soonest and most first; the
   * worst success rate first, since that is the one to look at. */
  natural: {
    name: 'asc',
    lastRun: 'desc',
    successRate: 'asc',
    runs: 'desc',
    duration: 'desc',
    nextRun: 'asc',
    triggers: 'desc',
    activities: 'desc',
    modified: 'desc',
  },
  defaultKey: 'name',
  params: PIPELINE_SORT_PARAMS,
};

export function readPipelineSort(params: URLSearchParams): PipelineSort {
  // Never null: the spec has a default key.
  return readUrlSort(PIPELINE_URL_SORT, params)!;
}

export function pipelineSortParams(sort: PipelineSort): Record<string, string> {
  return urlSortParams(PIPELINE_URL_SORT, sort);
}

export function nextPipelineSort(current: PipelineSort, clicked: PipelineSortKey): PipelineSort {
  return nextUrlSort(PIPELINE_URL_SORT, current, clicked)!;
}

/** A row's value under a key; `null` is "no value", which always sorts last. */
function valueOf(
  key: PipelineSortKey,
  p: Pipeline,
  s: PipelineSummary | undefined,
): string | number | null {
  switch (key) {
    case 'name':
      return p.name;
    case 'lastRun':
      return s?.lastRun?.startedAt ?? null;
    case 'successRate':
      return s?.window.successRate ?? null;
    case 'runs':
      // 0 is a count, not an absence: only an unread summary is no value.
      return s?.window.runs ?? null;
    case 'duration':
      // The median; nothing finished in the window is no value.
      return s?.window.p50Ms ?? null;
    case 'nextRun':
      return s?.nextFireAt ?? null;
    case 'triggers':
      return s === undefined || s.triggers.total === 0 ? null : s.triggers.enabled;
    case 'activities':
      return s?.activities ?? null;
    case 'modified':
      return s?.modifiedAt ?? p.updatedAt;
  }
}

const byName = (a: Pipeline, b: Pipeline) => a.name.localeCompare(b.name, 'en');

/**
 * The rows in the chosen order, as a NEW array — the list is the shared store's,
 * which the Factory resources pane reads too. Rows with no value (never run,
 * nothing scheduled, summaries not loaded yet) sit at the bottom in either
 * direction; ties fall back to the name.
 */
export function sortPipelines(
  pipelines: readonly Pipeline[],
  summaries: ReadonlyMap<string, PipelineSummary> | undefined,
  sort: PipelineSort,
): Pipeline[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...pipelines].sort((a, b) => {
    const va = valueOf(sort.key, a, summaries?.get(a.id));
    const vb = valueOf(sort.key, b, summaries?.get(b.id));
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1;
      return byName(a, b);
    }
    const c =
      typeof va === 'string' && typeof vb === 'string'
        ? va.localeCompare(vb, 'en')
        : (va as number) - (vb as number);
    return c !== 0 ? sign * c : byName(a, b);
  });
}
