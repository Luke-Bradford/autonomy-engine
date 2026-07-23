import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION, type NewPipelineVersion } from '@autonomy-studio/shared';
import {
  createPipeline,
  deletePipeline,
  getPipeline,
  getPipelineByResourceId,
  listPipelines,
  restorePipeline,
  updatePipeline,
  archivePipelineRow,
  PipelineHasRunsError,
} from '../pipelines.js';
import { createPipelineVersion, getPipelineVersion } from '../pipeline-versions.js';
import { createRun } from '../runs.js';
import { freshDb } from './helpers.js';

const newPipeline = { ownerId: 'local', name: 'My pipeline' };

describe('pipelines repo', () => {
  it('creates and reads back a pipeline', () => {
    const { db } = freshDb();
    const created = createPipeline(db, newPipeline);
    expect(created.id).toMatch(/^pipe_/);
    expect(getPipeline(db, created.id)).toEqual(created);
  });

  it('returns null for a missing id', () => {
    const { db } = freshDb();
    expect(getPipeline(db, 'pipe_missing')).toBeNull();
  });

  it('lists all pipelines', () => {
    const { db } = freshDb();
    const a = createPipeline(db, { ...newPipeline, name: 'A' });
    const b = createPipeline(db, { ...newPipeline, name: 'B' });
    expect(
      listPipelines(db)
        .map((p) => p.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  });

  it('renames a pipeline via update', () => {
    const { db } = freshDb();
    const created = createPipeline(db, newPipeline);
    const updated = updatePipeline(db, created.id, { name: 'New name' });
    expect(updated!.name).toBe('New name');
    expect(updated!.createdAt).toBe(created.createdAt);
  });

  it('deletes a pipeline', () => {
    const { db } = freshDb();
    const created = createPipeline(db, newPipeline);
    expect(deletePipeline(db, created.id)).toBe(true);
    expect(getPipeline(db, created.id)).toBeNull();
  });

  it('returns false when deleting a missing pipeline (never conflated with the has-runs case)', () => {
    const { db } = freshDb();
    expect(deletePipeline(db, 'pipe_missing')).toBe(false);
  });

  describe('deleting a pipeline with versions/run history (RESTRICT-on-history)', () => {
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

    it('cascades and deletes a pipeline that has versions but no runs', () => {
      const { db } = freshDb();
      const pipeline = createPipeline(db, newPipeline);
      const version = createPipelineVersion(db, buildVersionInput(pipeline.id));

      expect(deletePipeline(db, pipeline.id)).toBe(true);
      expect(getPipeline(db, pipeline.id)).toBeNull();
      expect(getPipelineVersion(db, version.id)).toBeNull();
    });

    it('throws a typed PipelineHasRunsError (not an opaque error or a misleading `false`) for a pipeline with run history', () => {
      const { db } = freshDb();
      const pipeline = createPipeline(db, newPipeline);
      const version = createPipelineVersion(db, buildVersionInput(pipeline.id));
      createRun(db, {
        ownerId: null,
        pipelineVersionId: version.id,
        triggerId: null,
        parentRunId: null,
        params: {},
      });

      expect(() => deletePipeline(db, pipeline.id)).toThrow(PipelineHasRunsError);
      // Nothing was actually removed by the failed attempt.
      expect(getPipeline(db, pipeline.id)).not.toBeNull();
      expect(getPipelineVersion(db, version.id)).not.toBeNull();
    });
  });

  // #3 G5c — the workspace-git reconcile apply primitives.
  describe('resourceId preservation + lookup + restore (G5c)', () => {
    it('preserves a supplied resourceId on create (else mints fresh)', () => {
      const { db } = freshDb();
      const preserved = createPipeline(db, newPipeline, { resourceId: 'res_preserved' });
      expect(preserved.resourceId).toBe('res_preserved');
      const minted = createPipeline(db, newPipeline);
      expect(minted.resourceId).toMatch(/^res_/);
      expect(minted.resourceId).not.toBe('res_preserved');
    });

    it('resolves a pipeline by (ownerId, resourceId), owner-scoped', () => {
      const { db } = freshDb();
      const mine = createPipeline(db, { ownerId: 'me', name: 'Mine' }, { resourceId: 'res_x' });
      // Same resourceId under a DIFFERENT owner is a different row and must not
      // leak across the owner scope.
      createPipeline(db, { ownerId: 'other', name: 'Theirs' }, { resourceId: 'res_x' });
      expect(getPipelineByResourceId(db, 'me', 'res_x')?.id).toBe(mine.id);
      expect(getPipelineByResourceId(db, 'me', 'res_missing')).toBeNull();
    });

    it('finds an ARCHIVED pipeline by resourceId (restore-vs-create needs to see it)', () => {
      const { db } = freshDb();
      const p = createPipeline(db, newPipeline, { resourceId: 'res_arch' });
      archivePipelineRow(db, p.id);
      const found = getPipelineByResourceId(db, 'local', 'res_arch');
      expect(found?.id).toBe(p.id);
      expect(found?.archived).toBe(true);
    });

    it('restorePipeline flips archived back to false; null for a missing id', () => {
      const { db } = freshDb();
      const p = createPipeline(db, newPipeline);
      archivePipelineRow(db, p.id);
      expect(getPipeline(db, p.id)?.archived).toBe(true);
      const restored = restorePipeline(db, p.id);
      expect(restored?.archived).toBe(false);
      expect(getPipeline(db, p.id)?.archived).toBe(false);
      expect(restorePipeline(db, 'pipe_missing')).toBeNull();
    });
  });
});
