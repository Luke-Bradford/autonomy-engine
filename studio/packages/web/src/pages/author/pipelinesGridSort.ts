import type { Pipeline, PipelineSummary } from '@autonomy-studio/shared';

/**
 * #1569 OR37 — the pipelines grid's sort, kept in the URL (`?sort=&dir=`) so a
 * sorted list survives a reload and can be linked. The same shape as the runs
 * grid's (`runFilters.ts`): a junk key falls back to the default, a junk or
 * absent `dir` to the column's natural direction, and the default writes no
 * params at all.
 */
export const PIPELINE_SORT_KEYS = [
  'name',
  'lastRun',
  'successRate',
  'nextRun',
  'triggers',
  'modified',
] as const;
export type PipelineSortKey = (typeof PIPELINE_SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';
export interface PipelineSort {
  key: PipelineSortKey;
  dir: SortDir;
}

export const PIPELINE_SORT_PARAMS = { sort: 'sort', dir: 'dir' } as const;
const DEFAULT_KEY: PipelineSortKey = 'name';

/** The direction a column opens in: newest, soonest and most first; the worst
 * success rate first, since that is the one to look at. */
const NATURAL_DIR: Record<PipelineSortKey, SortDir> = {
  name: 'asc',
  lastRun: 'desc',
  successRate: 'asc',
  nextRun: 'asc',
  triggers: 'desc',
  modified: 'desc',
};

function isSortKey(v: string | null): v is PipelineSortKey {
  return (PIPELINE_SORT_KEYS as readonly (string | null)[]).includes(v);
}

export function readPipelineSort(params: URLSearchParams): PipelineSort {
  const raw = params.get(PIPELINE_SORT_PARAMS.sort);
  const key = isSortKey(raw) ? raw : DEFAULT_KEY;
  const dir = params.get(PIPELINE_SORT_PARAMS.dir);
  return { key, dir: dir === 'asc' || dir === 'desc' ? dir : NATURAL_DIR[key] };
}

/** `''` deletes a param (`withParams`), so the default order keeps a plain URL. */
export function pipelineSortParams(sort: PipelineSort): Record<string, string> {
  const natural = sort.dir === NATURAL_DIR[sort.key];
  return {
    [PIPELINE_SORT_PARAMS.sort]: sort.key === DEFAULT_KEY && natural ? '' : sort.key,
    [PIPELINE_SORT_PARAMS.dir]: natural ? '' : sort.dir,
  };
}

/** A header click: the sorted column flips, any other opens in its natural direction. */
export function nextPipelineSort(current: PipelineSort, clicked: PipelineSortKey): PipelineSort {
  if (current.key === clicked) return { key: clicked, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key: clicked, dir: NATURAL_DIR[clicked] };
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
    case 'nextRun':
      return s?.nextFireAt ?? null;
    case 'triggers':
      return s === undefined || s.triggers.total === 0 ? null : s.triggers.enabled;
    case 'modified':
      return s?.modifiedAt ?? null;
  }
}

const byName = (a: Pipeline, b: Pipeline) => a.name.localeCompare(b.name, 'en');

/**
 * The rows in the chosen order, as a NEW array — the list is the shared store's,
 * which the Factory Resources pane reads too. Rows with no value (never run,
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
