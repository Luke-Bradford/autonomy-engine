import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { CATALOG_VERSION, type NewPipelineVersion } from '@autonomy-studio/shared';
import { pipelineVersions } from '../../db/schema.js';
import {
  deleteUnrunDebugVersion,
  drainDebugVersions,
  pruneDebugVersions,
} from '../debug-versions.js';
import {
  createPipelineVersion,
  getHeadVersionRef,
  getLatestPipelineVersion,
  getPipelineVersion,
  isDebugVersion,
  listPipelineVersions,
  listVersionResourceIds,
} from '../pipeline-versions.js';
import { createPipeline } from '../pipelines.js';
import { appendRunEvent, listRunEvents } from '../run-events.js';
import { createRun, getRun, updateRun } from '../runs.js';
import type { Db } from '../types.js';
import { freshDb } from './helpers.js';

function doc(pipelineId: string): NewPipelineVersion {
  return {
    pipelineId,
    params: [],
    outputs: [],
    nodes: [{ id: 'n1', type: 'llm_call', config: {}, position: { x: 0, y: 0 } }],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  };
}

function setup() {
  const { db } = freshDb();
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  return { db, pipeline };
}

function run(db: Db, pipelineVersionId: string) {
  return createRun(db, {
    ownerId: 'local',
    pipelineVersionId,
    triggerId: null,
    parentRunId: null,
    params: {},
  });
}

/** Age a version by rewriting `created_at` — only possible with the no_update trigger off. */
function ageVersion(db: Db, id: string, createdAt: number) {
  db.run(sql`DROP TRIGGER IF EXISTS pipeline_versions_no_update`);
  db.update(pipelineVersions).set({ createdAt }).where(eq(pipelineVersions.id, id)).run();
}

describe('debug versions (#1395 OR4)', () => {
  it('number in their own sequence and never take a saved number', () => {
    const { db, pipeline } = setup();
    const v1 = createPipelineVersion(db, doc(pipeline.id));
    const d1 = createPipelineVersion(db, doc(pipeline.id), { debug: true });
    const d2 = createPipelineVersion(db, doc(pipeline.id), { debug: true });
    const v2 = createPipelineVersion(db, doc(pipeline.id));
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect([d1.version, d2.version]).toEqual([1, 2]);
    expect(isDebugVersion(db, d1.id)).toBe(true);
    expect(isDebugVersion(db, v1.id)).toBe(false);
    expect(isDebugVersion(db, 'pv_missing')).toBeNull();
  });

  it('are excluded from every listing and from the head, but resolve by id', () => {
    const { db, pipeline } = setup();
    const v1 = createPipelineVersion(db, doc(pipeline.id));
    const d1 = createPipelineVersion(db, doc(pipeline.id), { debug: true });
    expect(listPipelineVersions(db, pipeline.id).map((v) => v.id)).toEqual([v1.id]);
    expect(getLatestPipelineVersion(db, pipeline.id)?.id).toBe(v1.id);
    expect(getHeadVersionRef(db, pipeline.id)).toEqual({ id: v1.id, version: 1 });
    expect(listVersionResourceIds(db, 'local').has(d1.resourceId)).toBe(false);
    expect(getPipelineVersion(db, d1.id)?.id).toBe(d1.id);
  });

  it('a pipeline with only a Debug has no head and no versions', () => {
    const { db, pipeline } = setup();
    createPipelineVersion(db, doc(pipeline.id), { debug: true });
    expect(listPipelineVersions(db, pipeline.id)).toEqual([]);
    expect(getHeadVersionRef(db, pipeline.id)).toBeNull();
  });

  it('the DB still refuses deleting a SAVED version; a debug one may go', () => {
    const { db, pipeline } = setup();
    const v1 = createPipelineVersion(db, doc(pipeline.id));
    const d1 = createPipelineVersion(db, doc(pipeline.id), { debug: true });
    expect(() => db.delete(pipelineVersions).where(eq(pipelineVersions.id, v1.id)).run()).toThrow(
      /immutable/,
    );
    expect(deleteUnrunDebugVersion(db, v1.id)).toBe(false);
    expect(getPipelineVersion(db, v1.id)).not.toBeNull();
    expect(deleteUnrunDebugVersion(db, d1.id)).toBe(true);
    expect(getPipelineVersion(db, d1.id)).toBeNull();
  });

  it('deleteUnrunDebugVersion leaves a debug version that has a run', () => {
    const { db, pipeline } = setup();
    const d1 = createPipelineVersion(db, doc(pipeline.id), { debug: true });
    run(db, d1.id);
    expect(deleteUnrunDebugVersion(db, d1.id)).toBe(false);
    expect(getPipelineVersion(db, d1.id)).not.toBeNull();
  });

  it('are never updatable, so a saved version cannot be flipped into a debug one', () => {
    const { db, pipeline } = setup();
    const v1 = createPipelineVersion(db, doc(pipeline.id));
    expect(() =>
      db.update(pipelineVersions).set({ debug: true }).where(eq(pipelineVersions.id, v1.id)).run(),
    ).toThrow(/immutable/);
  });
});

