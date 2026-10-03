import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION } from '@autonomy-studio/shared';
import { createPipelineVersion } from '../pipeline-versions.js';
import { createPipeline } from '../pipelines.js';
import { createRun, listRunSummariesPage } from '../runs.js';
import { freshDb } from './helpers.js';
import { makeRunActivityFold } from '../../run/activity-counts.js';
import { makeDocResolver } from '../../run/driver.js';

/**
 * #1484 OR35 M1 — the runs grid's Parent column: a child run names the
 * pipeline of the run that called it, resolved by the list's own query.
 */
type TestDb = ReturnType<typeof freshDb>['db'];

function versionOf(db: TestDb, ownerId: string | null, name: string): string {
  const pipeline = createPipeline(db, { ownerId, name });
  return createPipelineVersion(db, {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes: [],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  }).id;
}

function run(
  db: TestDb,
  ownerId: string | null,
  versionId: string,
  parentRunId: string | null,
): string {
  return createRun(db, {
    ownerId,
    pipelineVersionId: versionId,
    triggerId: null,
    parentRunId,
    params: {},
  }).id;
}

function parentNameOf(
  db: TestDb,
  runId: string,
  filter: { ownerId?: string } = { ownerId: 'local' },
): string | null | undefined {
  const fold = makeRunActivityFold(makeDocResolver(db));
  return listRunSummariesPage(db, filter, { limit: 100 }, fold).items.find((r) => r.id === runId)
    ?.parentPipelineName;
}

describe('RunSummary.parentPipelineName (#1484)', () => {
  it("names the calling run's pipeline on a child, and is null on a run nobody called", () => {
    const { db } = freshDb();
    const parent = run(db, 'local', versionOf(db, 'local', 'Orchestrator'), null);
    const child = run(db, 'local', versionOf(db, 'local', 'Ingest'), parent);
    expect(parentNameOf(db, child)).toBe('Orchestrator');
    expect(parentNameOf(db, parent)).toBeNull();
  });

  it("never names another owner's pipeline, whatever the row's parent id says", () => {
    const { db } = freshDb();
    const foreign = run(db, 'other', versionOf(db, 'other', 'Secret plan'), null);
    const child = run(db, 'local', versionOf(db, 'local', 'Ingest'), foreign);
    expect(parentNameOf(db, child)).toBeNull();
  });

  it('names the parent of an ownerless child, as the run detail route does', () => {
    const { db } = freshDb();
    const parent = run(db, null, versionOf(db, null, 'Orchestrator'), null);
    const child = run(db, null, versionOf(db, null, 'Ingest'), parent);
    expect(parentNameOf(db, child, {})).toBe('Orchestrator');
  });
});
