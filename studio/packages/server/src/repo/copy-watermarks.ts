import { and, eq } from 'drizzle-orm';
import { copyWatermarks } from '../db/schema.js';
import type { Db } from './types.js';

/**
 * #1600 OR41 C5a — the store behind a Copy's Watermark from Automatic
 * (catalogue §4.1: "studio stores the highest value the last successful run
 * copied, per activity"). Written by the executor the moment the copy's sink
 * commits, so the value moves exactly when the rows land, and read before the
 * next attempt is dispatched.
 */
export interface CopyWatermarkKey {
  readonly pipelineId: string;
  readonly nodeId: string;
  /** A hash of the resolved source, column and sink: `copyWatermarkKey`. */
  readonly copyKey: string;
}

/** A watermark as the source store compared it: its text, or a safe number. */
export type CopyWatermarkValue = string | number;

export function getCopyWatermark(
  db: Db,
  key: CopyWatermarkKey,
): { found: false } | { found: true; value: CopyWatermarkValue } {
  const row = db
    .select({ valueJson: copyWatermarks.valueJson })
    .from(copyWatermarks)
    .where(
      and(
        eq(copyWatermarks.pipelineId, key.pipelineId),
        eq(copyWatermarks.nodeId, key.nodeId),
        eq(copyWatermarks.copyKey, key.copyKey),
      ),
    )
    .get();
  if (row === undefined) return { found: false };
  const value: unknown = JSON.parse(row.valueJson);
  // Only this module writes the column; anything else is a corrupt row, and a
  // guessed value would copy the wrong rows.
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`copy_watermarks holds a ${typeof value} for ${key.pipelineId}/${key.nodeId}`);
  }
  return { found: true, value };
}

export function putCopyWatermark(
  db: Db,
  input: CopyWatermarkKey & {
    readonly column: string;
    readonly value: CopyWatermarkValue;
    readonly runId: string;
  },
): void {
  const now = Date.now();
  const set = {
    columnName: input.column,
    valueJson: JSON.stringify(input.value),
    runId: input.runId,
    updatedAt: now,
  };
  db.insert(copyWatermarks)
    .values({
      pipelineId: input.pipelineId,
      nodeId: input.nodeId,
      copyKey: input.copyKey,
      ...set,
    })
    .onConflictDoUpdate({
      target: [copyWatermarks.pipelineId, copyWatermarks.nodeId, copyWatermarks.copyKey],
      set,
    })
    .run();
}
