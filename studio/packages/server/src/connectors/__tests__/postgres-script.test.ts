import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_POSTGRES_PORT,
  SCRIPT_ACTIVITY_TYPE,
  SCRIPT_RESULT_ROW_CAP,
  WARNING_CODES,
  scriptDispatchConfigSchema,
} from '@autonomy-studio/shared';
import { createPostgresAdapter } from '../postgres.js';
import {
  StreamedQuery,
  preparePostgresBlocks,
  runPostgresScript,
  type PostgresStatementStream,
  type PostgresStreamedResult,
} from '../postgres-script.js';
import type { PostgresClient, PostgresClientFactory } from '../postgres-session.js';
import { SCRIPT_POSTGRES_STATEMENTS } from '../script.js';
import type { ActivityContext, ActivityEvent } from '../types.js';

/**
 * #1600 OR41 C10b-1 — the Script activity on PostgreSQL. The first half drives
 * the script's logic through a recording client and an injected row stream, so
 * it runs without a server; the second runs it against a live postgres (CI's
 * service container), which is where the streaming and the server's own
 * refusals are proved.
 */

type Block = { type: 'query' | 'nonQuery'; sql: string; parameters?: Record<string, unknown> };

const SECRET = 's3cr3t-pw';

const CONNECTION = {
  host: 'db.invalid',
  database: 'd',
  user: 'u',
  sslmode: 'disable',
};

function scriptCtx(
  blocks: Block[],
  over: {
    runAsOneTransaction?: boolean;
    captureResultSets?: string;
    signal?: AbortSignal;
    connection?: Record<string, unknown>;
  } = {},
): ActivityContext {
  const { signal, connection, ...settings } = over;
  return {
    runId: 'run-1',
    nodeId: 'n1',
    attemptId: 'a1',
    activityType: SCRIPT_ACTIVITY_TYPE,
    input: { blocks, ...settings },
    connectionConfig: connection ?? { ...CONNECTION, writable: true },
    signal: signal ?? new AbortController().signal,
  } as unknown as ActivityContext;
}

/** A client that records every statement and answers transaction control. */
function recordingFactory(failOn: Record<string, Error> = {}): {
  factory: PostgresClientFactory;
  queries: string[];
  opened: () => number;
} {
  const queries: string[] = [];
  let opened = 0;
  const factory: PostgresClientFactory = () => {
    opened += 1;
    return {
      connect: () => Promise.resolve(),
      query: (sql) => {
        const text = typeof sql === 'string' ? sql : sql.text;
        queries.push(text);
        const err = failOn[text];
        return err === undefined ? Promise.resolve({ rows: [], fields: [] }) : Promise.reject(err);
      },
      end: () => Promise.resolve(),
    } satisfies PostgresClient;
  };
  return { factory, queries, opened: () => opened };
}

type Answer = { rows?: Record<string, unknown>[] } & Partial<PostgresStreamedResult>;

/** A row stream answering each block's SQL from `answers`: rows, a result, or a throw. */
function fakeStream(
  answers: Record<string, Answer | Error>,
  queries: string[],
): PostgresStatementStream {
  return (_client, statement, onRow) => {
    queries.push(statement.sql);
    const answer = answers[statement.sql] ?? {};
    if (answer instanceof Error) return Promise.reject(answer);
    for (const row of answer.rows ?? []) onRow(row);
    return Promise.resolve({
      hasFields: answer.hasFields ?? answer.rows !== undefined,
      command: answer.command ?? (answer.rows !== undefined ? 'SELECT' : null),
      rowCount: answer.rowCount ?? answer.rows?.length ?? null,
    });
  };
}

function pgError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

