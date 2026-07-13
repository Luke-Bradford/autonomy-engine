import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION, type NewPipelineVersion, type NewTrigger } from '@autonomy-studio/shared';
import { createPipelineVersion } from '../pipeline-versions.js';
import { createPipeline } from '../pipelines.js';
import {
  createTrigger,
  deleteTrigger,
  getTrigger,
  listTriggers,
  updateTrigger,
} from '../triggers.js';
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

describe('triggers repo', () => {
  it('creates and reads back a trigger', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const created = createTrigger(db, buildTriggerInput(version.id));
    expect(created.id).toMatch(/^trig_/);
    expect(getTrigger(db, created.id)).toEqual(created);
  });

  it('rejects creating a trigger for a nonexistent pipeline version (FK enforced)', () => {
    const { db } = freshDb();
    expect(() => createTrigger(db, buildTriggerInput('pv_does_not_exist'))).toThrow();
  });

  it('creates and reads back an UNBOUND trigger (P1c: null pipelineVersionId, e.g. freshly imported)', () => {
    const { db } = freshDb();
    const created = createTrigger(db, {
      ...buildTriggerInput('pv_unused'),
      pipelineVersionId: null,
    });
    expect(created.pipelineVersionId).toBeNull();
    expect(getTrigger(db, created.id)).toEqual(created);
  });

  it('lists triggers, optionally filtered by pipelineVersionId', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const otherVersion = setupPipelineVersion(db);
    const a = createTrigger(db, buildTriggerInput(version.id));
    createTrigger(db, buildTriggerInput(otherVersion.id));

    expect(listTriggers(db, { pipelineVersionId: version.id })).toEqual([a]);
    expect(listTriggers(db)).toHaveLength(2);
  });

  it('lists triggers filtered by ownerId, in SQL (never over-fetched then filtered)', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const mine = createTrigger(db, buildTriggerInput(version.id));
    createTrigger(db, { ...buildTriggerInput(version.id), ownerId: 'someone-else' });

    expect(listTriggers(db, { ownerId: 'local' })).toEqual([mine]);
    expect(listTriggers(db)).toHaveLength(2);
  });

  it('updates a trigger (e.g. disabling it) and bumps updatedAt', async () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const created = createTrigger(db, buildTriggerInput(version.id));
    await new Promise((resolve) => setTimeout(resolve, 2));

    const updated = updateTrigger(db, created.id, { enabled: false });
    expect(updated!.enabled).toBe(false);
    expect(updated!.updatedAt).toBeGreaterThan(created.updatedAt);
  });

  it('deletes a trigger', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const created = createTrigger(db, buildTriggerInput(version.id));
    expect(deleteTrigger(db, created.id)).toBe(true);
    expect(getTrigger(db, created.id)).toBeNull();
  });
});
