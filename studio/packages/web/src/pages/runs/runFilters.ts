import {
  RUN_SINCE_WINDOWS,
  RUN_TRIGGERED_BY_KINDS,
  RunAnnotationFilterSchema,
  RunSearchSchema,
  RunSinceSchema,
  RunStatusSchema,
  RunTriggeredByKindListSchema,
  type RunTriggeredByKind,
} from '@autonomy-studio/shared';
import type { RunSince, RunStatus } from '@autonomy-studio/shared';
import { pad } from '../triggers/formFields';

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

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A `YYYY-MM-DD` that names a real calendar day, as a local `Date` at its
 * midnight; `null` for anything else. `2026-02-30` is refused rather than rolled
 * over into March, which is what `new Date(y, m, d)` alone would do. */
function localMidnight(day: string): Date | null {
  const m = DAY.exec(day);
  if (m === null) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  // `setFullYear`, not `new Date(y, mo, d)`: the constructor reads a year below
  // 100 as 19xx, and a year typed into a date input passes through `0002-…`.
  const date = new Date(2000, 0, 1);
  date.setFullYear(y, mo, d);
  return date.getFullYear() === y && date.getMonth() === mo && date.getDate() === d ? date : null;
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
  if (on !== null && localMidnight(on) !== null) return { on };
  const fromDay = from === null ? null : localMidnight(from);
  const toDay = to === null ? null : localMidnight(to);
  if (fromDay === null && toDay === null) return null;
  if (fromDay !== null && toDay !== null && fromDay > toDay) return null;
  return {
    ...(fromDay === null || from === null ? {} : { from }),
    ...(toDay === null || to === null ? {} : { to }),
  };
}

/**
 * The epoch-ms bounds a day range asks the server for: `from` is the first
 * day's local midnight (inclusive) and `to` the midnight AFTER the last day
 * (exclusive), so "On a day" covers the whole day whatever its length — a
 * daylight-saving day is 23 or 25 hours, which is why this steps by calendar
 * day rather than adding 24 hours.
 *
 * The VIEWER'S zone, for now: a calendar day is the reader's, not the server's.
 * When #1484's display-timezone setting lands it owns this boundary too.
 */
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

export function dayRangeBounds(days: { on?: string; from?: string; to?: string }): {
  from?: string;
  to?: string;
} {
  const first = days.on ?? days.from;
  const lastDay = days.on ?? days.to;
  const start = first === undefined ? null : localMidnight(first);
  const last = lastDay === undefined ? null : localMidnight(lastDay);
  const end =
    last === null ? null : new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
  return {
    ...(start === null ? {} : { from: String(start.getTime()) }),
    ...(end === null ? {} : { to: String(end.getTime()) }),
  };
}

/** A local `Date` as the `YYYY-MM-DD` a date input and the URL hold. */
export function dayOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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
