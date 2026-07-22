import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION, type NewPipelineVersion } from '@autonomy-studio/shared';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun, getRun, updateRun } from '../../repo/runs.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { syncRunLifecycle } from '../driver.js';

/**
 * #5 S4 — split the execution LEASE from the lifecycle STATUS. `syncRunLifecycle`
 * projects `leaseUntil` from the run's status: a `running` run HOLDS a lease (a
 * live drive is executing it); a `waiting` (parked) or terminal run RELEASES it
 * (`leaseUntil = null`) so it occupies no worker. The lease is a pure projection
 * of status — no new event, no reducer change — written only on a real status
 * transition (the same idempotent early-return that guards `finishedAt`), so it
 * is stamped ONCE on entry to `running` and never re-stamped mid-run (heartbeat
 * RENEWAL + expiry reclaim are #5 S7).
 */
function setupRun(db: ReturnType<typeof freshDb>['db']) {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const versionInput: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes: [],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  };
  const version = createPipelineVersion(db, versionInput);
  return createRun(db, {
    ownerId: 'local',
    pipelineVersionId: version.id,
    triggerId: null,
    parentRunId: null,
    params: {},
  });
}

describe('#5 S4 — syncRunLifecycle projects the execution lease from status', () => {
  it('acquires a lease (future leaseUntil) on the transition into running', () => {
    const { db } = freshDb();
    const run = setupRun(db);
    expect(run.leaseUntil).toBeNull();

    const before = Date.now();
    syncRunLifecycle(db, run.id, 'running');

    const after = getRun(db, run.id);
    expect(after?.leaseUntil).not.toBeNull();
    expect(after!.leaseUntil!).toBeGreaterThanOrEqual(before);
  });

  it('releases the lease on the transition into waiting (parked → no worker)', () => {
    const { db } = freshDb();
    const run = setupRun(db);
    syncRunLifecycle(db, run.id, 'running');
    expect(getRun(db, run.id)?.leaseUntil).not.toBeNull();

    syncRunLifecycle(db, run.id, 'waiting');
    expect(getRun(db, run.id)?.leaseUntil).toBeNull();
  });

  it('re-acquires the lease on unpark (waiting → running)', () => {
    const { db } = freshDb();
    const run = setupRun(db);
    syncRunLifecycle(db, run.id, 'running');
    syncRunLifecycle(db, run.id, 'waiting');
    expect(getRun(db, run.id)?.leaseUntil).toBeNull();

    syncRunLifecycle(db, run.id, 'running');
    expect(getRun(db, run.id)?.leaseUntil).not.toBeNull();
  });

  it('releases the lease on a terminal transition', () => {
    const { db } = freshDb();
    const run = setupRun(db);
    syncRunLifecycle(db, run.id, 'running');

    syncRunLifecycle(db, run.id, 'success');
    expect(getRun(db, run.id)?.leaseUntil).toBeNull();
  });

  it('does NOT re-stamp the lease on a no-op re-sync (unchanged status)', () => {
    const { db } = freshDb();
    const run = setupRun(db);
    syncRunLifecycle(db, run.id, 'running');

    // Poke a recognisable sentinel; a no-op re-sync must NOT overwrite it (the
    // early-return means no mid-run lease thrash — heartbeat renewal is S7).
    const SENTINEL = 424_242;
    updateRun(db, run.id, { leaseUntil: SENTINEL });

    syncRunLifecycle(db, run.id, 'running');
    expect(getRun(db, run.id)?.leaseUntil).toBe(SENTINEL);
  });
});
