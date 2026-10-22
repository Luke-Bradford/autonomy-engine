import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { LOOKUP_ROW_CAP, SCRIPT_ACTIVITY_TYPE, WARNING_CODES } from '@autonomy-studio/shared';
import { sqliteAdapter } from '../sqlite.js';
import { cleanupTempRoots, seedDb, tempRoot, writableConfig } from './sqlite-fixtures.js';
import type { ActivityContext, ActivityEvent } from '../types.js';

/**
 * #1600 OR41 C10a — the Script activity on SQLite, against real database files:
 * the blocks run in order, a Query's rows become a result set, a Non-query's
 * changes are counted, *Run as one transaction* is all or nothing, and the
 * statement allow-list and the `writable` gate refuse before anything runs.
 */

afterEach(cleanupTempRoots);

type Block = { type: 'query' | 'nonQuery'; sql: string; parameters?: Record<string, unknown> };

function scriptCtx(
  connectionConfig: Record<string, unknown>,
  blocks: Block[],
  over: { runAsOneTransaction?: boolean; captureResultSets?: string; signal?: AbortSignal } = {},
): ActivityContext {
  const { signal, ...settings } = over;
  return {
    runId: 'run-1',
    nodeId: 'n1',
    attemptId: 'a1',
    activityType: SCRIPT_ACTIVITY_TYPE,
    input: { blocks, ...settings },
    connectionConfig,
    signal: signal ?? new AbortController().signal,
  } as unknown as ActivityContext;
}

async function run(ctx: ActivityContext): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = [];
  for await (const event of sqliteAdapter.runActivity(ctx, null)) events.push(event);
  return events;
}

const terminal = (events: ActivityEvent[]): ActivityEvent => events[events.length - 1]!;

function outputsOf(events: ActivityEvent[]): Record<string, unknown> {
  const end = terminal(events);
  expect(end).toMatchObject({ type: 'succeeded' });
  return end.type === 'succeeded' ? end.outputs : {};
}

function failureOf(events: ActivityEvent[]): { kind: string; error: string } {
  const end = terminal(events) as unknown as { type: string; kind: string; error: string };
  expect(end.type).toBe('failed');
  return end;
}

