import {
  RUN_SINCE_WINDOWS,
  RUN_TRIGGERED_BY_KINDS,
  RunAnnotationFilterSchema,
  RunSearchSchema,
  RunSinceSchema,
  RunStatusSchema,
  RunTriggeredByKindListSchema,
  RUN_SORT_DEFAULT_KEY,
  RUN_SORT_NATURAL_DIR,
  RunSortKeySchema,
  type RunSort,
  type RunSortKey,
  type RunTriggeredByKind,
} from '@autonomy-studio/shared';
import type { RunSince, RunStatus } from '@autonomy-studio/shared';
import {
  isCalendarDay,
  shiftDay,
  zonedDayStart,
  type DisplayTimeZone,
} from '../../lib/displayTime';
import { canonicalHidden, type RunGridColumnId } from '../../stores/uiStore';
import { nextUrlSort, readUrlSort, urlSortParams, type UrlSortSpec } from '../../lib/urlSort';

/**
 * U26 + #1484 OR35 M1 — the runs list's filter bar state, and the URL it lives
 * in. Every axis is SERVER-SIDE: #1484 moved "what started the run" off the
 * client-side origin tabs and onto `?kind=`, judged by the same
 * `RUN_TRIGGERED_BY_SQL` that fills the Triggered by column, so a paged list no
 * longer filters only the rows it happens to have loaded.
 *
 * The URL is the single authority for every axis: a filtered view has to be
 * linkable, survive a reload, and be undoable with Back. There is deliberately
 * no `useState` mirror to disagree with it.
 *
 * Every axis expresses its default by the ABSENCE of its param, so there is one
 * canonical URL per view rather than `?status=&pipeline=` meaning the same thing
 * as no query at all. That is also why `kind` is held as the canonical joined
 * STRING rather than an array: it is one primitive the page's fetcher can be
 * memoised on, where an array would be a fresh identity on every URL change and
 * would make the paged list drop the pages it had loaded.
 *
 * A stale `?tab=` link from before #1484 is simply ignored: it lands on every
 * run, which is the unfiltered view the rule above prescribes for anything the
 * page does not recognise.
 */
export interface RunFilters {
  status?: RunStatus;
  pipelineId?: string;
  triggerId?: string;
  since?: RunSince;
  annotation?: string;
  /** #1484 — the canonical `?kind=` list (`RunTriggeredByKindListSchema`),
   * absent when no kind or every kind is picked. */
  kind?: string;
  /** #1484 — the search box, trimmed. */
  q?: string;
  /** #1484 — "On a day": one calendar day (`YYYY-MM-DD`, the viewer's). */
  on?: string;
  /** #1484 — "Between days": the first and last day, both inclusive. Either may
   * be absent (open-ended). Never set together with `on`. */
  from?: string;
  to?: string;
}

/** The URL param names, in one place — the page writes them and reads them. */
export const RUN_FILTER_PARAMS = {
  status: 'status',
  pipelineId: 'pipeline',
  triggerId: 'trigger',
  since: 'since',
  annotation: 'annotation',
  kind: 'kind',
  q: 'q',
  on: 'on',
  from: 'from',
  to: 'to',
} as const;

/**
 * Narrow an untrusted URL param to a status. The server REFUSES an
 * out-of-vocabulary `?status=` with a 400 — which is right for an API — but a
 * stale or hand-edited link must not land the operator on an error page, so the
 * page drops what it cannot recognise and shows the unfiltered view instead.
 * The same rule holds for every axis below.
 */
export function isRunStatus(value: unknown): value is RunStatus {
  return RunStatusSchema.safeParse(value).success;
}

/** As `isRunStatus`, for the time window. */
export function isRunSince(value: unknown): value is RunSince {
  return RunSinceSchema.safeParse(value).success;
}

export const RUN_SINCE_LABEL: Record<RunSince, string> = {
  '1h': 'Last hour',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};

/** The picker's option order — the shared vocabulary, never a second list. */
export const RUN_SINCE_OPTIONS = RUN_SINCE_WINDOWS;

/**
 * Read the filters out of the URL, dropping anything unrecognised. The opaque
 * ids (`pipeline`/`trigger`) can only be shape-checked here; an id the owner
 * does not have comes back as an empty list from the server, which the page
 * distinguishes from "no runs at all" in its empty state.
 */
