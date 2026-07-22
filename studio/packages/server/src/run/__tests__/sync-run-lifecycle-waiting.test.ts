import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION, type NewPipelineVersion } from '@autonomy-studio/shared';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun, getRun } from '../../repo/runs.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { syncRunLifecycle } from '../driver.js';

/**
 * #5 S3 — the driver's `TERMINAL_RUN` set (module-private) must NOT treat the new
 * `waiting` lifecycle status as terminal. Tested through the observable contract
 * of `syncRunLifecycle`: it stamps `finishedAt` ONCE on a terminal status and
 * never on a non-terminal one. So a `waiting` sync writes the status but leaves
 * `finishedAt` null — proving `waiting` is non-terminal, the run-level twin of a
 * parked node. (No migration: `runs.status`'s CHECK has always allowed `waiting`.)
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

describe('#5 S3 — syncRunLifecycle(waiting) is non-terminal', () => {
  it('writes status `waiting` WITHOUT stamping finishedAt', () => {
    const { db } = freshDb();
    const run = setupRun(db);
    expect(run.finishedAt).toBeNull();

    syncRunLifecycle(db, run.id, 'waiting');

    const after = getRun(db, run.id);
    expect(after?.status).toBe('waiting');
    expect(after?.finishedAt).toBeNull();
  });

  it('contrast: a terminal status DOES stamp finishedAt (guards the set is real)', () => {
    const { db } = freshDb();
    const run = setupRun(db);

    syncRunLifecycle(db, run.id, 'success');

    const after = getRun(db, run.id);
    expect(after?.status).toBe('success');
    expect(after?.finishedAt).not.toBeNull();
  });
});
