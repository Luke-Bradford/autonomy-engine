import Database from 'better-sqlite3';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CATALOG_VERSION, LOOKUP_ACTIVITY_TYPE } from '@autonomy-studio/shared';
import { appendEngineEvent, loadEngineEvents } from '../../run/events.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun } from '../../repo/runs.js';
import { runLookupActivity } from '../lookup.js';
import { sqliteAdapter } from '../sqlite.js';
import { cleanupTempRoots, seedDb, tempRoot, writableConfig } from './sqlite-fixtures.js';
import type { SourceIo } from '../source-io.js';
import type { ActivityContext, ActivityEvent } from '../types.js';

/**
 * #996 M12 slice 2 (#1221) — `lookup` against a REAL store, and against the
 * REAL run log.
 *
 * `lookup-activity.test.ts` drives a fake reader, which is the right layer for
 * the caps and the normalisation rules. Two claims are not provable there and
 * are the whole reason this file exists:
 *
 *  1. the adapter arm actually dispatches — a catalog entry with no reachable
 *     run path is a node an operator can drop and cannot run;
 *  2. the outputs survive the DURABLE log. That is the claim the normaliser was
 *     built for, and a `JSON.parse(JSON.stringify(...))` in a unit test only
 *     approximates it: the live path is `appendEngineEvent` → `EngineEventSchema`
 *     → drizzle's `text(..., { mode: 'json' })` insert → `loadEngineEvents`, and a
 *     value that slips the normaliser throws INSIDE the insert transaction,
 *     rolls the append back, and ends the whole run `interrupted` with the
 *     `node.succeeded` fact lost. Nothing on that path would report it as a
 *     lookup bug, which is exactly why it is asserted here.
 */

afterEach(cleanupTempRoots);

function lookupCtx(root: string, path: string, table = 't'): ActivityContext {
  return {
    runId: 'run-1',
    nodeId: 'n1',
    attemptId: 'a1',
    activityType: LOOKUP_ACTIVITY_TYPE,
    input: {},
    connectionConfig: writableConfig(root, path),
    datasets: {
      source: { id: 'ds-1', name: 'src', kind: 'table', config: { table }, columns: [] },
    },
    signal: new AbortController().signal,
  } as unknown as ActivityContext;
}

async function run(ctx: ActivityContext): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = [];
  for await (const event of sqliteAdapter.runActivity(ctx, null)) events.push(event);
  return events;
}

const outputsOf = (events: ActivityEvent[]): Record<string, unknown> => {
  const end = events[events.length - 1] as ActivityEvent;
  expect(end.type, end.type === 'failed' ? end.error : '').toBe('succeeded');
  return end.type === 'succeeded' ? end.outputs : {};
};

describe('the sqlite adapter dispatches a lookup', () => {
  it('reads a real table into `rows`', async () => {
    const root = tempRoot();
    const out = outputsOf(await run(lookupCtx(root, seedDb(root, 3, 'src.db'))));

    expect(out.rows).toEqual([
      { id: 1, name: 'row-1' },
      { id: 2, name: 'row-2' },
      { id: 3, name: 'row-3' },
    ]);
    expect(out.rowCount).toBe(3);
    expect(out.truncated).toBe(false);
    expect(out.bytes as number).toBeGreaterThan(0);
  });

  it('normalises the two sqlite value types JSON cannot hold', async () => {
    // Both are genuinely reachable from this store and from no fake: `sqlite.ts`
    // opens with `defaultSafeIntegers(true)` and KEEPS a bigint past
    // `Number.MAX_SAFE_INTEGER`, and a BLOB column arrives as a `Uint8Array`.
    const root = tempRoot();
    const path = join(root, 'wide.db');
    const db = new Database(path);
    db.exec('CREATE TABLE t (id INTEGER, big INTEGER, blob BLOB)');
    db.prepare('INSERT INTO t VALUES (?, ?, ?)').run(1, 9007199254740993n, Buffer.from([1, 2, 3]));
    db.close();

    const out = outputsOf(await run(lookupCtx(root, 'wide.db')));
    expect(out.rows).toEqual([{ id: 1, big: '9007199254740993', blob: 'AQID' }]);
  });

  it('refuses an activity a store connection does not run', async () => {
    const root = tempRoot();
    const ctx = { ...lookupCtx(root, seedDb(root, 1, 'src.db')), activityType: 'file_read' };
    const end = (await run(ctx as ActivityContext)).at(-1) as ActivityEvent;
    expect(end.type).toBe('failed');
  });
});

describe('the outputs survive the durable run log', () => {
  it('round-trips through appendEngineEvent -> loadEngineEvents as a FIXED POINT', async () => {
    // Driven through a fake reader rather than the sqlite store above, and that
    // is the point of the fixture rather than a shortcut: sqlite can only yield
    // `string | number | bigint | Uint8Array | null`, none of which can
    // demonstrate the property this test uniquely owns.
    //
    // The byte measurement inside `runLookupActivity` calls `JSON.stringify` on
    // every row, so it is already a de-facto first line of defence: a value that
    // cannot serialise AT ALL fails the lookup before the log is ever reached
    // (measured — removing the bigint arm surfaces as `Do not know how to
    // serialize a BigInt` on the ACTIVITY, not on the insert). What that does
    // NOT catch is a value that serialises perfectly and comes back as something
    // else — a `Date` is the canonical one, stringifying to an ISO string and
    // reloading as a `string`. That is a silent disagreement between what a
    // downstream node in THIS run sees and what a reload of the run sees, and
    // this assertion is the only thing in the suite that runs the real
    // `EngineEventSchema` -> drizzle `JSON.stringify` -> `JSON.parse` path to
    // prove the outputs are a fixed point of it.
    const hostile: SourceIo = {
      sourceCoercion: () => ({}),
      async *readBatches() {
        yield [
          {
            when: new Date('2026-01-02T03:04:05.000Z'),
            big: BigInt('9007199254740993'),
            blob: new Uint8Array([255, 0, 128]),
            nan: Number.NaN,
            doc: { a: [1, null, 'x'], nested: { d: new Date(0) } },
            txt: 'h\u00e9llo \ud83d\ude00',
            nil: null,
          },
        ];
      },
    };
    const events: ActivityEvent[] = [];
    for await (const event of runLookupActivity(lookupCtx(tempRoot(), 'unused.db'), hostile)) {
      events.push(event);
    }
    const outputs = outputsOf(events);

    // The REAL append path, against the real schema: `run_events.runId` is a
    // genuine FK, so the run has to exist. Nothing here is stubbed — the point
    // is to reach drizzle's `JSON.stringify` on insert and its `JSON.parse` on
    // read.
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    const pv = createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [{ id: 'n1', type: LOOKUP_ACTIVITY_TYPE, config: {}, position: { x: 0, y: 0 } }],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
    const runRow = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pv.id,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    appendEngineEvent(db, {
      type: 'node.succeeded',
      runId: runRow.id,
      nodeId: 'n1',
      attemptId: 'a1',
      outputs,
    });

    const loaded = loadEngineEvents(db, runRow.id);
    const succeeded = loaded.find((e) => e.type === 'node.succeeded');
    expect(succeeded?.type === 'node.succeeded' ? succeeded.outputs : null).toEqual(outputs);
  });
});
