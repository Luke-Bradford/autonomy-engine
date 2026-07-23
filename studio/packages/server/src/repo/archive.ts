import type { Pipeline } from '@autonomy-studio/shared';
import { archivePipelineRow } from './pipelines.js';
import { listTriggersByPipeline, updateTrigger } from './triggers.js';
import type { Db } from './types.js';

/**
 * #3 G5a (Foundation Spec #3 reshape item ②) — the ARCHIVE service: soft-delete
 * a pipeline AND disable every trigger that depends on it, atomically.
 *
 * The reshape's item ② is "git-delete → archive (new column) → disable
 * dependent triggers": a deleted/archived pipeline whose concrete-bound triggers
 * KEPT FIRING would violate the very point of archive ("unbound never fires"
 * only null-checks the binding). Disabling the dependent triggers is the PRIMARY
 * stop; the launcher's dispatch-time archived guard (`run/launcher.ts`) is the
 * belt that closes the re-enable / new-binding gap.
 *
 * Atomic: the archive flag and the trigger disables land in ONE transaction, so
 * a crash can never leave a pipeline archived with a still-enabled trigger (or
 * vice versa). The scheduler resync is the CALLER's job AFTER the tx commits
 * (the alarm clock owns its own db — a caller tx cannot thread through it; the
 * route calls `fastify.scheduler.sync()`, the composite that drops the now-
 * disabled triggers' pending wakeups).
 *
 * Idempotent: archiving an already-archived pipeline re-writes `archived=true`
 * and re-disables any (already-disabled) dependent triggers — a no-op in effect,
 * a stable result in shape. Returns `null` for "no such pipeline" (distinct from
 * "archived nothing"), never conflated with a real archive.
 *
 * Only ENABLED dependent triggers are touched — an already-disabled trigger is
 * left exactly as it is (archive never re-enables, and never rewrites an
 * untouched row's `updatedAt`).
 */
export interface ArchivePipelineResult {
  pipeline: Pipeline;
  /** The triggers this archive flipped from enabled→disabled (already-disabled
   * dependents are NOT included — nothing changed for them). */
  disabledTriggerIds: string[];
}

export function archivePipeline(db: Db, pipelineId: string): ArchivePipelineResult | null {
  return db.transaction((tx) => {
    const pipeline = archivePipelineRow(tx, pipelineId);
    if (pipeline === null) return null;

    const disabledTriggerIds: string[] = [];
    for (const trigger of listTriggersByPipeline(tx, pipelineId)) {
      if (!trigger.enabled) continue;
      updateTrigger(tx, trigger.id, { enabled: false });
      disabledTriggerIds.push(trigger.id);
    }
    return { pipeline, disabledTriggerIds };
  });
}
