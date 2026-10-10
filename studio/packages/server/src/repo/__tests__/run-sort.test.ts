import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  CATALOG_VERSION,
  RUN_SORT_KEYS,
  RUN_STATUS_SORT_RANK,
  RUN_TRIGGERED_BY_SORT_RANK,
  type NewRun,
  type RunStatus,
  type RunSummary,
} from '@autonomy-studio/shared';
import { runs } from '../../db/schema.js';
import { createPipelineVersion } from '../pipeline-versions.js';
import { createPipeline } from '../pipelines.js';
import { createRun, listRunSummariesPage } from '../runs.js';
import { createTrigger } from '../triggers.js';
import { decodeRunCursor, encodeRunCursor, type RunCursor, type RunSort } from '../run-sort.js';
import { encodeCursor, encodeCursorPayload } from '../pagination.js';
import { freshDb } from './helpers.js';
import { makeRunActivityFold } from '../../run/activity-counts.js';
import { makeDocResolver } from '../../run/driver.js';

/**
 * #1484 OR35 M1 slice 4 — the runs grid's server-side sort. Every sort is walked
 * page by page through the real cursor codec and must reproduce, row for row,
 * the order an independent TypeScript oracle computes from the fixture: the
 * column's own order, unfinished runs last on Duration, newest first inside a
 * tie, then `id`.
 */
type TestDb = ReturnType<typeof freshDb>['db'];

const fold = (db: TestDb) => makeRunActivityFold(makeDocResolver(db));

function versionOf(db: TestDb, name: string): string {
  const pipeline = createPipeline(db, { ownerId: 'local', name });
  return createPipelineVersion(db, {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes: [],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  }).id;
}

interface Shape {
  version: string;
  started: number;
  finished: number | null;
  status: RunStatus;
  extra?: Partial<NewRun>;
}

function seed(db: TestDb) {
  const alpha = versionOf(db, 'alpha');
  const beta = versionOf(db, 'Beta');
  const gamma = versionOf(db, 'gamma');
  const trigger = createTrigger(db, {
    ownerId: 'local',
    name: 'T',
    pipelineVersionId: alpha,
    params: {},
    mode: 'manual',
    schedule: null,
    webhook: null,
    concurrency: { policy: 'skip_if_running' },
    runWindows: null,
    enabled: false,
  }).id;
  const make = (s: Shape) => {
    const id = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: s.version,
      triggerId: null,
      parentRunId: null,
      params: {},
      ...s.extra,
    }).id;
    db.update(runs)
      .set({ startedAt: s.started, finishedAt: s.finished, status: s.status })
      .where(eq(runs.id, id))
      .run();
    return id;
  };
  const first = make({ version: alpha, started: 1000, finished: 1500, status: 'success' });
  // Ties on purpose: two runs share a started_at, two share a duration, two a
  // status, two a pipeline, so every secondary term is exercised.
  make({ version: beta, started: 2000, finished: 2500, status: 'failure' });
  make({ version: beta, started: 2000, finished: null, status: 'running' });
  make({ version: gamma, started: 3000, finished: 3100, status: 'success' });
  make({
    version: alpha,
    started: 4000,
    finished: 9000,
    status: 'failure',
    extra: { rerunOf: first },
  });
  make({
    version: gamma,
    started: 5000,
    finished: null,
    status: 'queued',
    extra: {
      triggerId: trigger,
      triggerContext: {
        triggerId: trigger,
        scheduledTime: '2026-10-01T00:00:00.000Z',
        body: null,
        fireKind: 'schedule',
      },
    },
  });
  make({
    version: alpha,
    started: 6000,
    finished: 6500,
    status: 'cancelled',
    extra: { triggerId: trigger },
  });
  // An Execute pipeline child: slug `call` (first A–Z) but label "Execute
  // pipeline", which reads AFTER "Editor run".
  make({
    version: gamma,
    started: 7000,
    finished: 7200,
    status: 'success',
    extra: { parentRunId: first },
  });
}

/** Every row through one page — the order the walk must reproduce. */
function onePage(db: TestDb, sort: RunSort): RunSummary[] {
  return listRunSummariesPage(db, { ownerId: 'local' }, { limit: 100, sort }, fold(db)).items;
}

/** Follows `nextCursor` to the end through the wire codec, as a client does. */
function walk(db: TestDb, sort: RunSort, limit: number): string[] {
  const seen: string[] = [];
  let cursor: RunCursor | undefined;
  for (let pages = 0; pages < 20; pages += 1) {
    const page = listRunSummariesPage(db, { ownerId: 'local' }, { limit, sort, cursor }, fold(db));
    seen.push(...page.items.map((r) => r.id));
    if (page.nextCursor === null) return seen;
    const next = decodeRunCursor(page.nextCursor, sort);
    expect(next).not.toBeNull();
    cursor = next ?? undefined;
  }
  throw new Error('the walk did not end');
}

type Key = (string | number)[];
const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