export function readRunFilters(params: URLSearchParams): RunFilters {
  const status = params.get(RUN_FILTER_PARAMS.status);
  const since = params.get(RUN_FILTER_PARAMS.since);
  const pipelineId = params.get(RUN_FILTER_PARAMS.pipelineId);
  const triggerId = params.get(RUN_FILTER_PARAMS.triggerId);
  const annotation = RunAnnotationFilterSchema.safeParse(params.get(RUN_FILTER_PARAMS.annotation));
  const kind = canonicalKindParam(readKinds(params.get(RUN_FILTER_PARAMS.kind)));
  const q = RunSearchSchema.safeParse(params.get(RUN_FILTER_PARAMS.q));
  const days = readDays(
    params.get(RUN_FILTER_PARAMS.on),
    params.get(RUN_FILTER_PARAMS.from),
    params.get(RUN_FILTER_PARAMS.to),
  );
  return {
    ...(isRunStatus(status) ? { status } : {}),
    // A picked day range and a relative window would be two lower bounds the
    // control can show only one of; the days win, so what the Started picker
    // shows is exactly what was asked of the server.
    ...(isRunSince(since) && days === null ? { since } : {}),
    // An empty-string param is not a filter — it is what a `<select>` reset
    // writes if the caller forgets to delete the key, and sending it would be a
    // 400 from the server's `min(1)` shape check.
    ...(pipelineId ? { pipelineId } : {}),
    ...(triggerId ? { triggerId } : {}),
    // Kept only if the SERVER's own schema accepts it, so a link the page
    // honours can never be a 400 — the empty string included.
    ...(annotation.success ? { annotation: annotation.data } : {}),
    ...(kind === undefined ? {} : { kind }),
    ...(q.success ? { q: q.data } : {}),
    ...(days ?? {}),
  };
}

/** The kinds a `?kind=` value picks, in vocabulary order; `[]` for an absent or
 * unreadable one, which means "every kind". */
