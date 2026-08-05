import { RUN_SINCE_WINDOWS, RunSinceSchema, RunStatusSchema } from '@autonomy-studio/shared';
import type { RunSince, RunStatus } from '@autonomy-studio/shared';

/**
 * U26 — the Monitor filter pane's state, and the URL it lives in.
 *
 * SERVER-SIDE, unlike U10's origin tab strip (`runOrigin.ts`), which stays a
 * client-side pass over the fetched list. That split is FORCED, not chosen:
 * `manual` means `triggerId` AND `parentRunId` are both null, and the repo's
 * `listRunsConditions` has no `isNull` arm to express it. So the two filters
 * have different authorities, and the consequence is worth stating plainly —
 * the tab COUNTS describe the server-filtered result set, not every run the
 * owner has. That is ordinary faceted-filter behaviour (a facet counts within
 * the current query), and it keeps `RunsPage`'s existing invariant intact: a tab
 * still never advertises a number of rows it then declines to show.
 *
 * The URL is the single authority for all four axes, exactly as `?tab=` already
 * is — a filtered view has to be linkable, survive a reload, and be undoable
 * with Back. There is deliberately no `useState` mirror to disagree with it.
 *
 * Every axis expresses its default by the ABSENCE of its param, so there is one
 * canonical URL per view rather than `?status=&pipeline=` meaning the same thing
 * as no query at all.
 */
export interface RunFilters {
  status?: RunStatus;
  pipelineId?: string;
  triggerId?: string;
  since?: RunSince;
}

/** The URL param names, in one place — the page writes them and reads them. */
export const RUN_FILTER_PARAMS = {
  status: 'status',
  pipelineId: 'pipeline',
  triggerId: 'trigger',
  since: 'since',
} as const;

/**
 * Narrow an untrusted URL param to a status. The server REFUSES an
 * out-of-vocabulary `?status=` with a 400 — which is right for an API — but a
 * stale or hand-edited link must not land the operator on an error page, so the
 * page drops what it cannot recognise and shows the unfiltered view instead.
 * Same rule and same reason as `isRunTab`.
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
  return {
    ...(isRunStatus(status) ? { status } : {}),
    ...(isRunSince(since) ? { since } : {}),
    // An empty-string param is not a filter — it is what a `<select>` reset
    // writes if the caller forgets to delete the key, and sending it would be a
    // 400 from the server's `min(1)` shape check.
    ...(pipelineId ? { pipelineId } : {}),
    ...(triggerId ? { triggerId } : {}),
  };
}

/** Whether ANY axis is narrowing — the empty state needs to tell the operator
 * "nothing matches these filters" apart from "you have no runs". */
export function hasActiveRunFilters(filters: RunFilters): boolean {
  return Object.values(filters).some((value) => value !== undefined);
}
