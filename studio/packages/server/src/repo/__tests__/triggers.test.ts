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

  describe('#5 S5b-1 — recurrence → derived schedule', () => {
    it('derives the cron `schedule` from a recurrence on create, and round-trips the recurrence', () => {
      const { db } = freshDb();
      const version = setupPipelineVersion(db);
      const created = createTrigger(db, {
        ...buildTriggerInput(version.id),
        schedule: null,
        recurrence: { frequency: 'day', schedule: { hours: [9], minutes: [30] } },
      });
      // `schedule` is the DERIVED cron the firing chain reads...
      expect(created.schedule).toBe('30 9 * * *');
      // ...and the authored recurrence round-trips (interval defaulted to 1).
      expect(created.recurrence).toEqual({
        frequency: 'day',
        interval: 1,
        schedule: { hours: [9], minutes: [30] },
      });
      // Read-back proves it persisted (the #473 second loss point — a builder that
      // drops the field would fail HERE, not just at the schema⇔column seam).
      expect(getTrigger(db, created.id)).toEqual(created);
    });

    it('persists + round-trips recurrence bounds (#549 S5b-2), cron stays bound-free', () => {
      const { db } = freshDb();
      const version = setupPipelineVersion(db);
      const created = createTrigger(db, {
        ...buildTriggerInput(version.id),
        schedule: null,
        recurrence: {
          frequency: 'day',
          schedule: { hours: [9] },
          startTime: '2026-08-01T00:00:00Z',
          endTime: '2026-08-31T00:00:00Z',
        },
      });
      // Bounds are NOT cron-expressible, so the derived cron is bound-free.
      expect(created.schedule).toBe('0 9 * * *');
      expect(created.recurrence).toEqual({
        frequency: 'day',
        interval: 1,
        schedule: { hours: [9] },
        startTime: '2026-08-01T00:00:00Z',
        endTime: '2026-08-31T00:00:00Z',
      });
      // Read-back proves the bounds survive the schema⇔JSON-column seam (the #473
      // silent-drop shape — a column that ignored the new keys would fail HERE).
      expect(getTrigger(db, created.id)).toEqual(created);
    });

    it('refuses an inverted window (endTime <= startTime) at the REPO boundary (#549)', () => {
      const { db } = freshDb();
      const version = setupPipelineVersion(db);
      // The repo re-validates via RecurrenceWriteSchema on UPDATE, so a caller
      // bypassing the route cannot persist an empty window.
      const created = createTrigger(db, {
        ...buildTriggerInput(version.id),
        schedule: null,
        recurrence: { frequency: 'day', schedule: { hours: [9] } },
      });
      expect(() =>
        updateTrigger(db, created.id, {
          recurrence: {
            frequency: 'day',
            schedule: { hours: [9] },
            startTime: '2026-08-31T00:00:00Z',
            endTime: '2026-08-01T00:00:00Z',
          } as never,
        }),
      ).toThrow();
    });

    it('re-derives the schedule when the recurrence is updated', () => {
      const { db } = freshDb();
      const version = setupPipelineVersion(db);
      const created = createTrigger(db, {
        ...buildTriggerInput(version.id),
        schedule: null,
        recurrence: { frequency: 'day', schedule: { hours: [9] } },
      });
      expect(created.schedule).toBe('0 9 * * *');

      const updated = updateTrigger(db, created.id, {
        recurrence: { frequency: 'week', schedule: { weekDays: [1, 5], hours: [8] } },
      });
      expect(updated!.schedule).toBe('0 8 * * 1,5');
      expect(updated!.recurrence?.frequency).toBe('week');
    });

    it('drops the stale derived cron when a recurrence is CLEARED (never leaks it as a raw cron)', () => {
      const { db } = freshDb();
      const version = setupPipelineVersion(db);
      const created = createTrigger(db, {
        ...buildTriggerInput(version.id),
        schedule: null,
        recurrence: { frequency: 'day', schedule: { hours: [9] } },
      });
      expect(created.schedule).toBe('0 9 * * *');

      // Clear recurrence WITHOUT supplying a raw schedule → schedule becomes null,
      // NOT the leftover '0 9 * * *' (which the operator never authored as a cron).
      const cleared = updateTrigger(db, created.id, { recurrence: null });
      expect(cleared!.recurrence).toBeNull();
      expect(cleared!.schedule).toBeNull();
    });

    it('refuses a write-invalid recurrence on update at the REPO boundary (not just the route)', () => {
      // The repo is "the single write-path authority": a caller bypassing the
      // HTTP route (an admin script / later refactor) must still be refused a
      // wrong-compiling recurrence (here: a `week` with no `weekDays`, which
      // would otherwise derive `dow:'*'` = daily) — validated by
      // `RecurrenceWriteSchema`, not the lenient read schema.
      const { db } = freshDb();
      const version = setupPipelineVersion(db);
      const created = createTrigger(db, buildTriggerInput(version.id));
      expect(() =>
        updateTrigger(db, created.id, {
          recurrence: { frequency: 'week' } as never,
        }),
      ).toThrow();
    });

    it('leaves recurrence + derived schedule untouched on an unrelated patch', () => {
      const { db } = freshDb();
      const version = setupPipelineVersion(db);
      const created = createTrigger(db, {
        ...buildTriggerInput(version.id),
        schedule: null,
        recurrence: { frequency: 'day', schedule: { hours: [9] } },
      });
      // A patch that does not mention recurrence must not clear it (the
      // `.default(null)`-under-`.partial()` trap this field's `.optional()` avoids).
      const patched = updateTrigger(db, created.id, { name: 'Renamed' });
      expect(patched!.name).toBe('Renamed');
      expect(patched!.recurrence?.frequency).toBe('day');
      expect(patched!.schedule).toBe('0 9 * * *');
    });
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
