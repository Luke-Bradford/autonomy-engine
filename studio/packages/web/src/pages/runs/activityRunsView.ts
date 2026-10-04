import { z } from 'zod';
import {
  NodeRunStatusSchema,
  RunSearchSchema,
  type ActivityRun,
  type RunStatus,
} from '@autonomy-studio/shared';
import { nodeStatusLabel } from './nodeStatus';
import type { ActivityRunEntry } from './activityRunsTree';
import type { ACTIVITY_RUN_COLUMNS } from './activityRunsColumns';

/**
 * #1484 OR35 M2 — what the run page's activity-runs table is filtered and sorted
 * by, kept in the URL (principle 5: shareable, back-button safe). Prefixed, so a
 * later filter elsewhere on the run page cannot collide with these.
 */
export const ACTIVITY_RUNS_PARAMS = {
  status: 'arStatus',
  type: 'arType',
  q: 'arQ',
  sort: 'arSort',
  dir: 'arDir',
} as const;

/** A row's status as the filter knows it: the engine's, or `reused` for a row
 * a rerun carried over, which the table shows as its own pill. */
export const ActivityRunStatusKeySchema = z.union([NodeRunStatusSchema, z.literal('reused')]);
export type ActivityRunStatusKey = z.infer<typeof ActivityRunStatusKeySchema>;

export const REUSED_STATUS = 'reused' satisfies ActivityRunStatusKey;

export const statusKeyOf = (row: ActivityRun): ActivityRunStatusKey =>
  row.reused ? REUSED_STATUS : row.status;

/** A status key as the table's pill words it. Two keys can read alike (under a
 * cancel, `pending` and `ready` both say the node did not run), and the filter
 * goes by what the operator SEES, so it matches on this. */
export const statusKeyLabel = (key: ActivityRunStatusKey, runStatus: RunStatus): string =>
  key === REUSED_STATUS ? REUSED_STATUS : nodeStatusLabel(key, runStatus);

/** A status filter's value from a picker, or `null` for "All" or a value the
 * page does not know. */
