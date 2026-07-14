import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION, type NewPipelineVersion, type NewTrigger } from '@autonomy-studio/shared';
import { createPipelineVersion } from '../pipeline-versions.js';
import { createPipeline } from '../pipelines.js';
import {
  createTrigger,
  deleteTrigger,
  getTrigger,
  listParsedTriggers,
  listTriggers,
  updateTrigger,
} from '../triggers.js';
import { triggers } from '../../db/schema.js';
import { freshDb } from './helpers.js';

/** Insert a row DIRECTLY (bypassing `createTrigger`'s schema validation) whose
 * `concurrency` JSON has an out-of-enum policy — the DB has no CHECK on that
 * JSON column, so the row persists but `TriggerSchema.parse` rejects it. Used
 * to simulate a corrupt/legacy row. */
function insertPoisonRow(db: ReturnType<typeof freshDb>['db'], id: string): void {
  db.insert(triggers)
    .values({
      id,
      ownerId: 'local',
      name: 'poison',
      pipelineVersionId: null,
      params: {},
      mode: 'schedule',
      schedule: '0 2 * * *',
      webhook: null,
      // Out-of-enum policy: valid JSON, rejected by ConcurrencySchema.
      concurrency: { policy: 'nope' } as unknown as { policy: 'queue' },
      runWindows: null,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
}

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

  describe('listParsedTriggers — resilient to a corrupt row', () => {
    it('skips (and reports) an unparseable row while returning the good ones', () => {
      const { db } = freshDb();
      const version = setupPipelineVersion(db);
      const good = createTrigger(db, buildTriggerInput(version.id));
      insertPoisonRow(db, 'trig_poison');

      // The strict list throws on the poison row...
      expect(() => listTriggers(db)).toThrow();

      // ...but the resilient list returns the good one and reports the bad id.
      const skipped: unknown[] = [];
      const parsed = listParsedTriggers(db, (id) => skipped.push(id));
      expect(parsed.map((t) => t.id)).toEqual([good.id]);
      expect(skipped).toEqual(['trig_poison']);
    });
  });
});
