import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { runs } from '../../db/schema.js';
import { CATALOG_VERSION } from '@autonomy-studio/shared';
import { createPipelineVersion } from '../pipeline-versions.js';
import { createPipeline } from '../pipelines.js';
import { createRun, listRunSummariesPage, RUN_DESCENDANTS_MAX } from '../runs.js';
import { createTrigger } from '../triggers.js';
import { freshDb } from './helpers.js';
import { makeRunActivityFold } from '../../run/activity-counts.js';
import { makeDocResolver } from '../../run/driver.js';

/**
 * #1484 OR35 M1 — "Include child runs": the runs list returns, beside its page,
 * every run the page's runs called (and those called in turn), so a trigger
 * filter shows everything that trigger caused. Children are created with
 * `triggerId: null`, so the filter alone drops them.
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
  triggerId: string | null = null,
): string {
  return createRun(db, {
    ownerId,
    pipelineVersionId: versionId,
    triggerId,
    parentRunId,
    params: {},
  }).id;
}

function page(
  db: TestDb,
  filter: Parameters<typeof listRunSummariesPage>[1],
  args: Partial<Parameters<typeof listRunSummariesPage>[2]> = {},
) {
  const fold = makeRunActivityFold(makeDocResolver(db));
  return listRunSummariesPage(db, filter, { limit: 100, ...args }, fold);
}

/** A three-level call chain under one triggered root. */
function chain(db: TestDb) {
  const v = versionOf(db, 'local', 'Orchestrator');
  const trigger = createTrigger(db, {
    ownerId: 'local',
    name: 'hourly',
    pipelineVersionId: v,
    params: {},
    mode: 'schedule',
    schedule: '0 * * * *',
    webhook: null,
    concurrency: { policy: 'skip_if_running' },
    runWindows: null,
    enabled: true,
  });
  const root = run(db, 'local', v, null, trigger.id);
  const child = run(db, 'local', versionOf(db, 'local', 'Ingest'), root);
  const sibling = run(db, 'local', versionOf(db, 'local', 'Clean'), root);
  const grandchild = run(db, 'local', versionOf(db, 'local', 'Load'), child);
  return { triggerId: trigger.id, root, child, sibling, grandchild };
}

describe('listRunSummariesPage includeChildren (#1484)', () => {
  it("returns everything a trigger's run caused, though only the root carries the trigger", () => {
    const { db } = freshDb();
    const c = chain(db);
    const result = page(db, { ownerId: 'local', triggerId: c.triggerId }, { includeChildren: true });
    expect(result.items.map((r) => r.id)).toEqual([c.root]);
    expect(new Set(result.descendants?.map((r) => r.id))).toEqual(
      new Set([c.child, c.sibling, c.grandchild]),
    );
    // Full summaries, built by the page's own path: names, kind and parent name.
    const child = result.descendants?.find((r) => r.id === c.child);
    expect(child).toMatchObject({
      pipelineName: 'Ingest',
      triggeredByKind: 'call',
      parentRunId: c.root,
      parentPipelineName: 'Orchestrator',
    });
  });

  it('orders the shallowest first and never repeats a run already on the page', () => {
    const { db } = freshDb();
    const c = chain(db);
    // No filter: the page already holds every run, children included.
    const all = page(db, { ownerId: 'local' }, { includeChildren: true });
    expect(all.items).toHaveLength(4);
    expect(all.descendants).toEqual([]);
    // A page holding the root and one child, but not the sibling or grandchild:
    // the grandchild is reachable twice — through the root and through the child —
    // and the child is itself a descendant of the root. Each comes back once, and
    // nothing on the page comes back at all.
    const at = (id: string, startedAt: number) =>
      db.update(runs).set({ startedAt }).where(eq(runs.id, id)).run();
    at(c.root, 4000);
    at(c.child, 3000);
    at(c.sibling, 2000);
    at(c.grandchild, 1000);
    const narrow = page(db, { ownerId: 'local' }, { includeChildren: true, limit: 2 });
    expect(narrow.items.map((r) => r.id)).toEqual([c.root, c.child]);
    expect(narrow.descendants?.map((r) => r.id)).toEqual([c.grandchild, c.sibling]);
    expect(narrow.nextCursor).toBe(page(db, { ownerId: 'local' }, { limit: 2 }).nextCursor);
  });

  it('is absent unless asked for, and the cursor does not depend on it', () => {
    const { db } = freshDb();
    const c = chain(db);
    const plain = page(db, { ownerId: 'local', triggerId: c.triggerId });
    expect(plain).not.toHaveProperty('descendants');
    const withChildren = page(db, { ownerId: 'local' }, { includeChildren: true, limit: 1 });
    expect(withChildren.nextCursor).toBe(page(db, { ownerId: 'local' }, { limit: 1 }).nextCursor);
  });

  it("never follows a parent link into another owner's runs", () => {
    const { db } = freshDb();
    const mine = run(db, 'local', versionOf(db, 'local', 'Mine'), null);
    // A foreign row whose parent id names my run (not creatable through the app,
    // which copies the parent's owner — so this is the second lock on the door).
    run(db, 'other', versionOf(db, 'other', 'Secret plan'), mine);
    const result = page(db, { ownerId: 'local' }, { includeChildren: true });
    expect(result.descendants).toEqual([]);
    expect(result.items.find((r) => r.id === mine)?.childRunCount).toBe(0);
  });

  it(`stops the walk at ${RUN_DESCENDANTS_MAX} runs, shallowest first`, () => {
    const { db } = freshDb();
    const rootVersion = versionOf(db, 'local', 'Fan out');
    const v = versionOf(db, 'local', 'Per item');
    const root = run(db, 'local', rootVersion, null);
    const children = Array.from({ length: RUN_DESCENDANTS_MAX + 5 }, () =>
      run(db, 'local', v, root),
    );
    run(db, 'local', v, children[0]!); // a grandchild, deeper than every child
    const result = page(
      db,
      { ownerId: 'local', pipelineVersionId: rootVersion },
      { includeChildren: true },
    );
    expect(result.items.map((r) => r.id)).toEqual([root]);
    expect(result.descendants).toHaveLength(RUN_DESCENDANTS_MAX);
    expect(result.descendants?.every((r) => r.parentRunId === root)).toBe(true);
    expect(result.items[0]?.childRunCount).toBe(RUN_DESCENDANTS_MAX + 5);
  });
});

describe('RunSummary.childRunCount (#1484)', () => {
  it('counts direct children only, on page rows and descendants alike, filter or no filter', () => {
    const { db } = freshDb();
    const c = chain(db);
    const result = page(db, { ownerId: 'local', triggerId: c.triggerId }, { includeChildren: true });
    const count = (id: string) =>
      [...result.items, ...(result.descendants ?? [])].find((r) => r.id === id)?.childRunCount;
    expect(count(c.root)).toBe(2);
    expect(count(c.child)).toBe(1);
    expect(count(c.sibling)).toBe(0);
    expect(count(c.grandchild)).toBe(0);
  });

});
