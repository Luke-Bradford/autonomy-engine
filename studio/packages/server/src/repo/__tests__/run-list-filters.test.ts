import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { CATALOG_VERSION, type NewRun } from '@autonomy-studio/shared';
import { runs } from '../../db/schema.js';
import { appendRunEvent } from '../run-events.js';
import { createPipelineVersion } from '../pipeline-versions.js';
import { createPipeline } from '../pipelines.js';
import { createRun, listRunSummariesPage, type ListRunSummariesFilter } from '../runs.js';
import { createTrigger } from '../triggers.js';
import { decodeCursor, type CursorKey } from '../pagination.js';
import { freshDb } from './helpers.js';
import { makeRunActivityFold } from '../../run/activity-counts.js';
import { makeDocResolver } from '../../run/driver.js';

/** #1484 — the real Activities fold, as the runs route builds it. */
const testFold = (db: Parameters<typeof makeDocResolver>[0]) =>
  makeRunActivityFold(makeDocResolver(db));

/**
 * #1484 OR35 M1 slice 2 — the runs list's one-row filter bar, server side: the
 * "Triggered by" kind axis, the absolute day bounds and the search box. Each axis
 * is asserted by what it EXCLUDES as well as what it keeps, and each is ANDed
 * with the owner scope — a foreign run that matches every axis never appears.
 */
type TestDb = ReturnType<typeof freshDb>['db'];