function count(path: string, sql = 'select count(*) as n from t'): number {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare(sql).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function store(rows = 3): { root: string; path: string } {
  const root = tempRoot('script-');
  return { root, path: seedDb(root, rows) };
}

describe('Script on SQLite (C10a)', () => {
  it('runs Query and Non-query blocks in order, with bind values', async () => {
    const { root, path } = store(3);
    const events = await run(
      scriptCtx(writableConfig(root, path), [
        {
          type: 'nonQuery',
          sql: 'insert into t (id, name) values (:id, :name)',
          parameters: { id: 10, name: 'ten' },
        },
        { type: 'nonQuery', sql: "update t set name = 'x' where id <= 2" },
        {
          type: 'query',
          sql: 'select id, name from t where id >= :min order by id',
          parameters: { min: 3 },
        },
        { type: 'query', sql: 'select count(*) as n from t' },
      ]),
    );
    expect(outputsOf(events)).toEqual({
      resultSetCount: 2,
      resultSets: [
        {
          rowCount: 2,
          rows: [
            { id: 3, name: 'row-3' },
            { id: 10, name: 'ten' },
          ],
        },
        { rowCount: 1, rows: [{ n: 4 }] },
      ],
      recordsAffected: 3,
      outputParameters: {},
      truncated: false,
    });
    expect(count(path)).toBe(4);
  });

  it('runs a script of Query blocks only on a connection that is not writable', async () => {
    const { root, path } = store(2);
    const events = await run(
      scriptCtx({ roots: [root], path }, [{ type: 'query', sql: 'select id from t' }]),
    );
    expect(outputsOf(events)['resultSets']).toEqual([
      { rowCount: 2, rows: [{ id: 1 }, { id: 2 }] },
    ]);
  });

  it('refuses a Non-query block on a connection that is not writable, before anything runs', async () => {
    const { root, path } = store(2);
    const events = await run(
      scriptCtx({ roots: [root], path }, [
        { type: 'query', sql: 'select 1' },
        { type: 'nonQuery', sql: 'delete from t' },
      ]),
    );
    expect(failureOf(events)).toMatchObject({
      kind: 'permanent',
      error: expect.stringMatching(/not marked `writable`, so Script block 2, a Non-query block/),
    });
    expect(count(path)).toBe(2);
  });

  it('refuses a writing statement written as a Query in a script with no Non-query block', async () => {
    const { root, path } = store(2);
    const events = await run(
      scriptCtx(writableConfig(root, path), [
        { type: 'query', sql: 'select 1 as one' },
        { type: 'query', sql: "insert into t (name) values ('x') returning id" },
      ]),
    );
    expect(failureOf(events).error).toMatch(/Script block 2 writes to the store/);
    expect(count(path)).toBe(2);
  });

  it('refuses ATTACH, PRAGMA, VACUUM and transaction control before any block runs', async () => {
    const { root, path } = store(2);
    for (const sql of [
      `attach database '${join(root, 'other.db')}' as other`,
      'pragma journal_mode = delete',
      'vacuum',
      'commit',
      'begin',
    ]) {
      const events = await run(
        scriptCtx(writableConfig(root, path), [
          { type: 'nonQuery', sql: 'delete from t' },
          { type: 'nonQuery', sql },
        ]),
      );
      expect(failureOf(events)).toMatchObject({
        kind: 'permanent',
        error: expect.stringMatching(/a Script block on SQLite may not run/),
      });
    }
    expect(count(path)).toBe(2);
  });

  it('refuses a :name with no value, naming the block', async () => {
    const { root, path } = store(1);
    const events = await run(
      scriptCtx(writableConfig(root, path), [
        { type: 'query', sql: 'select * from t where id = :id' },
      ]),
    );
    expect(failureOf(events).error).toBe(
      "Script block 1 binds 'id' with no value in its Parameters",
    );
  });

  it('refuses a Query whose statement returns no rows', async () => {
    const { root, path } = store(1);
    const events = await run(
      scriptCtx(writableConfig(root, path), [{ type: 'query', sql: 'create table u (a)' }]),
    );
    expect(failureOf(events).error).toMatch(
      /Script block 1 is a Query, but its statement returns no rows/,
    );
  });

  it('refuses two statements in one block', async () => {
    const { root, path } = store(1);
    const events = await run(
      scriptCtx(writableConfig(root, path), [
        { type: 'nonQuery', sql: 'delete from t; delete from t' },
      ]),
    );
    expect(failureOf(events).error).toMatch(
      /Script block 1 could not be prepared: .*more than one statement/,
    );
    expect(count(path)).toBe(1);
  });

  it('Run as one transaction undoes every block when a later one fails', async () => {
    const { root, path } = store(2);
    const events = await run(
      scriptCtx(
        writableConfig(root, path),
        [
          { type: 'nonQuery', sql: 'delete from t' },
          { type: 'nonQuery', sql: 'insert into missing values (1)' },
        ],
        { runAsOneTransaction: true },
      ),
    );
    expect(failureOf(events)).toMatchObject({
      kind: 'permanent',
      error: expect.stringMatching(
        /^Script block 2 could not be prepared: no such table: missing$/,
      ),
    });
    expect(count(path)).toBe(2);
  });

  it('Run as one transaction rolls back a Query block that fails mid-scan', async () => {
    const { root, path } = store(1);
    const db = new Database(path);
    db.exec("create table j (v text); insert into j values ('[1]'), ('not json')");
    db.close();
    const events = await run(
      scriptCtx(
        writableConfig(root, path),
        [
          { type: 'nonQuery', sql: 'delete from t' },
          { type: 'query', sql: "select json_extract(v, '$[0]') as x from j" },
        ],
        { runAsOneTransaction: true },
      ),
    );
    expect(failureOf(events).error).toMatch(/^Script block 2 failed: malformed JSON$/);
    expect(count(path)).toBe(1);
  });

  it('without one transaction, an earlier block stays applied and the failure is not retried', async () => {
    const { root, path } = store(2);
    const db = new Database(path);
    db.exec('create table k (id integer primary key)');
    db.close();
    const events = await run(
      scriptCtx(writableConfig(root, path), [
        { type: 'nonQuery', sql: 'delete from t' },
        { type: 'nonQuery', sql: 'insert into k values (1), (1)' },
      ]),
    );
    expect(failureOf(events)).toMatchObject({
      kind: 'permanent',
      error: expect.stringMatching(
        /^Script block 2 failed: UNIQUE constraint failed: k\.id — 1 earlier block\(s\) had already changed the store/,
      ),
    });
    expect(count(path)).toBe(0);
  });

  it('keeps the first 1000 rows of a result set, counts them all, and warns', async () => {
    const { root, path } = store(LOOKUP_ROW_CAP + 5);
    const events = await run(
      scriptCtx({ roots: [root], path }, [{ type: 'query', sql: 'select id from t' }]),
    );
    const outputs = outputsOf(events);
    const [set] = outputs['resultSets'] as { rowCount: number; rows: unknown[] }[];
    expect(set!.rowCount).toBe(LOOKUP_ROW_CAP + 5);
    expect(set!.rows).toHaveLength(LOOKUP_ROW_CAP);
    expect(outputs['truncated']).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'warned', code: WARNING_CODES.SCRIPT_RESULT_TRUNCATED }),
    );
  });

  it('Capture result sets Off keeps no rows but still counts them', async () => {
    const { root, path } = store(3);
    const events = await run(
      scriptCtx({ roots: [root], path }, [{ type: 'query', sql: 'select id from t' }], {
        captureResultSets: 'off',
      }),
    );
    const outputs = outputsOf(events);
    expect(outputs['resultSets']).toEqual([{ rowCount: 3, rows: [] }]);
    expect(outputs['truncated']).toBe(false);
  });

  it('keeps integers past 2^53 exact', async () => {
    const { root, path } = store(0);
    const events = await run(
      scriptCtx({ roots: [root], path }, [
        { type: 'query', sql: 'select 9007199254740993 as big' },
      ]),
    );
    const [set] = outputsOf(events)['resultSets'] as { rows: { big: unknown }[] }[];
    expect(String(set!.rows[0]!.big)).toBe('9007199254740993');
  });

  it('stops between blocks once cancelled', async () => {
    const { root, path } = store(2);
    const controller = new AbortController();
    controller.abort();
    const events = await run(
      scriptCtx(writableConfig(root, path), [{ type: 'nonQuery', sql: 'delete from t' }], {
        signal: controller.signal,
      }),
    );
    expect(failureOf(events).kind).toBe('cancelled');
    expect(count(path)).toBe(2);
  });
});
