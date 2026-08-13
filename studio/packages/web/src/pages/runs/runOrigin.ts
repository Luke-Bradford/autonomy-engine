import type { Run } from '@autonomy-studio/shared';

/**
 * U10 — WHERE a run came from, which is the axis the Monitor's list filters on.
 *
 * The spec fixes this tab set deliberately: **All / Triggered / Manual / Child**,
 * "backed by current data (NOT an invented pipeline-vs-trigger-runs split)".
 * Filtering by STATUS is a different ticket (U26's filter pane) and is not built
 * here — the status vocabulary this page renders is #870's `runStatus.ts`.
 *
 * The classification reads exactly two columns already on every `Run`, so it
 * needs no new server field and no new index.
 */
export const RUN_ORIGINS = ['triggered', 'manual', 'child'] as const;
export type RunOrigin = (typeof RUN_ORIGINS)[number];

/**
 * A TOTAL classification: every run is exactly one origin, so no row can be
 * hidden from all three tabs. `parentRunId` is checked FIRST and wins outright —
 * a child run's defining fact is that a parent spawned it, and that stays true
 * however it was bound.
 *
 * MEASURED reachability, because "backed by current data" is a claim about the
 * engine as it stands, not about the schema:
 *  - `triggered` — the ordinary path; a fired trigger stamps `triggerId`.
 *  - `manual` — a RERUN. `run/reseed.ts` sets `triggerId = null, parentRunId = null`
 *    deliberately ("a rerun is an explicit operator action"), so reruns are
 *    precisely the runs no trigger and no parent produced.
 *  - `child` — a run a `call_pipeline` node spawned. It carries rows since P3b
 *    slice 1 (#796) landed the spawn seam: `run/child.ts` creates the child with
 *    `parentRunId` set, against the CALLED pipeline's version. This docblock said
 *    the tab "carries no rows today" until #931 corrected it — the claim was true
 *    when written and quietly stopped being true, which is the failure mode a
 *    docblock that names its evidence is supposed to make visible.
 *
 * KNOWN LIMITATION, stated rather than papered over: `runs.trigger_id` is
 * `onDelete: 'set null'`, so deleting a trigger re-classifies its historical runs
 * from `triggered` to `manual`. The row genuinely stops carrying the fact, and
 * this function will not invent it back — the alternative (inferring from
 * `triggerContext`) would make two columns disagree about the same run.
 */
export function runOriginOf(run: Pick<Run, 'triggerId' | 'parentRunId'>): RunOrigin {
  if (run.parentRunId !== null) return 'child';
  if (run.triggerId !== null) return 'triggered';
  return 'manual';
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
 * trigger at all, which today means reruns. And "Child" is empty until P3b.
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
  manual: 'Runs with no trigger — today, reruns',
  child: 'Runs spawned by a parent pipeline (not yet produced — see #796)',
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
export function filterRunsByTab<T extends Pick<Run, 'triggerId' | 'parentRunId'>>(
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
