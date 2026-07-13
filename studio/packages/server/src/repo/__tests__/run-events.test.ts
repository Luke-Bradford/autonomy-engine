import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION, type NewPipelineVersion } from '@autonomy-studio/shared';
import { runEvents } from '../../db/schema.js';
import { createPipelineVersion } from '../pipeline-versions.js';
import { createPipeline } from '../pipelines.js';
import { appendRunEvent, getRunEvent, listRunEvents } from '../run-events.js';
import * as runEventsRepo from '../run-events.js';
import { createRun } from '../runs.js';
import { freshDb } from './helpers.js';

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

describe('run-events repo', () => {
  it('appends the first event at seq 0', () => {
    const { db } = freshDb();
    const run = setupRun(db);
    const evt = appendRunEvent(db, { runId: run.id, type: 'run.started', payload: {} });
    expect(evt.seq).toBe(0);
    expect(getRunEvent(db, evt.id)).toEqual(evt);
  });

  it('assigns a strictly monotonic seq per run, independent of other runs', () => {
    const { db } = freshDb();
    const runA = setupRun(db);
    const runB = setupRun(db);

    const a0 = appendRunEvent(db, { runId: runA.id, type: 'run.started', payload: {} });
    const b0 = appendRunEvent(db, { runId: runB.id, type: 'run.started', payload: {} });
    const a1 = appendRunEvent(db, {
      runId: runA.id,
      type: 'node.started',
      payload: { node: 'n1' },
    });
    const a2 = appendRunEvent(db, {
      runId: runA.id,
      type: 'node.succeeded',
      payload: { node: 'n1' },
    });

    expect([a0.seq, a1.seq, a2.seq]).toEqual([0, 1, 2]);
    expect(b0.seq).toBe(0);
    expect(listRunEvents(db, runA.id).map((e) => e.id)).toEqual([a0.id, a1.id, a2.id]);
  });

  it('rejects appending an event for a nonexistent run (FK enforced)', () => {
    const { db } = freshDb();
    expect(() =>
      appendRunEvent(db, { runId: 'run_does_not_exist', type: 'run.started', payload: {} }),
    ).toThrow();
  });

  it('rejects a duplicate (runId, seq) pair at the DB layer (unique index enforced)', () => {
    const { db } = freshDb();
    const run = setupRun(db);
    const row = {
      id: 'evt_dup_1',
      runId: run.id,
      seq: 0,
      type: 'run.started',
      payload: {},
      ts: Date.now(),
    };
    db.insert(runEvents).values(row).run();

    expect(() =>
      db
        .insert(runEvents)
        .values({ ...row, id: 'evt_dup_2' })
        .run(),
    ).toThrow();
  });

  it('has no update/delete path — the module exports neither (append-only invariant)', () => {
    const mod = runEventsRepo as unknown as Record<string, unknown>;
    expect(mod['updateRunEvent']).toBeUndefined();
    expect(mod['deleteRunEvent']).toBeUndefined();
  });
});
