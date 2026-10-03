import type { RunSummary } from '@autonomy-studio/shared';

/**
 * U10 — WHERE a run came from, which is the axis the Monitor's list filters on.
 *
 * The spec fixes this tab set deliberately: **All / Triggered / Manual / Child**,
 * "backed by current data (NOT an invented pipeline-vs-trigger-runs split)".
 * Filtering by STATUS is a different ticket (U26's filter pane) and is not built
 * here — the status vocabulary this page renders is #870's `runStatus.ts`.
 *
 * Each tab is a fixed set of the server's `triggeredByKind` values
 * (`runOriginOf` below), so the server classifies and this file only groups.
 */
export const RUN_ORIGINS = ['triggered', 'manual', 'child'] as const;
export type RunOrigin = (typeof RUN_ORIGINS)[number];

/**
 * A TOTAL classification: every run is exactly one origin, so no row can be
 * hidden from all three tabs.
 *
 * #1484 OR35 M1 — read from the SERVER's `triggeredByKind`, the same field the
 * list's "Triggered by" column renders, so a tab and the column beside it cannot
 * disagree about a run. This used to re-derive origin here from `triggerId` and
 * `parentRunId`, and that read a deleted trigger's runs as `manual` because
 * `runs.trigger_id` is `onDelete: 'set null'`. The server classifies from the
 * row's frozen trigger context, which survives the deletion, so those runs stay
 * `triggered`. `RUN_TRIGGERED_BY_SQL` (server) owns the precedence.
 *
 * - `triggered` — a trigger fired it, including Fire now on a trigger's row.
 * - `manual` — the operator started it with no trigger: the editor's Run, its
 *   Debug, or a rerun from failed.
 * - `child` — an Execute Pipeline node spawned it.
 */
export function runOriginOf(run: Pick<RunSummary, 'triggeredByKind'>): RunOrigin {
  switch (run.triggeredByKind) {
    case 'call':
      return 'child';
    case 'editor':
    case 'debug':
    case 'rerun':
      return 'manual';
    case 'manual':
    case 'schedule':
    case 'tumbling':
    case 'webhook':
    case 'event':
      return 'triggered';
  }
}

/**
 * Exhaustive by construction — a new origin fails typecheck here rather than
 * rendering as a raw identifier, the same rule `runStatus.ts` holds for statuses.
 */
export const RUN_ORIGIN_LABEL: Record<RunOrigin, string> = {
  triggered: 'Triggered',
  manual: 'Manual',
  child: 'Child',
};

/** The tab axis: every origin, plus the unfiltered view. */
export const RUN_TABS = ['all', ...RUN_ORIGINS] as const;
export type RunTab = (typeof RUN_TABS)[number];

export const RUN_TAB_LABEL: Record<RunTab, string> = {
  all: 'All',
  ...RUN_ORIGIN_LABEL,
};

/**
 * What each tab actually contains, for the tab's `title`. The labels are the
 * spec's and stay as written, but two of them would mislead on their own:
 * firing a trigger by hand still stamps `triggerId` (`launcher.fire` → `launch`),
 * so "Manual" is NOT "the ones I started myself" — it is the runs with no
 * trigger at all: the editor's Run and Debug, and reruns.
 */
export const RUN_TAB_HINT: Record<RunTab, string> = {
  // Scoped to the ORIGIN axis on purpose. "Every run" stopped being true the
  // moment U26 added server-side status/pipeline/trigger/time filters above this
  // strip — under any of them `all` is every run of every origin WITHIN the
  // filter. Naming the axis keeps the hint true in both cases instead of making
  // it a claim about the whole list that the filters quietly falsify.
  // #1083 — and narrower again now the list is PAGED: this counts the runs
  // LOADED so far, not every run of that origin the workspace holds. The strip
  // renders an open-ended figure (`12+`) while older pages remain, so the hint
  // does not have to carry that caveat alone.
  all: 'Every run, whatever started it',
  triggered: 'Started by a trigger, including a manual fire of one',
  manual: 'Runs with no trigger — started from the editor, or reruns',
  // #1231 — the parenthetical was a live falsehood on the operator's own strip:
  // #796 landed the spawn seam on 2026-08-12 and this tab has been populated
  // since, as this module's own docblock already recorded. A hint that tells a
  // reader an empty tab is empty BY DESIGN is worse than none, because it stops
  // them looking for the reason it is actually empty.
  child: 'Runs spawned by a parent pipeline, which name their caller',
};

/**
 * The filter itself. `all` passes everything through; every other tab keeps the
 * runs of exactly its own origin.
 *
 * CLIENT-SIDE on purpose — U10 specifies a "client-side small-data v1", and
 * server-side filtering belongs to U26. The list already fetches every run in
 * one request, so filtering here costs one pass over an array and, unlike a
 * refetch, cannot make the tabs disagree with each other about a run that
 * changed status mid-session.
 */
export function filterRunsByTab<T extends Pick<RunSummary, 'triggeredByKind'>>(
  runs: readonly T[],
  tab: RunTab,
): T[] {
  return tab === 'all' ? [...runs] : runs.filter((run) => runOriginOf(run) === tab);
}

/**
 * Narrow an untrusted value — a URL search param, or Fluent's `TabValue`, which
 * is typed `unknown` — to a tab. Anything else is not a tab, and the caller
 * falls back to `all` rather than rendering a filter nobody selected.
 */
export function isRunTab(value: unknown): value is RunTab {
  return typeof value === 'string' && (RUN_TABS as readonly string[]).includes(value);
}

/**
 * What an empty run list says. One string, because the Runs page and Home both
 * show it, and it names every way a run starts (#1395 added the editor's Run).
 */
export const NO_RUNS_YET =
  "No runs yet. Press Run in a pipeline's editor, or fire a trigger, to start one.";
