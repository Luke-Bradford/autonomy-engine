import type { Run } from '@autonomy-studio/shared';

/**
 * RS6 — WHAT KIND of run a row is, the spec's Run-type column (T13): the axis
 * that says a run reused another run's work. A different question from
 * `runOriginOf`'s "who started this" — a rerun is `manual` there AND a rerun
 * here, and neither classification implies the other.
 *
 * TWO members where the spec lists three (Original / Rerun / Rerun-from-failed).
 * The simple "Rerun" (F11) is not built, and the only producer of `rerunOf` is
 * `run/reseed.ts`, the rerun-from-failed path — so a row with a source run IS a
 * rerun from failed today. A member that no row can carry would be a label for
 * nothing. When F11 lands it will stamp `rerunOf` too, and at that point this
 * column alone cannot separate the two: F11 must add a discriminator to the row
 * and a member here, not reuse `rerunOf` and let every simple rerun claim it
 * resumed from a failure.
 *
 * KNOWN LIMITATION, stated rather than papered over: `runs.rerun_of` is
 * `ON DELETE SET NULL`, so deleting a source run re-classifies its reruns as
 * `original`. The row genuinely stops carrying the fact, and this function will
 * not invent it back — the same position `runOriginOf` takes on a deleted
 * trigger.
 */
export const RUN_TYPES = ['original', 'rerun_from_failed'] as const;
export type RunType = (typeof RUN_TYPES)[number];

export function runTypeOf(run: Pick<Run, 'rerunOf'>): RunType {
  return run.rerunOf !== null ? 'rerun_from_failed' : 'original';
}

/** Exhaustive by construction — a new type fails typecheck here. */
export const RUN_TYPE_LABEL: Record<RunType, string> = {
  original: 'Original',
  rerun_from_failed: 'Rerun from failed',
};