function versionOf(db: TestDb, name: string, ownerId = 'local'): string {
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

function run(db: TestDb, versionId: string, overrides: Partial<NewRun> = {}): string {
  return createRun(db, {
    ownerId: 'local',
    pipelineVersionId: versionId,
    triggerId: null,
    parentRunId: null,
    params: {},
    ...overrides,
  }).id;
}

function ids(db: TestDb, filter: Omit<ListRunSummariesFilter, 'ownerId'>, ownerId = 'local') {
  return listRunSummariesPage(db, { ...filter, ownerId }, { limit: 100 }, testFold(db)).items.map(
    (r) => r.id,
  );
}

function namedTrigger(db: TestDb, versionId: string, name: string): string {
  return createTrigger(db, {
    ownerId: 'local',
    name,
    pipelineVersionId: versionId,
    params: {},
    mode: 'manual',
    schedule: null,
    webhook: null,
    concurrency: { policy: 'skip_if_running' },
    runWindows: null,
    enabled: false,
  }).id;
}

describe('#1484 — the runs list kind axis', () => {
  it('keeps exactly the runs whose triggered-by kind is one of those asked for', () => {
    const { db } = freshDb();
    const v = versionOf(db, 'P');
    const t = namedTrigger(db, v, 'T');
    const scheduled = run(db, v, {
      triggerId: t,
      triggerContext: {
        triggerId: t,
        scheduledTime: '2026-10-01T00:00:00.000Z',
        body: null,
        fireKind: 'schedule',
      },
    });
    const fired = run(db, v, {
      triggerId: t,
      triggerContext: { triggerId: t, scheduledTime: null, body: null, fireKind: 'manual' },
    });
    const editor = run(db, v);

    expect(ids(db, { kinds: ['schedule'] })).toEqual([scheduled]);
    expect(ids(db, { kinds: ['manual', 'editor'] }).sort()).toEqual([fired, editor].sort());
    expect(ids(db, { kinds: ['call'] })).toEqual([]);
  });
});

describe('#1484 — the runs list absolute time bounds', () => {
  it('`startedAfter` is inclusive and `startedBefore` exclusive', () => {
    const { db } = freshDb();
    const v = versionOf(db, 'P');
    const at = (ms: number) => {
      const id = run(db, v);
      db.update(runs).set({ startedAt: ms }).where(eq(runs.id, id)).run();
      return id;
    };
    const before = at(999);
    const onFrom = at(1000);
    const inside = at(1500);
    const onTo = at(2000);

    expect(ids(db, { startedAfter: 1000, startedBefore: 2000 }).sort()).toEqual(
      [onFrom, inside].sort(),
    );
    expect(ids(db, { startedBefore: 1000 })).toEqual([before]);
    expect(ids(db, { startedAfter: 2000 })).toEqual([onTo]);
  });
});

describe('#1484 — the runs list search', () => {
  function seeded() {
    const { db } = freshDb();
    const orders = versionOf(db, 'Load Orders nightly');
    const other = versionOf(db, 'Something else');
    const trigger = namedTrigger(db, other, 'Hourly CRM sync');
    const byPipeline = run(db, orders);
    const byTrigger = run(db, other, {
      triggerId: trigger,
      triggerContext: { triggerId: trigger, scheduledTime: null, body: null, fireKind: 'manual' },
    });
    const byNodeError = run(db, other);
    appendRunEvent(db, {
      runId: byNodeError,
      type: 'node.failed',
      payload: {
        type: 'node.failed',
        runId: byNodeError,
        nodeId: 'n1',
        attemptId: 'a1',
        error: 'SQLITE_BUSY: Database Is Locked',
        kind: 'transient',
      },
    });
    const byRunReason = run(db, other);
    appendRunEvent(db, {
      runId: byRunReason,
      type: 'run.finished',
      payload: {
        type: 'run.finished',
        runId: byRunReason,
        outcome: 'failure',
        reason: 'cancelled by the operator',
      },
    });
    const unrelated = run(db, other);
    // Another owner's run that matches every search below. It must never appear.
    const foreign = run(db, versionOf(db, 'Load Orders nightly', 'someone-else'), {
      ownerId: 'someone-else',
    });
    return { db, byPipeline, byTrigger, byNodeError, byRunReason, unrelated, foreign };
  }

  it('matches a pipeline name or a trigger name, case-insensitively', () => {
    const s = seeded();
    expect(ids(s.db, { search: 'orders' })).toEqual([s.byPipeline]);
    expect(ids(s.db, { search: 'crm SYNC' })).toEqual([s.byTrigger]);
  });

  it("matches a failure's error text, and a run's finishing reason", () => {
    const s = seeded();
    expect(ids(s.db, { search: 'database is locked' })).toEqual([s.byNodeError]);
    expect(ids(s.db, { search: 'cancelled by' })).toEqual([s.byRunReason]);
  });

  it('reads only failure text: the same words in any other event never match', () => {
    const s = seeded();
    appendRunEvent(s.db, {
      runId: s.unrelated,
      type: 'node.output',
      payload: {
        type: 'node.output',
        runId: s.unrelated,
        nodeId: 'n1',
        name: 'log',
        value: 'database is locked',
      },
    });
    expect(ids(s.db, { search: 'database is locked' })).toEqual([s.byNodeError]);
  });

  it('matches any part of a run id, so the tail the grid draws finds the run', () => {
    const s = seeded();
    expect(ids(s.db, { search: s.unrelated.slice(-8) })).toEqual([s.unrelated]);
    expect(ids(s.db, { search: s.unrelated.slice(0, 12) })).toEqual([s.unrelated]);
  });

  it('treats LIKE wildcards as literal text', () => {
    const s = seeded();
    expect(ids(s.db, { search: '%' })).toEqual([]);
    // Every id holds `run_`, so a literal `_` matches every run of this owner.
    expect(ids(s.db, { search: '_' }).length).toBe(ids(s.db, {}).length);
    expect(ids(s.db, { search: 'Load_Orders' })).toEqual([]);
  });

  it("never reaches past the owner scope, though the other owner's run matches", () => {
    const s = seeded();
    expect(ids(s.db, { search: 'orders' })).not.toContain(s.foreign);
    expect(ids(s.db, { search: 'orders' }, 'someone-else')).toEqual([s.foreign]);
  });

  it('a keyset walk stays inside the searched set from the first page to the last', () => {
    const s = seeded();
    const v = versionOf(s.db, 'Paged orders');
    const matching = [run(s.db, v), run(s.db, v), run(s.db, v)];
    const filter = { ownerId: 'local', search: 'orders' };
    const walked: string[] = [];
    let cursor: CursorKey | undefined;
    do {
      const page = listRunSummariesPage(s.db, filter, { limit: 1, cursor }, testFold(s.db));
      walked.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor === null ? undefined : (decodeCursor(page.nextCursor) ?? undefined);
    } while (cursor !== undefined);
    expect(walked.sort()).toEqual([...matching, s.byPipeline].sort());
  });
});
