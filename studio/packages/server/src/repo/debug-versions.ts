import { and, asc, eq, inArray, lt, notExists } from 'drizzle-orm';
import { RunStatusSchema, TERMINAL_RUN_ROW_STATUS } from '@autonomy-studio/shared';
import { pipelineVersions, runs } from '../db/schema.js';
import { drainByBatches } from './retention.js';
import type { Db } from './types.js';

/**
 * #1395 OR4 — the ONE place that deletes pipeline versions, and only DEBUG ones
 * (the editor's unsaved draft, minted so a run could bind it). The DB trigger
 * from 0045 refuses the delete for any other row, so a bug here cannot reach a
 * saved version.
 *
 * Debug runs go with their version. That is a deliberate exception to "runs are
 * immutable audit history, never silently swept away" (`PipelineHasRunsError`):
 * the run references its version ON DELETE RESTRICT, so a version cannot be
 * retired while its runs remain, and the settled answer for debug runs
 * (2026-09-30) is that they are kept for a configurable window
 * (`DEBUG_RETENTION_DAYS`, default 7), not forever. Recorded in
 * `docs/settled-decisions.md`.
 *
 * What the delete leaves behind, all by existing FKs: a run's events,
 * diagnostics and external waits cascade with it; another run that pointed at
 * one of these as its parent or rerun source keeps its row with that link set to
 * `null`; a pending wakeup for a gone run is suppressed as `run_not_found` by the
 * alarm handler.
 */

const NON_TERMINAL_RUN_STATUSES = RunStatusSchema.options.filter(
  (status) => !TERMINAL_RUN_ROW_STATUS.has(status),
);

/**
 * Delete one debug version that has no runs — the debug route's own cleanup
 * when the run it minted the version for never started. Returns whether a row
 * went.
 */
export function deleteUnrunDebugVersion(db: Db, id: string): boolean {
  const result = db
    .delete(pipelineVersions)
    .where(
      and(
        eq(pipelineVersions.id, id),
        eq(pipelineVersions.debug, true),
        notExists(db.select({ id: runs.id }).from(runs).where(eq(runs.pipelineVersionId, id))),
      ),
    )
    .run();
  return result.changes > 0;
}

/**
 * Prune up to `limit` debug versions created before `before`, with their runs.
 *
 * A version with ANY run still in flight is skipped, whatever its age: deleting
 * a live run's rows would pull its log out from under the driver. It is taken by
 * a later sweep once that run settles.
 *
 * Age is the VERSION's `created_at`, so a rerun started late in the window goes
 * with its version at the window's end. Keying on the newest run instead would
 * let one rerun keep a debug version alive indefinitely.
 */
export function pruneDebugVersions(db: Db, opts: { before: number; limit: number }): number {
  return db.transaction((tx) => {
    const ids = tx
      .select({ id: pipelineVersions.id })
      .from(pipelineVersions)
      .where(
        and(
          eq(pipelineVersions.debug, true),
          lt(pipelineVersions.createdAt, opts.before),
          notExists(
            tx
              .select({ id: runs.id })
              .from(runs)
              .where(
                and(
                  eq(runs.pipelineVersionId, pipelineVersions.id),
                  inArray(runs.status, NON_TERMINAL_RUN_STATUSES),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(pipelineVersions.createdAt))
      .limit(opts.limit)
      .all()
      .map((r) => r.id);
    if (ids.length === 0) return 0;
    tx.delete(runs).where(inArray(runs.pipelineVersionId, ids)).run();
    tx.delete(pipelineVersions)
      .where(and(inArray(pipelineVersions.id, ids), eq(pipelineVersions.debug, true)))
      .run();
    return ids.length;
  });
}

/**
 * Versions per batch. Far below the shared `RETENTION_BATCH` rows because one
 * debug VERSION is not one row: it takes all its runs, and each run cascades its
 * whole event log. A batch of a thousand versions could be millions of rows in
 * one synchronous transaction, holding the single writer the whole time.
 */
export const DEBUG_VERSION_BATCH = 20;

/** Drain expired debug versions to a fixpoint in bounded batches (#464's discipline). */
export function drainDebugVersions(
  db: Db,
  opts: { before: number; batch?: number; maxBatches?: number },
): number {
  return drainByBatches((limit) => pruneDebugVersions(db, { before: opts.before, limit }), {
    batch: opts.batch ?? DEBUG_VERSION_BATCH,
    maxBatches: opts.maxBatches,
  });
}
