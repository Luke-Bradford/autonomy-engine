import { z } from 'zod';

/**
 * #1484 OR35 M2 — the run page's views below the activity runs, in the
 * ticket's order. The table is the primary view; these are its secondary tabs
 * (principle 2), so a run reads as its activity runs first.
 */
export const RunDetailTabSchema = z.enum(['gantt', 'graph', 'events', 'variables', 'cost']);
export type RunDetailTab = z.infer<typeof RunDetailTabSchema>;

/** The tab a run opens on: the first, the one the ticket lists first. */
export const DEFAULT_RUN_DETAIL_TAB: RunDetailTab = 'gantt';

/**
 * The tab lives in the URL (principle 5), so a link to a run's events opens on
 * its events and Back steps out of a tab. Prefixed like the activity runs'
 * params (`ACTIVITY_RUNS_PARAMS`), which share the run page's query string.
 */
export const RUN_DETAIL_TAB_PARAM = 'rdTab';

/** The tab `params` asks for; the default when it names none, or one that
 * does not exist (a stale or hand-edited link still opens the run). */
export function readRunDetailTab(params: URLSearchParams): RunDetailTab {
  const parsed = RunDetailTabSchema.safeParse(params.get(RUN_DETAIL_TAB_PARAM));
  return parsed.success ? parsed.data : DEFAULT_RUN_DETAIL_TAB;
}

/** The params choosing `tab` writes, `''` deleting it (`withParams`): the
 * default is not written, so a plain run link stays plain. */
export function runDetailTabParams(tab: RunDetailTab): Record<string, string> {
  return { [RUN_DETAIL_TAB_PARAM]: tab === DEFAULT_RUN_DETAIL_TAB ? '' : tab };
}