export function readKinds(raw: string | null | undefined): RunTriggeredByKind[] {
  if (raw === null || raw === undefined) return [];
  const parsed = RunTriggeredByKindListSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

/**
 * The ONE spelling of a kind selection, or `undefined` when it narrows nothing:
 * no kind picked, and every kind picked, are both the unfiltered list, so both
 * are the param's absence.
 */
export function canonicalKindParam(kinds: readonly string[]): string | undefined {
  const picked = RUN_TRIGGERED_BY_KINDS.filter((k) => kinds.includes(k));
  return picked.length === 0 || picked.length === RUN_TRIGGERED_BY_KINDS.length
    ? undefined
    : picked.join(',');
}

/**
 * The days a URL holds, or `null` when it holds none that makes sense. A valid
 * `on` wins over a range. Either end of a range may be missing (open-ended). A
 * reversed range is dropped whole rather than swapped: a link that says "from
 * Tuesday to Monday" is not one the page can guess the intent of.
 */
function readDays(
  on: string | null,
  from: string | null,
  to: string | null,
): { on: string } | { from?: string; to?: string } | null {
  if (on !== null && isCalendarDay(on)) return { on };
  const fromDay = from !== null && isCalendarDay(from) ? from : null;
  const toDay = to !== null && isCalendarDay(to) ? to : null;
  if (fromDay === null && toDay === null) return null;
  // Two valid `YYYY-MM-DD` days compare as strings in calendar order.
  if (fromDay !== null && toDay !== null && fromDay > toDay) return null;
  return {
    ...(fromDay === null ? {} : { from: fromDay }),
    ...(toDay === null ? {} : { to: toDay }),
  };
}

/**
 * Which kind of time bound the URL is ASKING for, from the params' PRESENCE
 * rather than their validity: a date input mid-edit (a half-typed year, or just
 * cleared) holds no valid day, and a picker that inferred its mode from valid
 * days would unmount the very input being typed into. An unusable day is still
 * dropped from the REQUEST by `readRunFilters`.
 */
export function startedModeOf(params: URLSearchParams, since: RunSince | undefined): string {
  if (params.has(RUN_FILTER_PARAMS.on)) return 'on';
  if (params.has(RUN_FILTER_PARAMS.from) || params.has(RUN_FILTER_PARAMS.to)) return 'range';
  return since ?? '';
}

/** Whether the URL holds ANY filter param, usable or not — so Clear is offered
 * for a filter that is set but currently narrows nothing (a reversed range). */
export function hasRunFilterParams(params: URLSearchParams): boolean {
  return Object.values(RUN_FILTER_PARAMS).some((param) => params.has(param));
}

/**
 * #1484 OR35 M1 — "Include child runs", ON unless the URL says `children=off`.
 * When on, the list asks the server for each page's `descendants` (the runs its
 * runs called, which carry no trigger of their own, so a trigger filter alone
 * drops them) and the grid draws each under the run that called it. A view
 * setting like `group`, not a filter: "Clear filters" keeps it, and it does not
 * make an empty list "filtered". List view only — the Timeline lays runs out by
 * time and does not nest, so it gets exactly the runs that matched.
 */
export const RUN_CHILDREN_PARAM = 'children';
/** `RUN_CHILDREN_PARAM`'s one value: child runs left out. */
export const RUN_CHILDREN_OFF = 'off';

/**
 * #1484 — the grid's column choice (`readRunGridHiddenParam`). The HIDDEN set,
 * as the viewer's stored choice is, so a column a later release adds shows on
 * an old link too; `none` spells the empty set, which a bare `hide=` cannot.
 */
export const RUN_GRID_HIDDEN_PARAM = 'hide';

/** `hide`'s spelling of "no column hidden". */
const RUN_GRID_HIDDEN_NONE = 'none';

/**
 * #1484 principle 5 — the hidden set a link carries in `hide`, or `undefined`
 * when it carries none (absent, empty, or no known column), so the viewer's
 * own stored choice applies. Read through the store's `canonicalHidden`, so a
 * link can never hide a required column or hold a set the picker could not.
 */
export function readRunGridHiddenParam(params: URLSearchParams): RunGridColumnId[] | undefined {
  const raw = params.get(RUN_GRID_HIDDEN_PARAM);
  if (raw === null || raw === '') return undefined;
  if (raw === RUN_GRID_HIDDEN_NONE) return [];
  const hidden = canonicalHidden(raw.split(','));
  return hidden.length === 0 ? undefined : hidden;
}

/** The `hide` value for a hidden set: `none` for the empty one. */
export function runGridHiddenParam(hidden: readonly RunGridColumnId[]): string {
  return hidden.length === 0 ? RUN_GRID_HIDDEN_NONE : canonicalHidden(hidden).join(',');
}

/**
 * Whether the URL names any of the list's state — a filter, the sort, the
 * children toggle or the columns — usable or not. A URL that names none is a
 * bare visit to the list, the one case `RunsPage` restores the viewer's
 * last-used query into; any other URL is a link that says what it wants, and
 * is honoured exactly. `view` and `group` are not list state here: a bare
 * Timeline visit is still bare.
 */
export function hasRunsListParams(params: URLSearchParams): boolean {
  return (
    hasRunFilterParams(params) ||
    Object.values(RUN_SORT_PARAMS).some((param) => params.has(param)) ||
    params.has(RUN_CHILDREN_PARAM) ||
    params.has(RUN_GRID_HIDDEN_PARAM)
  );
}

/**
 * #1484 principle 5 — the part of the list's URL remembered per viewer, as its
 * canonical query string ('' for none): the filters that describe a standing
 * view of the runs (status, pipeline, trigger, annotation, what started them,
 * the relative window), the sort, and the children toggle.
 *
 * Built from the PARSED values, never copied, so junk, an empty value and a
 * default never make a remembered query that restores to a lit Clear button.
 * Deliberately NOT remembered:
 * - `q` and the absolute days (`on`/`from`/`to`): a search or a day is a
 *   one-off question, and landing on last Tuesday's list a week later reads as
 *   a broken page rather than a remembered one;
 * - the columns: the viewer's stored choice (`runsGridHidden`) already is the
 *   remembered one (`RunsPage` mirrors it into a bare visit's URL), and a
 *   shared link's `hide` must not become it by being visited;
 * - `view` and `group`, which are not filters.
 */
export function rememberedRunsQuery(params: URLSearchParams): string {
  const filters = readRunFilters(params);
  const remembered = new URLSearchParams();
  const keep = (param: string, value: string | undefined) => {
    if (value !== undefined && value !== '') remembered.set(param, value);
  };
  keep(RUN_FILTER_PARAMS.status, filters.status);
  keep(RUN_FILTER_PARAMS.pipelineId, filters.pipelineId);
  keep(RUN_FILTER_PARAMS.triggerId, filters.triggerId);
  keep(RUN_FILTER_PARAMS.since, filters.since);
  keep(RUN_FILTER_PARAMS.annotation, filters.annotation);
  keep(RUN_FILTER_PARAMS.kind, filters.kind);
  for (const [param, value] of Object.entries(runSortParams(readRunSort(params)))) {
    keep(param, value);
  }
  if (params.get(RUN_CHILDREN_PARAM) === RUN_CHILDREN_OFF) {
    remembered.set(RUN_CHILDREN_PARAM, RUN_CHILDREN_OFF);
  }
  return remembered.toString();
}

/**
 * The epoch-ms bounds a day range asks the server for: `from` is the first
 * day's first instant (inclusive) and `to` the first instant of the day AFTER
 * the last (exclusive), so "On a day" covers the whole day whatever its length
 * — a daylight-saving day is 23 or 25 hours, which is why this steps by
 * calendar day rather than adding 24 hours.
 *
 * In the viewer's DISPLAY zone (#1484): a calendar day is the reader's, and it
 * must be the same day the Started column prints, or "On 4 October" would list
 * runs the grid dates the 3rd.
 */
export function dayRangeBounds(
  days: { on?: string; from?: string; to?: string },
  zone: DisplayTimeZone,
): {
  from?: string;
  to?: string;
} {
  const first = days.on ?? days.from;
  const lastDay = days.on ?? days.to;
  const start = first === undefined ? null : zonedDayStart(first, zone);
  const end = lastDay === undefined ? null : zonedDayStart(shiftDay(lastDay, 1), zone);
  return {
    ...(start === null ? {} : { from: String(start) }),
    ...(end === null ? {} : { to: String(end) }),
  };
}

/**
 * What an empty run list says. One string, because the Runs page and Home both
 * show it, and it names every way a run starts (#1395 added the editor's Run).
 */
export const NO_RUNS_YET =
  "No runs yet. Press Run in a pipeline's editor, or fire a trigger, to start one.";

/** Whether ANY axis is narrowing — the empty state needs to tell the operator
 * "nothing matches these filters" apart from "you have no runs". */
export function hasActiveRunFilters(filters: RunFilters): boolean {
  return Object.values(filters).some((value) => value !== undefined);
}

/**
 * #1484 OR35 M1 — the grid's sort, in the URL like the filters but NOT one of
 * them: it is not in `RUN_FILTER_PARAMS`, so a sort never lights Clear, Clear
 * keeps it, and an empty sorted list still reads as "no runs match these
 * filters" only when a filter is actually set.
 */
export const RUN_SORT_PARAMS = { sort: 'sort', dir: 'dir' } as const;

export type RunSortState = RunSort;

/** The runs grid's order in the URL (`lib/urlSort`). A junk key falls back to
 * the default and a junk or absent `dir` to the column's natural direction —
 * the server's own reading of the same params (`resolveRunSort`), so the header
 * and the rows agree. */
const RUN_URL_SORT: UrlSortSpec<RunSortKey> = {
  keys: RunSortKeySchema.options,
  natural: RUN_SORT_NATURAL_DIR,
  defaultKey: RUN_SORT_DEFAULT_KEY,
  params: RUN_SORT_PARAMS,
};

export function readRunSort(params: URLSearchParams): RunSortState {
  // Never null: the spec has a default key.
  return readUrlSort(RUN_URL_SORT, params)!;
}

export function runSortParams(sort: RunSortState): Record<string, string> {
  return urlSortParams(RUN_URL_SORT, sort);
}

export function nextRunSort(current: RunSortState, clicked: RunSortKey): RunSortState {
  return nextUrlSort(RUN_URL_SORT, current, clicked)!;
}

/** Whether the list is in its default order, newest first. */
export function isDefaultRunSort(sort: RunSortState): boolean {
  return (
    sort.key === RUN_SORT_DEFAULT_KEY && sort.dir === RUN_SORT_NATURAL_DIR[RUN_SORT_DEFAULT_KEY]
  );
}

/** #1484 OR35 M2 — the runs list filtered to one trigger's runs, under the
 * list's own `?trigger=` param. */
export function triggerRunsPath(triggerId: string): string {
  const query = new URLSearchParams({ [RUN_FILTER_PARAMS.triggerId]: triggerId });
  return `/monitor/runs?${query.toString()}`;
}