export function parseStatusKey(value: string): ActivityRunStatusKey | null {
  const parsed = ActivityRunStatusKeySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const ActivityRunSortKeySchema = z.enum([
  'activity',
  'type',
  'status',
  'start',
  'end',
  'duration',
  'attempt',
  'rowsRead',
  'rowsWritten',
  'bytes',
]);
export type ActivityRunSortKey = z.infer<typeof ActivityRunSortKeySchema>;
const SortDirSchema = z.enum(['asc', 'desc']);
export interface ActivityRunSort {
  key: ActivityRunSortKey;
  dir: 'asc' | 'desc';
}

/** The direction a column opens in: names A–Z, times in the order they
 * happened, and the measures biggest first — "what took longest", "what
 * moved most". */
const NATURAL_DIR: Record<ActivityRunSortKey, 'asc' | 'desc'> = {
  activity: 'asc',
  type: 'asc',
  status: 'asc',
  start: 'asc',
  end: 'asc',
  duration: 'desc',
  attempt: 'desc',
  rowsRead: 'desc',
  rowsWritten: 'desc',
  bytes: 'desc',
};

/** The columns a header click sorts; the rest (Iteration, Branch, Child run,
 * Error) are not orders anyone asks for. */
export const ACTIVITY_RUN_SORT_COLUMNS: Partial<
  Record<(typeof ACTIVITY_RUN_COLUMNS)[number], ActivityRunSortKey>
> = {
  Activity: 'activity',
  Type: 'type',
  Status: 'status',
  Start: 'start',
  End: 'end',
  Duration: 'duration',
  Attempt: 'attempt',
  'Rows read': 'rowsRead',
  'Rows written': 'rowsWritten',
  Bytes: 'bytes',
};

export interface ActivityRunsView {
  status: ActivityRunStatusKey | null;
  /** A type as the table names it (`Copy`), so the filter offers what it shows. */
  type: string | null;
  /** Trimmed; matched case-blind. */
  q: string | null;
  /** `null` is RUN ORDER: the tree, as the log has it. */
  sort: ActivityRunSort | null;
}

/** The view the URL asks for. A value the page does not know is dropped rather
 * than guessed at, and an absent `dir` is the column's natural one. */
export function readActivityRunsView(params: URLSearchParams): ActivityRunsView {
  const status = ActivityRunStatusKeySchema.safeParse(params.get(ACTIVITY_RUNS_PARAMS.status));
  const type = params.get(ACTIVITY_RUNS_PARAMS.type);
  const q = RunSearchSchema.safeParse(params.get(ACTIVITY_RUNS_PARAMS.q) ?? '');
  const key = ActivityRunSortKeySchema.safeParse(params.get(ACTIVITY_RUNS_PARAMS.sort));
  const dir = SortDirSchema.safeParse(params.get(ACTIVITY_RUNS_PARAMS.dir));
  return {
    status: status.success ? status.data : null,
    type: type === null || type === '' ? null : type,
    q: q.success ? q.data : null,
    sort: key.success
      ? { key: key.data, dir: dir.success ? dir.data : NATURAL_DIR[key.data] }
      : null,
  };
}

/** The params a sort writes, `''` deleting one (`withParams`). No `dir` when it
 * is the column's natural one, so a plain sort keeps a plain URL. */
export function activityRunSortParams(sort: ActivityRunSort | null): Record<string, string> {
  return {
    [ACTIVITY_RUNS_PARAMS.sort]: sort?.key ?? '',
    [ACTIVITY_RUNS_PARAMS.dir]: sort === null || sort.dir === NATURAL_DIR[sort.key] ? '' : sort.dir,
  };
}

/** The params a whole view writes. A control writes only its OWN params
 * (`activityRunSortParams`, or one key), so two quick changes cannot undo each
 * other; this is for Clear and the round trip. */
export function activityRunsViewParams(view: ActivityRunsView): Record<string, string> {
  return {
    [ACTIVITY_RUNS_PARAMS.status]: view.status ?? '',
    [ACTIVITY_RUNS_PARAMS.type]: view.type ?? '',
    [ACTIVITY_RUNS_PARAMS.q]: view.q ?? '',
    ...activityRunSortParams(view.sort),
  };
}

/** Whether the view hides or reorders anything. */
export const isViewChanged = (view: ActivityRunsView): boolean =>
  view.status !== null || view.type !== null || view.q !== null || view.sort !== null;

/** A header click: another column opens in its natural direction, the sorted
 * one flips, and a second flip returns the table to run order. */
export function nextActivityRunSort(
  current: ActivityRunSort | null,
  clicked: ActivityRunSortKey,
): ActivityRunSort | null {
  if (current === null || current.key !== clicked)
    return { key: clicked, dir: NATURAL_DIR[clicked] };
  return current.dir === NATURAL_DIR[clicked]
    ? { key: clicked, dir: current.dir === 'asc' ? 'desc' : 'asc' }
    : null;
}

/** What the table shows of a row, for the filter and the sort to read. The
 * PAGE's words (names from the version that ran), never re-derived here. */
export interface RowFacts {
  name: string | null;
  type: string | null;
  /** `statusKeyLabel` of the row's key. */
  statusLabel: string;
  /** Everything a search may match, lowercased. */
  text: string;
}

type RowEntry = Extract<ActivityRunEntry, { kind: 'row' }>;

function sortValue(row: ActivityRun, f: RowFacts, key: ActivityRunSortKey): string | number | null {
  switch (key) {
    case 'activity':
      return f.name ?? row.nodeId;
    case 'type':
      return f.type;
    case 'status':
      return f.statusLabel;
    case 'start':
      return row.startedAt;
    case 'end':
      return row.finishedAt;
    case 'duration':
      return row.durationMs;
    case 'attempt':
      return row.attempt;
    case 'rowsRead':
      return row.rowsRead;
    case 'rowsWritten':
      return row.rowsWritten;
    case 'bytes':
      return row.bytesRead === null && row.bytesWritten === null
        ? null
        : (row.bytesRead ?? 0) + (row.bytesWritten ?? 0);
  }
}

/**
 * #1484 OR35 M2 — the table's lines under a view.
 *
 * Filters match ROWS. In run order the tree stays: a matching row keeps the
 * group and item lines it sits under, so it is never shown out of context, and
 * a group or item with no matching row goes. A container is not itself matched
 * — a ForEach line with nothing open under it would read as an empty loop.
 *
 * A sort is one FLAT list of the matching rows: "what took longest" is asked
 * across every item, not within each. Empty values sort last whichever way, and
 * ties keep run order, so a re-read does not shuffle equal rows.
 */
export function viewEntries(
  entries: readonly ActivityRunEntry[],
  view: ActivityRunsView,
  factsOf: (row: ActivityRun) => RowFacts,
  labelOf: (key: ActivityRunStatusKey) => string,
): readonly ActivityRunEntry[] {
  if (!isViewChanged(view)) return entries;
  const q = view.q?.toLowerCase() ?? null;
  const statusLabel = view.status === null ? null : labelOf(view.status);
  const facts = new Map<string, RowFacts>();
  const matches = (e: RowEntry): boolean => {
    const f = factsOf(e.row);
    facts.set(e.key, f);
    return (
      (statusLabel === null || f.statusLabel === statusLabel) &&
      (view.type === null || f.type === view.type) &&
      (q === null || f.text.includes(q))
    );
  };
  const rows = entries.filter((e): e is RowEntry => e.kind === 'row' && matches(e));

  const { sort } = view;
  if (sort === null) {
    const kept = new Set<string>();
    for (const e of rows) {
      kept.add(e.key);
      for (const p of e.parents) kept.add(p);
    }
    return entries.filter((e) => kept.has(e.key));
  }

  const sign = sort.dir === 'asc' ? 1 : -1;
  const valueOf = (e: RowEntry) => sortValue(e.row, facts.get(e.key)!, sort.key);
  return rows
    .map((e, i) => ({ e, i, v: valueOf(e) }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) return a.v === b.v ? a.i - b.i : a.v === null ? 1 : -1;
      const c =
        typeof a.v === 'number' && typeof b.v === 'number'
          ? a.v - b.v
          : String(a.v).localeCompare(String(b.v), undefined, { numeric: true });
      return c === 0 ? a.i - b.i : sign * c;
    })
    .map(({ e }): RowEntry => ({ ...e, depth: 0, parents: [] }));
}
