import { and, eq, max } from 'drizzle-orm';
import {
  lowerPipelineNodes,
  NewPipelineVersionSchema,
  PipelineVersionSchema,
  type NewPipelineVersion,
  type PipelineVersion,
} from '@autonomy-studio/shared';
import { pipelineVersions } from '../db/schema.js';
import { newId } from '../repo/ids.js';
import type { Db } from '../repo/types.js';

/**
 * #1480 — insert a pipeline version WITHOUT the save gate. The gate now refuses
 * an unknown activity `type` and a literal `config` its adapter would not parse,
 * but versions saved BEFORE it still exist and still reach the executor, the
 * reader and the export. A test of one of those paths builds the version here, as
 * a row written before the gate. Mirrors `createPipelineVersion`'s row (parse,
 * lower, number within the pipeline) minus `validatePipelineDoc`.
 */
export function insertLegacyVersion(db: Db, input: NewPipelineVersion): PipelineVersion {
  const parsed = NewPipelineVersionSchema.parse(input);
  const lowered = { ...parsed, nodes: lowerPipelineNodes(parsed.nodes) };
  const id = newId('pv');
  const maxRow = db
    .select({ maxVersion: max(pipelineVersions.version) })
    .from(pipelineVersions)
    .where(
      and(eq(pipelineVersions.pipelineId, lowered.pipelineId), eq(pipelineVersions.debug, false)),
    )
    .get();
  const row: PipelineVersion = {
    id,
    resourceId: newId('res'),
    ...lowered,
    version: (maxRow?.maxVersion ?? 0) + 1,
    createdAt: Date.now(),
    sourceCommit: null,
    sourceBranch: null,
    sourceFilePath: null,
    sourceBlobSha: null,
  };
  db.insert(pipelineVersions)
    .values({ ...row, globalReads: JSON.stringify([]), debug: false })
    .run();
  return PipelineVersionSchema.parse(row);
}
