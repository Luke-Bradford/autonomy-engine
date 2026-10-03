import { RUN_FILTER_PARAMS } from '../runs/runFilters';

/**
 * #1476 OR28 — a link to Manage → Triggers. `pipelineId` filters the list to
 * the triggers bound to that pipeline's versions (the editor's Trigger ▾ → View
 * triggers), under the Runs list's own `?pipeline=` param, so the one name
 * means the same thing on both pages.
 */
export function triggersPath(pipelineId?: string): string {
  if (pipelineId === undefined) return '/manage/triggers';
  const query = new URLSearchParams({ [RUN_FILTER_PARAMS.pipelineId]: pipelineId });
  return `/manage/triggers?${query.toString()}`;
}
