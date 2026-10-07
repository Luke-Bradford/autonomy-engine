import { RunStatusSchema, type Pipeline, type PipelineSummary } from '@autonomy-studio/shared';
import { canonicalSetParam, readSetParam } from '../../lib/canonicalSetParam';
import { LIVE_STATE_KEYS, type LiveStateKey } from '../pipeline/editorState';

/**
 * #1569 OR37 slice 2 — the pipelines bar's filters, kept in the URL beside the
 * sort (`pipelinesGridSort`), so a filtered list survives a reload and can be
 * linked. Applied in the browser: the page already holds every live pipeline.
 */
export const PIPELINE_FILTER_PARAMS = {
  q: 'q',
  folder: 'folder',
  last: 'last',
  triggers: 'triggers',
  live: 'live',
  archived: 'archived',
} as const;

/** Folders do not nest and a name cannot hold `/`, so `/` is "no folder". */
export const NO_FOLDER = '/';

/** "Last run": each run status, plus a pipeline that has never run. */
export const LAST_RUN_FILTERS = [...RunStatusSchema.options, 'never'] as const;
export type LastRunFilter = (typeof LAST_RUN_FILTERS)[number];

export const TRIGGERS_FILTERS = ['any', 'active', 'scheduled'] as const;
export type TriggersFilter = (typeof TRIGGERS_FILTERS)[number];
export const TRIGGERS_FILTER_LABELS: Record<TriggersFilter, string> = {
  any: 'Has triggers',
  active: 'Has active triggers',
  scheduled: 'Scheduled',
};

export interface PipelineFilters {
  /** Lower-cased, trimmed; `undefined` searches nothing. */
  q: string | undefined;
  /** A folder name, or `NO_FOLDER`. */
  folder: string | undefined;
  /** `[]` is every status. */
  last: LastRunFilter[];
  triggers: TriggersFilter | undefined;
  live: LiveStateKey | undefined;
  /** The archived set instead of the live one. */
  archived: boolean;
}

function oneOf<V extends string>(vocabulary: readonly V[], raw: string | null): V | undefined {
  return (vocabulary as readonly (string | null)[]).includes(raw) ? (raw as V) : undefined;
}

/**
 * The filters a URL asks for. A value outside its vocabulary is dropped. In the
 * archived view the run, trigger and live-state filters are ignored: archived
 * pipelines have none of those facts, so a filter on them could only empty
 * the list.
 */
export function readPipelineFilters(params: URLSearchParams): PipelineFilters {
  const archived = params.get(PIPELINE_FILTER_PARAMS.archived) === '1';
  const q = params.get(PIPELINE_FILTER_PARAMS.q)?.trim().toLowerCase();
  const folder = params.get(PIPELINE_FILTER_PARAMS.folder);
  return {
    q: q === undefined || q === '' ? undefined : q,
    folder: folder === null || folder === '' ? undefined : folder,
    last: archived ? [] : readSetParam(LAST_RUN_FILTERS, params.get(PIPELINE_FILTER_PARAMS.last)),
    triggers: archived
      ? undefined
      : oneOf(TRIGGERS_FILTERS, params.get(PIPELINE_FILTER_PARAMS.triggers)),
    live: archived ? undefined : oneOf(LIVE_STATE_KEYS, params.get(PIPELINE_FILTER_PARAMS.live)),
    archived,
  };
}

/** The `last` param for a selection (`''` deletes it, `withParams`). */
export function lastRunParam(picked: readonly string[]): string {
  // Every status AND "never" is the whole list, so it writes nothing.
  return canonicalSetParam(LAST_RUN_FILTERS, picked) ?? '';
}

/** Does anything narrow the list? (The view toggle and the sort do not.) */
export function hasPipelineFilters(f: PipelineFilters): boolean {
  return (
    f.q !== undefined ||
    f.folder !== undefined ||
    f.last.length > 0 ||
    f.triggers !== undefined ||
    f.live !== undefined
  );
}

/** The params Clear removes: every filter, but not the view or the sort. */
export const CLEARED_PIPELINE_FILTERS: Record<string, string> = {
  [PIPELINE_FILTER_PARAMS.q]: '',
  [PIPELINE_FILTER_PARAMS.folder]: '',
  [PIPELINE_FILTER_PARAMS.last]: '',
  [PIPELINE_FILTER_PARAMS.triggers]: '',
  [PIPELINE_FILTER_PARAMS.live]: '',
};

/**
 * What a row's facts are, for filtering. Each is `undefined` when its source has
 * not been read (or failed): a row is never shown as matching a fact nobody
 * has, and the page says those filters are waiting rather than "no match".
 */
export interface RowFacts {
  summary: PipelineSummary | undefined;
  liveKeys: readonly LiveStateKey[] | undefined;
}

/** Is a filter set waiting on a fact source that has not answered? */
export function filtersAwaitFacts(
  f: PipelineFilters,
  loaded: { summaries: boolean; liveStates: boolean },
): boolean {
  const needSummaries = f.last.length > 0 || f.triggers !== undefined;
  return (needSummaries && !loaded.summaries) || (f.live !== undefined && !loaded.liveStates);
}

/**
 * Has everything a Live state filter reads answered? The row states always;
 * whether a repo is connected for every key the git mode changes; and, for
 * Uncommitted in a git workspace, the sync reading (`null` is a failed fetch,
 * which says nothing about drift).
 */
export function liveFactsLoaded(
  live: LiveStateKey,
  read: { states: boolean; gitConnected: boolean | undefined; sync: unknown },
): boolean {
  if (!read.states) return false;
  if (live === 'unsaved') return true;
  if (read.gitConnected === undefined) return false;
  if (live === 'uncommitted') return read.gitConnected === false || read.sync != null;
  return true;
}

function matchesSearch(p: Pipeline, s: PipelineSummary | undefined, q: string): boolean {
  const fields = [p.name, p.folder ?? '', s?.description ?? '', ...(s?.annotations ?? [])];
  return fields.some((field) => field.toLowerCase().includes(q));
}

function matchesTriggers(s: PipelineSummary, t: TriggersFilter): boolean {
  switch (t) {
    case 'any':
      return s.triggers.total > 0;
    case 'active':
      return s.triggers.enabled > 0;
    case 'scheduled':
      return s.nextFireAt !== null;
  }
}

/** The rows the filters keep, in the order given. */
export function filterPipelines(
  pipelines: readonly Pipeline[],
  facts: (p: Pipeline) => RowFacts,
  f: PipelineFilters,
): Pipeline[] {
  if (!hasPipelineFilters(f)) return [...pipelines];
  return pipelines.filter((p) => {
    if (f.folder !== undefined && (p.folder ?? NO_FOLDER) !== f.folder) return false;
    const { summary, liveKeys } = facts(p);
    if (f.q !== undefined && !matchesSearch(p, summary, f.q)) return false;
    if (f.last.length > 0) {
      if (summary === undefined) return false;
      const last: LastRunFilter = summary.lastRun === null ? 'never' : summary.lastRun.status;
      if (!f.last.includes(last)) return false;
    }
    if (f.triggers !== undefined && (summary === undefined || !matchesTriggers(summary, f.triggers)))
      return false;
    if (f.live !== undefined && (liveKeys === undefined || !liveKeys.includes(f.live))) return false;
    return true;
  });
}