/** The oracle: each run's key terms and their directions, per the issue. */
function oracleKey(r: RunSummary, sort: RunSort): { key: Key; dirs: ('asc' | 'desc')[] } {
  const newest = { v: r.startedAt, d: 'desc' as const };
  const terms = (() => {
    switch (sort.key) {
      case 'started':
        return [{ v: r.startedAt, d: sort.dir }];
      case 'duration':
        return [
          { v: r.finishedAt === null ? 1 : 0, d: 'asc' as const },
          { v: r.finishedAt === null ? 0 : r.finishedAt - r.startedAt, d: sort.dir },
          newest,
        ];
      case 'pipeline':
        return [{ v: r.pipelineName.toLowerCase(), d: sort.dir }, newest];
      case 'status':
        return [{ v: RUN_STATUS_SORT_RANK[r.status], d: sort.dir }, newest];
      case 'triggeredBy':
        return [{ v: RUN_TRIGGERED_BY_SORT_RANK[r.triggeredByKind], d: sort.dir }, newest];
    }
  })();
  const last = terms[terms.length - 1]?.d ?? 'desc';
  return { key: [...terms.map((t) => t.v), r.id], dirs: [...terms.map((t) => t.d), last] };
}

function oracleOrder(rows: RunSummary[], sort: RunSort): string[] {
  return [...rows]
    .sort((a, b) => {
      const ka = oracleKey(a, sort);
      const kb = oracleKey(b, sort);
      for (let i = 0; i < ka.key.length; i += 1) {
        const c = cmp(ka.key[i] as string | number, kb.key[i] as string | number);
        if (c !== 0) return ka.dirs[i] === 'asc' ? c : -c;
      }
      return 0;
    })
    .map((r) => r.id);
}

const SORTS: RunSort[] = RUN_SORT_KEYS.flatMap((key) =>
  (['asc', 'desc'] as const).map((dir) => ({ key, dir })),
);

describe('#1484 — the runs list sorts server side, across every page', () => {
  for (const sort of SORTS) {
    it(`${sort.key} ${sort.dir}: one page, a walk of 2s and a walk of 3s all match the oracle`, () => {
      const { db } = freshDb();
      seed(db);
      const rows = onePage(db, sort);
      const expected = oracleOrder(rows, sort);
      expect(rows.map((r) => r.id)).toEqual(expected);
      expect(walk(db, sort, 2)).toEqual(expected);
      expect(walk(db, sort, 3)).toEqual(expected);
    });
  }

  it('keeps newest first as the default, exactly the order the list had before', () => {
    const { db } = freshDb();
    seed(db);
    const unsorted = listRunSummariesPage(db, { ownerId: 'local' }, { limit: 100 }, fold(db));
    const starts = unsorted.items.map((r) => r.startedAt);
    expect(starts).toEqual([...starts].sort((a, b) => b - a));
  });

  it('puts unfinished runs last on Duration in BOTH directions', () => {
    const { db } = freshDb();
    seed(db);
    for (const dir of ['asc', 'desc'] as const) {
      const finished = onePage(db, { key: 'duration', dir }).map((r) => r.finishedAt !== null);
      expect(finished).toEqual([true, true, true, true, true, true, false, false]);
    }
  });

  it('orders Status by rank and Triggered by by label, not by slug', () => {
    const { db } = freshDb();
    seed(db);
    expect(onePage(db, { key: 'status', dir: 'asc' }).map((r) => r.status)).toEqual([
      'failure',
      'failure',
      'cancelled',
      'running',
      'queued',
      'success',
      'success',
      'success',
    ]);
    // By label: "Editor run" < "Execute pipeline" < "Fire now" < "Rerun from
    // failed" < "Schedule". A slug sort would open on `call`.
    expect(onePage(db, { key: 'triggeredBy', dir: 'asc' }).map((r) => r.triggeredByKind)).toEqual([
      'editor',
      'editor',
      'editor',
      'editor',
      'call',
      'manual',
      'rerun',
      'schedule',
    ]);
  });

  it('sorts Pipeline without regard to case', () => {
    const { db } = freshDb();
    seed(db);
    const names = onePage(db, { key: 'pipeline', dir: 'asc' }).map((r) => r.pipelineName);
    expect([...new Set(names)]).toEqual(['alpha', 'Beta', 'gamma']);
  });
});

describe('#1484 — a runs cursor is bound to the sort that minted it', () => {
  const cursor = (sort: RunSort): RunCursor => ({ sort, values: [7, 1000], id: 'run_x' });

  it('round-trips under its own sort', () => {
    const sort: RunSort = { key: 'status', dir: 'asc' };
    expect(decodeRunCursor(encodeRunCursor(cursor(sort)), sort)).toEqual(cursor(sort));
  });

  it('refuses another key, another direction, a version-1 cursor and mistyped values', () => {
    const sort: RunSort = { key: 'status', dir: 'asc' };
    const raw = encodeRunCursor(cursor(sort));
    expect(decodeRunCursor(raw, { key: 'status', dir: 'desc' })).toBeNull();
    expect(decodeRunCursor(raw, { key: 'duration', dir: 'asc' })).toBeNull();
    expect(decodeRunCursor(encodeCursor({ createdAt: 1000, id: 'run_x' }), sort)).toBeNull();
    const payload = (k: unknown[]) =>
      encodeCursorPayload({ v: 2, s: 'status', d: 'asc', k, i: 'run_x' });
    expect(decodeRunCursor(payload(['7', 1000]), sort)).toBeNull();
    expect(decodeRunCursor(payload([7]), sort)).toBeNull();
    expect(decodeRunCursor(payload([7, 1000, 1]), sort)).toBeNull();
    expect(
      decodeRunCursor(
        encodeCursorPayload({ v: 2, s: 'pipeline', d: 'asc', k: [7, 1000], i: 'run_x' }),
        { key: 'pipeline', dir: 'asc' },
      ),
    ).toBeNull();
  });
});
