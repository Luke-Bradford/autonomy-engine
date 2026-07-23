import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION, type NewPipelineVersion, type NewTrigger } from '@autonomy-studio/shared';
import { archivePipeline } from '../archive.js';
import {
  archivePipelineRow,
  createPipeline,
  getPipeline,
  listPipelinesPage,
} from '../pipelines.js';
import { createPipelineVersion, getPipelineVersion } from '../pipeline-versions.js';
import { createTrigger, getTrigger, listTriggersByPipeline, updateTrigger } from '../triggers.js';
import { createRun, getRun } from '../runs.js';
import { freshDb } from './helpers.js';

const newPipeline = { ownerId: 'local', name: 'My pipeline' };

function buildVersionInput(pipelineId: string): NewPipelineVersion {
  return {
    pipelineId,
    params: [],
    outputs: [],
    nodes: [],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  };
}

function buildTriggerInput(pipelineVersionId: string): NewTrigger {
  return {
    ownerId: 'local',
    name: 'Nightly',
    pipelineVersionId,
    params: {},
    mode: 'schedule',
    schedule: '0 2 * * *',
    webhook: null,
    concurrency: { policy: 'skip_if_running' },
    runWindows: null,
    enabled: true,
  };
}

describe('#3 G5a — archived pipeline state', () => {
  describe('createPipeline / archivePipelineRow / list filtering', () => {
    it('a freshly created pipeline is un-archived', () => {
      const { db } = freshDb();
      expect(createPipeline(db, newPipeline).archived).toBe(false);
    });

    it('archivePipelineRow flips the flag and bumps updatedAt; returns null for a missing id', () => {
      const { db } = freshDb();
      const created = createPipeline(db, newPipeline);
      const archived = archivePipelineRow(db, created.id);
      expect(archived!.archived).toBe(true);
      expect(archived!.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
      expect(archivePipelineRow(db, 'pipe_missing')).toBeNull();
    });

    it('archived pipelines drop off the default paginated list but stay reachable by id', () => {
      const { db } = freshDb();
      const kept = createPipeline(db, { ...newPipeline, name: 'Kept' });
      const gone = createPipeline(db, { ...newPipeline, name: 'Gone' });
      archivePipelineRow(db, gone.id);

      const page = listPipelinesPage(db, 'local', { limit: 10 });
      expect(page.items.map((p) => p.id)).toEqual([kept.id]);
      // Still reachable by id (manage/restore surface).
      expect(getPipeline(db, gone.id)!.archived).toBe(true);
    });
  });

  describe('listTriggersByPipeline (the pipeline→dependent-triggers reverse index)', () => {
    it('returns triggers bound to ANY version of the pipeline, excluding other pipelines and unbound triggers', () => {
      const { db } = freshDb();
      const pipeline = createPipeline(db, newPipeline);
      const v1 = createPipelineVersion(db, buildVersionInput(pipeline.id));
      const v2 = createPipelineVersion(db, buildVersionInput(pipeline.id));
      const onV1 = createTrigger(db, buildTriggerInput(v1.id));
      const onV2 = createTrigger(db, buildTriggerInput(v2.id));
      // An unbound trigger of the same owner — never fires, never a dependent.
      createTrigger(db, { ...buildTriggerInput(v1.id), pipelineVersionId: null });

      // A wholly separate pipeline + trigger that must NOT be returned.
      const other = createPipeline(db, { ...newPipeline, name: 'Other' });
      const otherV = createPipelineVersion(db, buildVersionInput(other.id));
      createTrigger(db, buildTriggerInput(otherV.id));

      expect(
        listTriggersByPipeline(db, pipeline.id)
          .map((t) => t.id)
          .sort(),
      ).toEqual([onV1.id, onV2.id].sort());
    });
  });

  describe('archivePipeline service (atomic archive + disable dependent triggers)', () => {
    it('archives the pipeline and disables every dependent trigger across all versions', () => {
      const { db } = freshDb();
      const pipeline = createPipeline(db, newPipeline);
      const v1 = createPipelineVersion(db, buildVersionInput(pipeline.id));
      const v2 = createPipelineVersion(db, buildVersionInput(pipeline.id));
      const t1 = createTrigger(db, buildTriggerInput(v1.id));
      const t2 = createTrigger(db, buildTriggerInput(v2.id));

      const result = archivePipeline(db, pipeline.id);
      expect(result!.pipeline.archived).toBe(true);
      expect(result!.disabledTriggerIds.sort()).toEqual([t1.id, t2.id].sort());
      expect(getTrigger(db, t1.id)!.enabled).toBe(false);
      expect(getTrigger(db, t2.id)!.enabled).toBe(false);
    });

    it('returns null for a missing pipeline (never conflated with archiving nothing)', () => {
      const { db } = freshDb();
      expect(archivePipeline(db, 'pipe_missing')).toBeNull();
    });

    it('preserves immutable versions AND run history (soft-delete, not hard-delete)', () => {
      const { db } = freshDb();
      const pipeline = createPipeline(db, newPipeline);
      const version = createPipelineVersion(db, buildVersionInput(pipeline.id));
      const run = createRun(db, {
        ownerId: 'local',
        pipelineVersionId: version.id,
        triggerId: null,
        parentRunId: null,
        params: {},
      });

      archivePipeline(db, pipeline.id);

      expect(getPipeline(db, pipeline.id)!.archived).toBe(true);
      expect(getPipelineVersion(db, version.id)).not.toBeNull();
      expect(getRun(db, run.id)).not.toBeNull();
    });

    it('is idempotent and never RE-enables an already-disabled dependent trigger', () => {
      const { db } = freshDb();
      const pipeline = createPipeline(db, newPipeline);
      const version = createPipelineVersion(db, buildVersionInput(pipeline.id));
      const enabled = createTrigger(db, buildTriggerInput(version.id));
      const alreadyOff = updateTrigger(db, createTrigger(db, buildTriggerInput(version.id)).id, {
        enabled: false,
      })!;

      const first = archivePipeline(db, pipeline.id);
      // Only the enabled one is reported as flipped; the already-off one is untouched.
      expect(first!.disabledTriggerIds).toEqual([enabled.id]);
      const offAfter = getTrigger(db, alreadyOff.id)!;
      expect(offAfter.enabled).toBe(false);
      expect(offAfter.updatedAt).toBe(alreadyOff.updatedAt);

      // Second archive: still archived, nothing new to disable.
      const second = archivePipeline(db, pipeline.id);
      expect(second!.pipeline.archived).toBe(true);
      expect(second!.disabledTriggerIds).toEqual([]);
      expect(getTrigger(db, enabled.id)!.enabled).toBe(false);
    });
  });
});