describe('a call_pipeline pin to a debug version (#1395 OR4)', () => {
  function caller(pipelineId: string, target: string): NewPipelineVersion {
    return {
      ...doc(pipelineId),
      nodes: [
        {
          id: 'call',
          type: 'call_pipeline',
          config: {},
          position: { x: 0, y: 0 },
          call: { pipelineVersionId: target, params: {} },
        },
      ],
    };
  }

  it('is refused at save, naming the debug version; a saved callee is accepted', () => {
    const { db, pipeline } = setup();
    const callee = createPipeline(db, { ownerId: 'local', name: 'Callee' });
    const saved = createPipelineVersion(db, doc(callee.id));
    const debugCallee = createPipelineVersion(db, doc(callee.id), { debug: true });
    expect(() => createPipelineVersion(db, caller(pipeline.id, debugCallee.id))).toThrow(
      new RegExp(`cannot call debug version '${debugCallee.id}'`),
    );
    expect(listPipelineVersions(db, pipeline.id)).toEqual([]);
    expect(createPipelineVersion(db, caller(pipeline.id, saved.id)).version).toBe(1);
  });

  it('never classifies ANOTHER owner’s version, so the refusal is no existence oracle', () => {
    const { db, pipeline } = setup();
    const foreign = createPipeline(db, { ownerId: 'someone-else', name: 'Theirs' });
    const theirDebug = createPipelineVersion(db, doc(foreign.id), { debug: true });
    expect(() => createPipelineVersion(db, caller(pipeline.id, theirDebug.id))).not.toThrow(
      /debug version/,
    );
  });
});

describe('debug version retention (#1395 OR4)', () => {
  const DAY = 86_400_000;

  it('prunes an expired debug version with its settled runs and their events', () => {
    const { db, pipeline } = setup();
    const saved = createPipelineVersion(db, doc(pipeline.id));
    const savedRun = run(db, saved.id);
    const d1 = createPipelineVersion(db, doc(pipeline.id), { debug: true });
    const r = run(db, d1.id);
    appendRunEvent(db, { runId: r.id, type: 'run.started', payload: {} });
    updateRun(db, r.id, { status: 'success', finishedAt: Date.now() });
    ageVersion(db, d1.id, Date.now() - 10 * DAY);

    expect(drainDebugVersions(db, { before: Date.now() - 7 * DAY })).toBe(1);
    expect(getPipelineVersion(db, d1.id)).toBeNull();
    expect(getRun(db, r.id)).toBeNull();
    expect(listRunEvents(db, r.id)).toEqual([]);
    // The saved version and its run are untouched.
    expect(getPipelineVersion(db, saved.id)).not.toBeNull();
    expect(getRun(db, savedRun.id)).not.toBeNull();
  });

  it('keeps a debug version younger than the cutoff', () => {
    const { db, pipeline } = setup();
    const d1 = createPipelineVersion(db, doc(pipeline.id), { debug: true });
    expect(pruneDebugVersions(db, { before: Date.now() - 7 * DAY, limit: 10 })).toBe(0);
    expect(getPipelineVersion(db, d1.id)).not.toBeNull();
  });

  it('keeps an expired debug version while any of its runs is still in flight', () => {
    const { db, pipeline } = setup();
    const d1 = createPipelineVersion(db, doc(pipeline.id), { debug: true });
    const done = run(db, d1.id);
    updateRun(db, done.id, { status: 'failure', finishedAt: Date.now() });
    const live = run(db, d1.id);
    updateRun(db, live.id, { status: 'running' });
    ageVersion(db, d1.id, Date.now() - 10 * DAY);

    expect(pruneDebugVersions(db, { before: Date.now() - 7 * DAY, limit: 10 })).toBe(0);
    expect(getRun(db, done.id)).not.toBeNull();

    updateRun(db, live.id, { status: 'success', finishedAt: Date.now() });
    expect(pruneDebugVersions(db, { before: Date.now() - 7 * DAY, limit: 10 })).toBe(1);
    expect(getRun(db, live.id)).toBeNull();
  });

  it('never prunes a saved version, however old', () => {
    const { db, pipeline } = setup();
    const v1 = createPipelineVersion(db, doc(pipeline.id));
    ageVersion(db, v1.id, Date.now() - 100 * DAY);
    expect(drainDebugVersions(db, { before: Date.now() })).toBe(0);
    expect(getPipelineVersion(db, v1.id)).not.toBeNull();
  });

  it('drains in bounded batches', () => {
    const { db, pipeline } = setup();
    const ids = [1, 2, 3].map(
      () => createPipelineVersion(db, doc(pipeline.id), { debug: true }).id,
    );
    for (const id of ids) ageVersion(db, id, Date.now() - 10 * DAY);
    expect(drainDebugVersions(db, { before: Date.now(), batch: 2, maxBatches: 1 })).toBe(2);
    expect(drainDebugVersions(db, { before: Date.now(), batch: 2 })).toBe(1);
  });
});
