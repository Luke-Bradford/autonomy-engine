import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION, type NewPipelineVersion } from '@autonomy-studio/shared';
import { pipelineVersions } from '../../db/schema.js';
import {
  createPipelineVersion,
  getLatestPipelineVersion,
  getPipelineVersion,
  listPipelineVersions,
} from '../pipeline-versions.js';
import * as pipelineVersionsRepo from '../pipeline-versions.js';
import { createPipeline } from '../pipelines.js';
import { freshDb } from './helpers.js';

function buildVersionInput(pipelineId: string): NewPipelineVersion {
  return {
    pipelineId,
    params: [{ name: 'topic', type: 'string', required: true }],
    outputs: [{ name: 'summary', type: 'string' }],
    nodes: [{ id: 'node_1', type: 'llm_call', config: {}, position: { x: 0, y: 0 } }],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  };
}

describe('pipeline-versions repo', () => {
  it('creates version 1 for a brand-new pipeline', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    const v1 = createPipelineVersion(db, buildVersionInput(pipeline.id));
    expect(v1.version).toBe(1);
    expect(v1.pipelineId).toBe(pipeline.id);
    expect(getPipelineVersion(db, v1.id)).toEqual(v1);
  });

  it('auto-increments version per pipelineId on successive creates', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    const v1 = createPipelineVersion(db, buildVersionInput(pipeline.id));
    const v2 = createPipelineVersion(db, buildVersionInput(pipeline.id));
    const v3 = createPipelineVersion(db, buildVersionInput(pipeline.id));
    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
  });

  it('numbers versions independently per pipeline', () => {
    const { db } = freshDb();
    const pipelineA = createPipeline(db, { ownerId: 'local', name: 'A' });
    const pipelineB = createPipeline(db, { ownerId: 'local', name: 'B' });
    createPipelineVersion(db, buildVersionInput(pipelineA.id));
    const bV1 = createPipelineVersion(db, buildVersionInput(pipelineB.id));
    expect(bV1.version).toBe(1);
  });

  it('lists versions oldest-first and getLatestPipelineVersion returns the newest', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    const v1 = createPipelineVersion(db, buildVersionInput(pipeline.id));
    const v2 = createPipelineVersion(db, buildVersionInput(pipeline.id));

    expect(listPipelineVersions(db, pipeline.id).map((v) => v.id)).toEqual([v1.id, v2.id]);
    expect(getLatestPipelineVersion(db, pipeline.id)).toEqual(v2);
  });

  it('has no update path — the module exports no updatePipelineVersion (immutability invariant)', () => {
    expect(
      (pipelineVersionsRepo as unknown as Record<string, unknown>)['updatePipelineVersion'],
    ).toBeUndefined();
  });

  it('rejects creating a version for a nonexistent pipeline (FK enforced)', () => {
    const { db } = freshDb();
    expect(() => createPipelineVersion(db, buildVersionInput('pipe_does_not_exist'))).toThrow();
  });

  it('rejects a duplicate (pipelineId, version) pair at the DB layer (unique index enforced)', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    const input = buildVersionInput(pipeline.id);

    const row = {
      id: 'pv_dup_1',
      ...input,
      catalogVersion: input.catalogVersion ?? CATALOG_VERSION,
      version: 1,
      createdAt: Date.now(),
    };
    db.insert(pipelineVersions).values(row).run();

    expect(() =>
      db
        .insert(pipelineVersions)
        .values({ ...row, id: 'pv_dup_2' })
        .run(),
    ).toThrow();
  });
});