async function runFake(
  ctx: ActivityContext,
  answers: Record<string, Answer | Error> = {},
  failOn: Record<string, Error> = {},
): Promise<{ events: ActivityEvent[]; queries: string[]; opened: number }> {
  const { factory, queries, opened } = recordingFactory(failOn);
  const events: ActivityEvent[] = [];
  for await (const e of runPostgresScript(ctx, {
    createClient: factory,
    secret: SECRET,
    types: undefined,
    stream: fakeStream(answers, queries),
  })) {
    events.push(e);
  }
  return { events, queries, opened: opened() };
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

function config(blocks: Block[]) {
  return scriptDispatchConfigSchema.parse({ blocks });
}

describe('Script on PostgreSQL, the blocks checked before any session (C10b-1)', () => {
  it.each([
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
    'SAVEPOINT s',
    'SET TRANSACTION READ WRITE',
    'SET statement_timeout = 0',
    'RESET ALL',
    'COPY t FROM STDIN',
    'VACUUM t',
  ])('refuses a block beginning %s', (sql) => {
    const refusal = preparePostgresBlocks(config([{ type: 'nonQuery', sql }]));
    expect(refusal).toMatch(/^a Script block on PostgreSQL may not run /);
  });

  it.each(SCRIPT_POSTGRES_STATEMENTS)('accepts a block beginning %s', (keyword) => {
    const prepared = preparePostgresBlocks(config([{ type: 'query', sql: `${keyword} x` }]));
    expect(Array.isArray(prepared)).toBe(true);
  });

  it('rewrites :name to $n and names a block whose value is missing', () => {
    const prepared = preparePostgresBlocks(
      config([
        { type: 'query', sql: 'select * from t where a = :a and b = :a', parameters: { a: 1 } },
      ]),
    );
    expect(prepared).toEqual([
      {
        statement: { sql: 'select * from t where a = $1 and b = $1', values: [1] },
        mayCommitPartway: false,
      },
    ]);
    expect(
      preparePostgresBlocks(
        config([
          { type: 'query', sql: 'select 1' },
          { type: 'query', sql: 'select :b' },
        ]),
      ),
    ).toBe("Script block 2 binds 'b' with no value in its Parameters");
  });

  it('names the block that mixes a positional placeholder with named Parameters', () => {
    expect(
      preparePostgresBlocks(
        config([{ type: 'query', sql: 'select $1, :a', parameters: { a: 1 } }]),
      ),
    ).toMatch(/^Script block 1 uses a positional placeholder/);
  });

  it('opens no session when a later block is refused', async () => {
    const { events, opened } = await runFake(
      scriptCtx([
        { type: 'nonQuery', sql: 'insert into t values (1)' },
        { type: 'nonQuery', sql: 'commit' },
      ]),
    );
    expect(failureOf(events)).toMatchObject({ kind: 'permanent' });
    expect(opened).toBe(0);
  });

  it('refuses a Non-query block on a connection not marked writable, before any session', async () => {
    const { events, opened } = await runFake(
      scriptCtx(
        [
          { type: 'query', sql: 'select 1' },
          { type: 'nonQuery', sql: 'delete from t' },
        ],
        { connection: { ...CONNECTION } },
      ),
    );
    expect(failureOf(events)).toEqual({
      type: 'failed',
      kind: 'permanent',
      error:
        'this postgres connection is not marked `writable`, so Script block 2, a Non-query block, cannot run on it',
    });
    expect(opened).toBe(0);
  });

  it('is dispatched by the postgres adapter', async () => {
    const { factory, opened } = recordingFactory();
    const events: ActivityEvent[] = [];
    for await (const e of createPostgresAdapter(factory).runActivity(
      scriptCtx([{ type: 'nonQuery', sql: 'set role admin' }]),
      SECRET,
    )) {
      events.push(e);
    }
    expect(failureOf(events).error).toMatch(/^a Script block on PostgreSQL may not run SET/);
    expect(opened()).toBe(0);
  });
});

describe('Script on PostgreSQL, the run (C10b-1)', () => {
  it('runs a script of Query blocks inside one READ ONLY transaction, even with Run as one transaction off', async () => {
    const { events, queries } = await runFake(
      scriptCtx([
        { type: 'query', sql: 'select a from t where a > :min', parameters: { min: 1 } },
        { type: 'query', sql: 'select 2 as b' },
      ]),
      {
        'select a from t where a > $1': { rows: [{ a: 2 }, { a: 3 }] },
        'select 2 as b': { rows: [{ b: 2 }] },
      },
    );
    expect(outputsOf(events)).toEqual({
      resultSetCount: 2,
      resultSets: [
        { rowCount: 2, rows: [{ a: 2 }, { a: 3 }] },
        { rowCount: 1, rows: [{ b: 2 }] },
      ],
      recordsAffected: 0,
      outputParameters: {},
      truncated: false,
    });
    expect(queries).toEqual([
      "SET SESSION DateStyle = 'ISO, YMD'",
      'BEGIN READ ONLY',
      'select a from t where a > $1',
      'select 2 as b',
      'ROLLBACK',
    ]);
  });

  it('names the block when the server refuses a write in a read-only script', async () => {
    const { events, queries } = await runFake(
      scriptCtx([{ type: 'query', sql: 'insert into t values (1) returning a' }]),
      {
        'insert into t values (1) returning a': pgError(
          'cannot execute INSERT in a read-only transaction',
          '25006',
        ),
      },
    );
    expect(failureOf(events)).toMatchObject({
      kind: 'permanent',
      error:
        'Script block 1 writes to the store, which a script with no Non-query block may not; make it a Non-query block',
    });
    expect(queries.at(-1)).toBe('ROLLBACK');
  });

  it('sums the rows the Non-query blocks changed, never a SELECT', async () => {
    const { events, queries } = await runFake(
      scriptCtx([
        { type: 'nonQuery', sql: 'insert into t select 1' },
        { type: 'nonQuery', sql: 'update t set a = 2' },
        { type: 'nonQuery', sql: 'select pg_sleep(0)' },
        { type: 'nonQuery', sql: 'create table u (a int)' },
        { type: 'query', sql: 'delete from t returning a' },
      ]),
      {
        'insert into t select 1': { command: 'INSERT', rowCount: 3, hasFields: false },
        'update t set a = 2': { command: 'UPDATE', rowCount: 2, hasFields: false },
        'select pg_sleep(0)': { command: 'SELECT', rowCount: 1, hasFields: true },
        'create table u (a int)': { command: 'CREATE', rowCount: null, hasFields: false },
        'delete from t returning a': { rows: [{ a: 2 }], command: 'DELETE' },
      },
    );
    const outputs = outputsOf(events);
    expect(outputs['recordsAffected']).toBe(5);
    expect(outputs['resultSets']).toEqual([{ rowCount: 1, rows: [{ a: 2 }] }]);
    // Off: each block autocommits, so no transaction is opened.
    expect(queries).not.toContain('BEGIN');
  });

  it('refuses a Query block whose statement returns no rows', async () => {
    const { events } = await runFake(scriptCtx([{ type: 'query', sql: 'update t set a = 1' }]), {
      'update t set a = 1': { command: 'UPDATE', rowCount: 1, hasFields: false },
    });
    expect(failureOf(events).error).toBe(
      'Script block 1 is a Query, but its statement returns no rows; make it a Non-query block',
    );
  });

  it('keeps the first rows of a result set and counts them all', async () => {
    const rows = Array.from({ length: SCRIPT_RESULT_ROW_CAP + 5 }, (_, i) => ({ i }));
    const { events } = await runFake(scriptCtx([{ type: 'query', sql: 'select i' }]), {
      'select i': { rows },
    });
    expect(events[0]).toMatchObject({
      type: 'warned',
      code: WARNING_CODES.SCRIPT_RESULT_TRUNCATED,
    });
    const outputs = outputsOf(events);
    const [set] = outputs['resultSets'] as { rowCount: number; rows: unknown[] }[];
    expect(set!.rowCount).toBe(SCRIPT_RESULT_ROW_CAP + 5);
    expect(set!.rows).toHaveLength(SCRIPT_RESULT_ROW_CAP);
    expect(outputs['truncated']).toBe(true);
  });

  describe('outside a transaction, what a failure leaves applied', () => {
    const two: Block[] = [
      { type: 'nonQuery', sql: 'insert into t values (1)' },
      { type: 'nonQuery', sql: 'insert into t values (2)' },
    ];

    it('a refused block after an applied one is permanent and says so', async () => {
      const { events } = await runFake(scriptCtx(two), {
        'insert into t values (1)': { command: 'INSERT', rowCount: 1 },
        'insert into t values (2)': pgError('deadlock detected', '40P01'),
      });
      const failure = failureOf(events);
      expect(failure.kind).toBe('permanent');
      expect(failure.error).toMatch(
        /^Script block 2 failed: deadlock detected — 1 block\(s\) had already run outside a transaction/,
      );
    });

    it('a refused first block applied nothing, so its own kind stands', async () => {
      const { events } = await runFake(scriptCtx(two), {
        'insert into t values (1)': pgError('deadlock detected', '40P01'),
      });
      expect(failureOf(events)).toMatchObject({
        kind: 'transient',
        error: 'Script block 1 failed: deadlock detected',
      });
    });

    it('a failure with no SQLSTATE may have committed, so it is never retried', async () => {
      const { events } = await runFake(scriptCtx(two), {
        'insert into t values (1)': pgError('read ECONNRESET', 'ECONNRESET'),
      });
      const failure = failureOf(events);
      expect(failure.kind).toBe('permanent');
      expect(failure.error).toMatch(/1 block\(s\) had already run/);
    });

    it('a CALL may have committed partway, so it is never retried', async () => {
      const { events } = await runFake(scriptCtx([{ type: 'nonQuery', sql: 'call load()' }]), {
        'call load()': pgError('deadlock detected', '40P01'),
      });
      expect(failureOf(events).kind).toBe('permanent');
    });

    it('a cancel between blocks stays cancelled and names what stays applied', async () => {
      const controller = new AbortController();
      const { factory, queries } = recordingFactory();
      const events: ActivityEvent[] = [];
      const stream: PostgresStatementStream = (_c, statement) => {
        queries.push(statement.sql);
        controller.abort();
        return Promise.resolve({ hasFields: false, command: 'INSERT', rowCount: 1 });
      };
      for await (const e of runPostgresScript(scriptCtx(two, { signal: controller.signal }), {
        createClient: factory,
        secret: SECRET,
        types: undefined,
        stream,
      })) {
        events.push(e);
      }
      expect(failureOf(events)).toMatchObject({ kind: 'cancelled' });
      expect(failureOf(events).error).toMatch(/^script aborted — 1 block\(s\)/);
      expect(queries.filter((q) => q.startsWith('insert'))).toEqual(['insert into t values (1)']);
    });
  });

  describe('Run as one transaction', () => {
    const two: Block[] = [
      { type: 'nonQuery', sql: 'insert into t values (1)' },
      { type: 'nonQuery', sql: 'insert into t values (2)' },
    ];

    it('rolls every block back on a failure, which keeps its own kind', async () => {
      const { events, queries } = await runFake(scriptCtx(two, { runAsOneTransaction: true }), {
        'insert into t values (1)': { command: 'INSERT', rowCount: 1 },
        'insert into t values (2)': pgError('deadlock detected', '40P01'),
      });
      expect(failureOf(events)).toMatchObject({ kind: 'transient' });
      expect(queries.slice(1)).toEqual([
        'BEGIN',
        'insert into t values (1)',
        'insert into t values (2)',
        'ROLLBACK',
      ]);
    });

    it('commits once at the end', async () => {
      const { events, queries } = await runFake(scriptCtx(two, { runAsOneTransaction: true }), {
        'insert into t values (1)': { command: 'INSERT', rowCount: 1 },
        'insert into t values (2)': { command: 'INSERT', rowCount: 1 },
      });
      expect(outputsOf(events)['recordsAffected']).toBe(2);
      expect(queries.at(-1)).toBe('COMMIT');
    });

    it('reports a COMMIT whose outcome is unknown as permanent', async () => {
      const { events } = await runFake(
        scriptCtx(two, { runAsOneTransaction: true }),
        {
          'insert into t values (1)': { command: 'INSERT', rowCount: 1 },
          'insert into t values (2)': { command: 'INSERT', rowCount: 1 },
        },
        { COMMIT: new Error('Query read timeout') },
      );
      const failure = failureOf(events);
      expect(failure.kind).toBe('permanent');
      expect(failure.error).toMatch(/the COMMIT's outcome is unknown/);
    });
  });

  it('never puts the secret in a failure', async () => {
    const { events } = await runFake(scriptCtx([{ type: 'query', sql: 'select 1' }]), {
      'select 1': pgError(`password ${SECRET} rejected`, '28P01'),
    });
    expect(failureOf(events).error).not.toContain(SECRET);
  });
});

const LIVE_HOST = process.env.STUDIO_TEST_POSTGRES_HOST;

describe.skipIf(LIVE_HOST === undefined)('Script on a live postgres (C10b-1)', () => {
  const live = {
    host: LIVE_HOST ?? '',
    port: Number(process.env.STUDIO_TEST_POSTGRES_PORT ?? DEFAULT_POSTGRES_PORT),
    database: process.env.STUDIO_TEST_POSTGRES_DATABASE ?? 'postgres',
    user: process.env.STUDIO_TEST_POSTGRES_USER ?? 'postgres',
    sslmode: 'disable' as const,
    connectTimeoutMs: 5_000,
    writable: true,
  };
  const password = process.env.STUDIO_TEST_POSTGRES_PASSWORD ?? '';
  const realFactory: PostgresClientFactory = (options) =>
    new pg.Client(options) as unknown as PostgresClient;
  // Its own schema, so the suite neither collides with nor leaves anything in another's.
  const schema = `script_c10b_${String(process.pid)}`;

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ ...live, password });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  afterAll(() => admin((c) => c.query(`drop schema if exists ${schema} cascade`)));

  async function reset(): Promise<void> {
    await admin(async (c) => {
      await c.query(`drop schema if exists ${schema} cascade`);
      await c.query(`create schema ${schema}`);
      await c.query(`create table ${schema}.t (a int)`);
      await c.query(`insert into ${schema}.t values (1), (2), (3)`);
    });
  }

  async function count(): Promise<number> {
    return admin(async (c) => {
      const r = await c.query<{ n: string }>(`select count(*) as n from ${schema}.t`);
      return Number(r.rows[0]!.n);
    });
  }

  async function runLive(
    blocks: Block[],
    over: { runAsOneTransaction?: boolean; writable?: boolean } = {},
  ): Promise<ActivityEvent[]> {
    const { writable = true, ...settings } = over;
    const events: ActivityEvent[] = [];
    for await (const e of createPostgresAdapter(realFactory).runActivity(
      scriptCtx(blocks, { ...settings, connection: { ...live, writable } }),
      password,
    )) {
      events.push(e);
    }
    return events;
  }

  it('runs Query and Non-query blocks with bind values, and counts the rows changed', async () => {
    await reset();
    const events = await runLive([
      { type: 'nonQuery', sql: `insert into ${schema}.t values (:v), (:v)`, parameters: { v: 9 } },
      {
        type: 'query',
        sql: `select a from ${schema}.t where a >= :min order by a`,
        parameters: { min: 3 },
      },
      { type: 'nonQuery', sql: `delete from ${schema}.t where a = 1` },
    ]);
    expect(outputsOf(events)).toEqual({
      resultSetCount: 1,
      resultSets: [{ rowCount: 3, rows: [{ a: 3 }, { a: 9 }, { a: 9 }] }],
      recordsAffected: 3,
      outputParameters: {},
      truncated: false,
    });
    expect(await count()).toBe(4);
  });

  it('streams a result without keeping its rows (pg 8.23 accumulates them under a callback)', async () => {
    const c = new pg.Client({ ...live, password, query_timeout: 30_000 });
    await c.connect();
    try {
      let seen = 0;
      const kept = await new Promise<number>((resolve, reject) => {
        const query = new StreamedQuery(
          { text: 'select generate_series(1, 5000) as n' },
          undefined,
          (err: Error | null | undefined, result?: pg.QueryResult) =>
            err ? reject(err) : resolve(result?.rows.length ?? -1),
        );
        query.on('row', () => {
          seen += 1;
        });
        c.query(query);
      });
      expect(seen).toBe(5000);
      expect(kept).toBe(0);
    } finally {
      await c.end();
    }
  });

  it('reads INSERT … RETURNING, a data-modifying WITH and a CALL as Query blocks, which a cursor cannot', async () => {
    await reset();
    await admin((c) =>
      c.query(
        `create procedure ${schema}.p(inout a int, out b int) language plpgsql as $$ begin b := a * 2; a := a + 1; end $$`,
      ),
    );
    const events = await runLive([
      { type: 'nonQuery', sql: `delete from ${schema}.t` },
      { type: 'query', sql: `insert into ${schema}.t values (5) returning a` },
      {
        type: 'query',
        sql: `with d as (delete from ${schema}.t returning a) select count(*)::int as n from d`,
      },
      { type: 'query', sql: `call ${schema}.p(:a, null)`, parameters: { a: 1 } },
    ]);
    expect(outputsOf(events)['resultSets']).toEqual([
      { rowCount: 1, rows: [{ a: 5 }] },
      { rowCount: 1, rows: [{ n: 1 }] },
      { rowCount: 1, rows: [{ a: 2, b: 2 }] },
    ]);
  });

  it('refuses a write in a script of Query blocks, and writes nothing', async () => {
    await reset();
    const events = await runLive(
      [{ type: 'query', sql: `insert into ${schema}.t values (7) returning a` }],
      { writable: false },
    );
    expect(failureOf(events).error).toBe(
      'Script block 1 writes to the store, which a script with no Non-query block may not; make it a Non-query block',
    );
    expect(await count()).toBe(3);
  });

  it('lets the server refuse a second statement in one block', async () => {
    await reset();
    const events = await runLive([
      { type: 'nonQuery', sql: `delete from ${schema}.t; delete from ${schema}.t` },
    ]);
    expect(failureOf(events).error).toMatch(
      /cannot insert multiple commands into a prepared statement/,
    );
    expect(await count()).toBe(3);
  });

  it('rolls every block back with Run as one transaction', async () => {
    await reset();
    const events = await runLive(
      [
        { type: 'nonQuery', sql: `delete from ${schema}.t` },
        { type: 'nonQuery', sql: `insert into ${schema}.missing values (1)` },
      ],
      { runAsOneTransaction: true },
    );
    expect(failureOf(events).kind).toBe('permanent');
    expect(await count()).toBe(3);
  });

  it('leaves the blocks before a failure applied without it, and says so', async () => {
    await reset();
    const events = await runLive([
      { type: 'nonQuery', sql: `delete from ${schema}.t` },
      { type: 'nonQuery', sql: `insert into ${schema}.missing values (1)` },
    ]);
    expect(failureOf(events)).toMatchObject({ kind: 'permanent' });
    expect(failureOf(events).error).toMatch(/1 block\(s\) had already run outside a transaction/);
    expect(await count()).toBe(0);
  });

  it('reads values as Lookup on postgres does: int8 as text, a naive timestamp as UTC', async () => {
    const events = await runLive([
      {
        type: 'query',
        sql: "select 9007199254740993::int8 as big, timestamp '2026-07-15 13:45:00' as ts",
      },
    ]);
    expect(outputsOf(events)['resultSets']).toEqual([
      { rowCount: 1, rows: [{ big: '9007199254740993', ts: '2026-07-15T13:45:00.000Z' }] },
    ]);
  });
});
