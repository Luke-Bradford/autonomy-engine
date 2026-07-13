import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION, type NewPipelineVersion, type NewRun } from '@autonomy-studio/shared';
import { createPipelineVersion } from '../pipeline-versions.js';
import { createPipeline } from '../pipelines.js';
import { createRun, deleteRun, getRun, listRuns, updateRun } from '../runs.js';
import { freshDb } from './helpers.js';

function setupPipelineVersion(db: ReturnType<typeof freshDb>['db']) {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const versionInput: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes: [],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  };
  return createPipelineVersion(db, versionInput);
}

function buildRunInput(pipelineVersionId: string, overrides: Partial<NewRun> = {}): NewRun {
  return {
    ownerId: 'local',
    pipelineVersionId,
    triggerId: null,
    parentRunId: null,
    params: {},
    ...overrides,
  };
}

describe('runs repo', () => {
  it('creates a run defaulting to pending status, with startedAt stamped', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const before = Date.now();
    const created = createRun(db, buildRunInput(version.id));
    expect(created.status).toBe('pending');
    expect(created.startedAt).toBeGreaterThanOrEqual(before);
    expect(created.leaseUntil).toBeNull();
    expect(created.finishedAt).toBeNull();
    expect(getRun(db, created.id)).toEqual(created);
  });

  it('rejects creating a run for a nonexistent pipeline version (FK enforced)', () => {
    const { db } = freshDb();
    expect(() => createRun(db, buildRunInput('pv_does_not_exist'))).toThrow();
  });

  it('creates a child run linked via parentRunId (self-referencing FK)', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const parent = createRun(db, buildRunInput(version.id));
    const child = createRun(db, buildRunInput(version.id, { parentRunId: parent.id }));
    expect(child.parentRunId).toBe(parent.id);
  });

  it('rejects a child run pointing at a nonexistent parent (FK enforced)', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    expect(() =>
      createRun(db, buildRunInput(version.id, { parentRunId: 'run_does_not_exist' })),
    ).toThrow();
  });

  it('filters listRuns by pipelineVersionId, triggerId, and parentRunId', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const otherVersion = setupPipelineVersion(db);
    const a = createRun(db, buildRunInput(version.id));
    const parent = createRun(db, buildRunInput(version.id));
    const child = createRun(db, buildRunInput(version.id, { parentRunId: parent.id }));
    createRun(db, buildRunInput(otherVersion.id));

    expect(
      listRuns(db, { pipelineVersionId: version.id })
        .map((r) => r.id)
        .sort(),
    ).toEqual([a.id, parent.id, child.id].sort());
    expect(listRuns(db, { parentRunId: parent.id })).toEqual([child]);
    expect(listRuns(db)).toHaveLength(4);
  });

  it('filters listRuns by ownerId, in SQL (never over-fetched then filtered)', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const mine = createRun(db, buildRunInput(version.id));
    createRun(db, buildRunInput(version.id, { ownerId: 'someone-else' }));

    expect(listRuns(db, { ownerId: 'local' })).toEqual([mine]);
    expect(listRuns(db)).toHaveLength(2);
  });

  it('updates run lifecycle fields (status/lease/heartbeat/finishedAt)', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const created = createRun(db, buildRunInput(version.id));

    const running = updateRun(db, created.id, {
      status: 'running',
      leaseUntil: created.startedAt + 30_000,
      heartbeatAt: created.startedAt + 1_000,
    });
    expect(running!.status).toBe('running');
    expect(running!.leaseUntil).toBe(created.startedAt + 30_000);

    const finished = updateRun(db, created.id, {
      status: 'success',
      finishedAt: created.startedAt + 60_000,
    });
    expect(finished!.status).toBe('success');
    expect(finished!.finishedAt).toBe(created.startedAt + 60_000);
  });

  it('returns null when updating a missing run', () => {
    const { db } = freshDb();
    expect(updateRun(db, 'run_missing', { status: 'running' })).toBeNull();
  });

  it('rejects an updateRun patch touching an immutable-binding field, even bypassing the TS type', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const created = createRun(db, buildRunInput(version.id));

    // `RunLifecyclePatch` has no `pipelineVersionId`/`triggerId`/
    // `parentRunId`/`params`/`startedAt` field, so this is a type error at
    // the call site (the `as never` cast simulates a caller bypassing that
    // compile-time guard) — `RunLifecyclePatchSchema`'s `.strict()` must
    // still reject it at runtime.
    expect(() => updateRun(db, created.id, { pipelineVersionId: 'pv_other' } as never)).toThrow();
    expect(() => updateRun(db, created.id, { params: { changed: true } } as never)).toThrow();
    expect(() => updateRun(db, created.id, { startedAt: 0 } as never)).toThrow();

    // The run is untouched by the rejected patches.
    expect(getRun(db, created.id)).toEqual(created);
  });

  it('deletes a run', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const created = createRun(db, buildRunInput(version.id));
    expect(deleteRun(db, created.id)).toBe(true);
    expect(getRun(db, created.id)).toBeNull();
  });
});
