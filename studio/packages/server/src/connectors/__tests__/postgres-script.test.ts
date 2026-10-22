import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_POSTGRES_PORT,
  SCRIPT_ACTIVITY_TYPE,
  SCRIPT_RESULT_ROW_CAP,
  WARNING_CODES,
  scriptDispatchConfigSchema,
} from '@autonomy-studio/shared';
import { LOOKUP_BYTE_CAP } from '../../limits.js';
import { LookupValueError } from '../lookup.js';
import { createPostgresAdapter } from '../postgres.js';
import {
  StreamedQuery,
  preparePostgresBlocks,
  runPostgresScript,
  type PostgresStatementStream,
  type PostgresStreamedResult,
} from '../postgres-script.js';
import type {
  PostgresClient,
  PostgresClientFactory,
  PostgresClientOptions,
  PostgresNotice,
} from '../postgres-session.js';
import { SCRIPT_POSTGRES_STATEMENTS } from '../script.js';
import type { ActivityContext, ActivityEvent } from '../types.js';

/**
 * #1600 OR41 C10b-1 — the Script activity on PostgreSQL. The first half drives
 * the script's logic through a recording client and an injected row stream, so
 * it runs without a server; the second runs it against a live postgres (CI's
 * service container), which is where the streaming and the server's own
 * refusals are proved.
 */

type Block = {
  type: 'query' | 'nonQuery';
  sql: string;
  parameters?: Record<string, unknown>;
  parameterDirections?: Record<string, string>;
};

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
    captureMessages?: boolean;
    blockTimeoutSeconds?: number;
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

/**
 * A client that records every statement and answers transaction control. It
 * keeps the options it was created with and its `notice` listeners (C10b-2b),
 * so a stream can send the server's messages through them.
 */
function recordingFactory(failOn: Record<string, Error> = {}): {
  factory: PostgresClientFactory;
  queries: string[];
  opened: () => number;
  options: PostgresClientOptions[];
  notify: (notice: PostgresNotice) => void;
} {
  const queries: string[] = [];
  const options: PostgresClientOptions[] = [];
  const noticeListeners: ((notice: PostgresNotice) => void)[] = [];
  let opened = 0;
  const factory: PostgresClientFactory = (opts) => {
    opened += 1;
    options.push(opts);
    return {
      connect: () => Promise.resolve(),
      query: (sql) => {
        const text = typeof sql === 'string' ? sql : sql.text;
        queries.push(text);
        const err = failOn[text];
        return err === undefined ? Promise.resolve({ rows: [], fields: [] }) : Promise.reject(err);
      },
      end: () => Promise.resolve(),
      on: (event: string, listener: (arg: never) => void) => {
        if (event === 'notice') noticeListeners.push(listener as (n: PostgresNotice) => void);
      },
    } satisfies PostgresClient;
  };
  return {
    factory,
    queries,
    opened: () => opened,
    options,
    notify: (notice) => {
      for (const listener of noticeListeners) listener(notice);
    },
  };
}

type Answer = {
  rows?: Record<string, unknown>[];
  /** The server's messages, sent while the statement runs (C10b-2b). */
  notices?: PostgresNotice[];
} & Partial<PostgresStreamedResult>;

/** A row stream answering each block's SQL from `answers`: rows, a result, or a throw. */
function fakeStream(
  answers: Record<string, Answer | Error>,
  queries: string[],
  notify: (notice: PostgresNotice) => void = () => undefined,
): PostgresStatementStream {
  return (_client, statement, onRow) => {
    queries.push(statement.sql);
    const answer = answers[statement.sql] ?? {};
    if (answer instanceof Error) return Promise.reject(answer);
    for (const notice of answer.notices ?? []) notify(notice);
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
): Promise<{
  events: ActivityEvent[];
  queries: string[];
  opened: number;
  options: PostgresClientOptions[];
}> {
  const { factory, queries, opened, options, notify } = recordingFactory(failOn);
  const events: ActivityEvent[] = [];
  for await (const e of runPostgresScript(ctx, {
    createClient: factory,
    secret: SECRET,
    types: undefined,
    stream: fakeStream(answers, queries, notify),
  })) {
    events.push(e);
  }
  return { events, queries, opened: opened(), options };
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
        outputNames: [],
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

describe('StreamedQuery (C10b-1)', () => {
  it('keeps no rows even with a callback, and records that a row was described', () => {
    const query = new StreamedQuery({ text: 'select 1' }, undefined, () => undefined);
    query.on('row', () => undefined);
    expect(query.described).toBe(false);
    query.handleRowDescription({ fields: [] });
    expect(query.described).toBe(true);
    expect((query as unknown as { _accumulateRows: boolean })._accumulateRows).toBe(false);
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
      outputLogs: '',
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
        'Script block 1 writes to the store, which a script with no Non-query block may not; make it a Non-query block: cannot execute INSERT in a read-only transaction',
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

    it('EPIPE is a socket code, not a SQLSTATE, so the block may have committed', async () => {
      const { events } = await runFake(scriptCtx(two), {
        'insert into t values (1)': pgError('write EPIPE', 'EPIPE'),
      });
      const failure = failureOf(events);
      expect(failure.kind).toBe('permanent');
      expect(failure.error).toMatch(/1 block\(s\) had already run/);
    });

    it('a DO may have committed partway, so it is never retried', async () => {
      const { events } = await runFake(
        scriptCtx([{ type: 'nonQuery', sql: 'do $$ begin perform 1; end $$' }]),
        { 'do $$ begin perform 1; end $$': pgError('deadlock detected', '40P01') },
      );
      expect(failureOf(events).kind).toBe('permanent');
    });

    it('a row that cannot be kept fails after its statement ran, so it counts as applied', async () => {
      const { events } = await runFake(scriptCtx([{ type: 'query', sql: 'select v' }]), {
        'select v': new LookupValueError('v', 0, 'is not a value'),
      });
      expect(failureOf(events)).toMatchObject({ kind: 'permanent' });
      expect(failureOf(events).error).toMatch(/^a Script result set cannot hold a value/);
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

    it('reports a COMMIT that hit a socket error (EPIPE) as of unknown outcome', async () => {
      const { events } = await runFake(
        scriptCtx(two, { runAsOneTransaction: true }),
        {
          'insert into t values (1)': { command: 'INSERT', rowCount: 1 },
          'insert into t values (2)': { command: 'INSERT', rowCount: 1 },
        },
        { COMMIT: pgError('write EPIPE', 'EPIPE') },
      );
      expect(failureOf(events)).toMatchObject({ kind: 'permanent' });
      expect(failureOf(events).error).toMatch(/the COMMIT's outcome is unknown/);
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

  it('fails a script whose config or connection config is invalid, before any session', async () => {
    const bad = await runFake({ ...scriptCtx([]), input: { blocks: [] } } as ActivityContext);
    expect(failureOf(bad.events).error).toMatch(/^invalid script activity config/);
    const conn = await runFake(
      scriptCtx([{ type: 'query', sql: 'select 1' }], { connection: { host: 'h' } }),
    );
    expect(failureOf(conn.events).error).toMatch(/^invalid postgres connection config/);
    expect(bad.opened + conn.opened).toBe(0);
  });

  it('opens no session for a run cancelled before it starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const { events, opened } = await runFake(
      scriptCtx([{ type: 'query', sql: 'select 1' }], { signal: controller.signal }),
    );
    expect(failureOf(events)).toEqual({
      type: 'failed',
      kind: 'cancelled',
      error: 'script aborted',
    });
    expect(opened).toBe(0);
  });

  it('reports a server it cannot reach', async () => {
    const events: ActivityEvent[] = [];
    const factory: PostgresClientFactory = () => ({
      connect: () => Promise.reject(pgError('connect ECONNREFUSED', 'ECONNREFUSED')),
      query: () => Promise.reject(new Error('unreachable')),
      end: () => Promise.resolve(),
    });
    for await (const e of runPostgresScript(scriptCtx([{ type: 'query', sql: 'select 1' }]), {
      createClient: factory,
      secret: SECRET,
      types: undefined,
      stream: fakeStream({}, []),
    })) {
      events.push(e);
    }
    expect(failureOf(events)).toMatchObject({
      kind: 'transient',
      error: 'cannot reach the postgres server to run the script: connect ECONNREFUSED',
    });
  });

  it('counts every row and keeps none with Capture result sets Off', async () => {
    const { events } = await runFake(
      scriptCtx([{ type: 'query', sql: 'select i' }], { captureResultSets: 'off' }),
      { 'select i': { rows: [{ i: 1 }, { i: 2 }] } },
    );
    expect(outputsOf(events)['resultSets']).toEqual([{ rowCount: 2, rows: [] }]);
  });

  it('a read-only script is retried after pg gives up waiting, as Lookup is', async () => {
    const { events } = await runFake(scriptCtx([{ type: 'query', sql: 'select 1' }]), {
      'select 1': new Error('Query read timeout'),
    });
    expect(failureOf(events)).toMatchObject({ kind: 'transient' });
  });

  it('a cancel during the last block of one transaction rolls it back rather than committing', async () => {
    const controller = new AbortController();
    const { factory, queries } = recordingFactory();
    const events: ActivityEvent[] = [];
    const stream: PostgresStatementStream = (_c, statement) => {
      queries.push(statement.sql);
      controller.abort();
      return Promise.resolve({ hasFields: false, command: 'INSERT', rowCount: 1 });
    };
    for await (const e of runPostgresScript(
      scriptCtx([{ type: 'nonQuery', sql: 'insert into t values (1)' }], {
        runAsOneTransaction: true,
        signal: controller.signal,
      }),
      { createClient: factory, secret: SECRET, types: undefined, stream },
    )) {
      events.push(e);
    }
    expect(failureOf(events)).toEqual({
      type: 'failed',
      kind: 'cancelled',
      error: 'script aborted',
    });
    expect(queries.slice(1)).toEqual(['BEGIN', 'insert into t values (1)', 'ROLLBACK']);
  });

  it('never puts the secret in a failure', async () => {
    const { events } = await runFake(scriptCtx([{ type: 'query', sql: 'select 1' }]), {
      'select 1': pgError(`password ${SECRET} rejected`, '28P01'),
    });
    expect(failureOf(events).error).not.toContain(SECRET);
  });
});

describe('Out and In-out parameters (C10b-2a)', () => {
  const call = (over: Partial<Block> = {}): Block => ({
    type: 'nonQuery',
    sql: 'call p(:a, :b, :total)',
    parameters: { a: 1, b: 2 },
    parameterDirections: { b: 'inOut', total: 'out' },
    ...over,
  });
  const CALL_SQL = 'call p($1, $2, $3)';

  it('binds NULL for an Out parameter, ignoring any value given, and sends an In-out value', () => {
    const prepared = preparePostgresBlocks(
      scriptDispatchConfigSchema.parse({
        blocks: [call({ parameters: { a: 1, b: 2, total: 99 } })],
      }),
    );
    expect(prepared).toMatchObject([{ statement: { sql: CALL_SQL, values: [1, 2, null] } }]);
  });

  it('needs no value for an Out parameter', () => {
    const prepared = preparePostgresBlocks(scriptDispatchConfigSchema.parse({ blocks: [call()] }));
    expect(prepared).toMatchObject([{ statement: { values: [1, 2, null] } }]);
  });

  it('still needs a value for an In-out parameter', () => {
    const prepared = preparePostgresBlocks(
      scriptDispatchConfigSchema.parse({ blocks: [call({ parameters: { a: 1 } })] }),
    );
    expect(prepared).toBe("Script block 1 binds 'b' with no value in its Parameters");
  });

  it('refuses a direction for a name the SQL does not bind, before any session', async () => {
    const { events, opened } = await runFake(
      scriptCtx([call({ parameterDirections: { b: 'inOut', total: 'out', ghost: 'out' } })]),
    );
    expect(failureOf(events)).toEqual({
      type: 'failed',
      kind: 'permanent',
      error: "Script block 1 gives 'ghost' a direction, but its SQL never binds :ghost",
    });
    expect(opened).toBe(0);
  });

  it('reads each Out and In-out value from the returned row by column name', async () => {
    const { events } = await runFake(scriptCtx([call()]), {
      [CALL_SQL]: { rows: [{ total: 7, b: 4 }], command: 'CALL' },
    });
    expect(outputsOf(events)).toMatchObject({
      resultSetCount: 0,
      outputParameters: { b: 4, total: 7 },
    });
  });

  it('keeps the row as a result set too when the block is a Query', async () => {
    const { events } = await runFake(scriptCtx([call({ type: 'query' })]), {
      [CALL_SQL]: { rows: [{ total: 7, b: 4 }], command: 'CALL' },
    });
    expect(outputsOf(events)).toMatchObject({
      resultSets: [{ rowCount: 1, rows: [{ total: 7, b: 4 }] }],
      outputParameters: { b: 4, total: 7 },
    });
  });

  it('lets a later block overwrite a parameter of the same name, as ADF does', async () => {
    const second: Block = {
      type: 'nonQuery',
      sql: 'call q(:total)',
      parameterDirections: { total: 'out' },
    };
    const { events } = await runFake(scriptCtx([call(), second]), {
      [CALL_SQL]: { rows: [{ total: 7, b: 4 }], command: 'CALL' },
      'call q($1)': { rows: [{ total: 8 }], command: 'CALL' },
    });
    expect(outputsOf(events)['outputParameters']).toEqual({ b: 4, total: 8 });
  });

  it('reads an Out parameter named constructor from the row, never from Object.prototype', async () => {
    const block: Block = {
      type: 'nonQuery',
      sql: 'call q(:constructor)',
      parameterDirections: { constructor: 'out' },
    };
    const { events } = await runFake(scriptCtx([block]), {
      'call q($1)': { rows: [{ x: 1 }], command: 'CALL' },
    });
    expect(failureOf(events).error).toMatch(
      /^Script block 1 returned no column 'constructor' for its Out parameter/,
    );
  });

  it('fails a block that returns no row to read its Out parameters from, and counts it applied', async () => {
    const { events } = await runFake(
      scriptCtx([{ type: 'nonQuery', sql: 'delete from t' }, call()]),
      { 'delete from t': { command: 'DELETE', rowCount: 2 }, [CALL_SQL]: { command: 'CALL' } },
    );
    const failure = failureOf(events);
    expect(failure.kind).toBe('permanent');
    expect(failure.error).toMatch(
      /^Script block 2 has Out or In-out parameters, but its statement returned no row to read them from/,
    );
    expect(failure.error).toMatch(/2 block\(s\) had already run outside a transaction/);
  });

  it('fails a block that returns more than one row for its Out parameters', async () => {
    const { events } = await runFake(scriptCtx([call()]), {
      [CALL_SQL]: {
        rows: [
          { total: 1, b: 1 },
          { total: 2, b: 2 },
        ],
      },
    });
    expect(failureOf(events).error).toMatch(
      /^Script block 1 has Out or In-out parameters, but its statement returned 2 rows; they are read from one/,
    );
  });

  it('names the columns when the row has none of an Out parameter’s name', async () => {
    const { events } = await runFake(scriptCtx([call()]), {
      [CALL_SQL]: { rows: [{ b: 4, sum: 7 }], command: 'CALL' },
    });
    expect(failureOf(events).error).toMatch(
      /^Script block 1 returned no column 'total' for its Out parameter; name the parameter after the procedure's \(the row has b, sum; postgres lower-cases an unquoted name\)/,
    );
  });

  it('fails Out parameters past the byte cap rather than keep part of them', async () => {
    const big = 'x'.repeat(LOOKUP_BYTE_CAP);
    const { events } = await runFake(scriptCtx([call()]), {
      [CALL_SQL]: { rows: [{ total: big, b: 1 }], command: 'CALL' },
    });
    expect(failureOf(events).error).toMatch(
      new RegExp(
        `^Script block 1's Out parameters would pass the ${String(LOOKUP_BYTE_CAP)}-byte cap`,
      ),
    );
  });

  describe('one byte allowance across the script', () => {
    // Each fits alone (multi-byte, so only the exact measure sees its size);
    // two of them do not.
    const half = '€'.repeat(Math.floor(LOOKUP_BYTE_CAP / 3 / 2) + 100);
    const block = (sql: string, name: string): Block => ({
      type: 'nonQuery',
      sql: `${sql}(:${name})`,
      parameterDirections: { [name]: 'out' },
    });

    it('counts every block’s values against it', async () => {
      const { events } = await runFake(scriptCtx([block('call p', 'x'), block('call q', 'y')]), {
        'call p($1)': { rows: [{ x: half }], command: 'CALL' },
        'call q($1)': { rows: [{ y: half }], command: 'CALL' },
      });
      expect(failureOf(events).error).toMatch(/^Script block 2's Out parameters would pass/);
    });

    it('gives back the bytes of a value a later block replaces', async () => {
      const { events } = await runFake(scriptCtx([block('call p', 'x'), block('call q', 'x')]), {
        'call p($1)': { rows: [{ x: half }], command: 'CALL' },
        'call q($1)': { rows: [{ x: `${half}!` }], command: 'CALL' },
      });
      expect(outputsOf(events)['outputParameters']).toEqual({ x: `${half}!` });
    });
  });

  it('reads them in a read-only script, with Capture result sets Off', async () => {
    const { events, queries } = await runFake(
      scriptCtx([call({ type: 'query' })], { captureResultSets: 'off' }),
      { [CALL_SQL]: { rows: [{ total: 7, b: 4 }], command: 'CALL' } },
    );
    expect(outputsOf(events)).toMatchObject({
      resultSets: [{ rowCount: 1, rows: [] }],
      outputParameters: { b: 4, total: 7 },
    });
    expect(queries).toEqual([
      expect.stringMatching(/^SET SESSION /),
      'BEGIN READ ONLY',
      CALL_SQL,
      'ROLLBACK',
    ]);
  });

  it('rolls the script back on a failure to read them inside one transaction', async () => {
    const { events, queries } = await runFake(
      scriptCtx([{ type: 'nonQuery', sql: 'delete from t' }, call()], {
        runAsOneTransaction: true,
      }),
      { 'delete from t': { command: 'DELETE', rowCount: 2 }, [CALL_SQL]: { command: 'CALL' } },
    );
    const failure = failureOf(events);
    expect(failure.kind).toBe('permanent');
    expect(failure.error).not.toMatch(/already run outside a transaction/);
    expect(queries).toEqual([
      expect.stringMatching(/^SET SESSION /),
      'BEGIN',
      'delete from t',
      CALL_SQL,
      'ROLLBACK',
    ]);
  });

  it('lists at most 20 of the row’s columns when a name has none', async () => {
    const row = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`c${String(i)}`, i]));
    const { events } = await runFake(scriptCtx([call()]), { [CALL_SQL]: { rows: [row] } });
    expect(failureOf(events).error).toMatch(/\(the row has c0, c1, .*, c19 and 5 more;/);
  });
});

describe('Block timeout (C10b-2b)', () => {
  const blocks: Block[] = [{ type: 'query', sql: 'select 1 as one' }];
  const answers = { 'select 1 as one': { rows: [{ one: 1 }] } };

  it('arms both statement timers at the Block timeout when it is below the connection’s', async () => {
    const { events, options } = await runFake(
      scriptCtx(blocks, {
        blockTimeoutSeconds: 5,
        connection: { ...CONNECTION, statementTimeoutMs: 60_000 },
      }),
      answers,
    );
    expect(terminal(events).type).toBe('succeeded');
    expect(options[0]).toMatchObject({ statement_timeout: 5_000, query_timeout: 5_000 });
  });

  it('never raises the connection’s Statement timeout', async () => {
    const { options } = await runFake(
      scriptCtx(blocks, {
        blockTimeoutSeconds: 3_600,
        connection: { ...CONNECTION, statementTimeoutMs: 30_000 },
      }),
      answers,
    );
    expect(options[0]).toMatchObject({ statement_timeout: 30_000, query_timeout: 30_000 });
  });

  it('keeps the connection’s Statement timeout when it is blank', async () => {
    const { options } = await runFake(
      scriptCtx(blocks, { connection: { ...CONNECTION, statementTimeoutMs: 45_000 } }),
      answers,
    );
    expect(options[0]).toMatchObject({ statement_timeout: 45_000, query_timeout: 45_000 });
  });

  it('names the Block timeout when a block runs past it, keeping the read path’s transient', async () => {
    for (const err of [new Error('Query read timeout'), pgError('canceling statement', '57014')]) {
      const { events } = await runFake(
        scriptCtx([{ type: 'query', sql: 'select pg_sleep(9)' }], { blockTimeoutSeconds: 2 }),
        { 'select pg_sleep(9)': err },
      );
      expect(failureOf(events)).toMatchObject({
        kind: 'transient',
        error: expect.stringMatching(
          /^Script block 1 ran past the Timeout per block of 2 seconds: /,
        ),
      });
    }
  });

  it('keeps the connection’s timeout, and its wording, when the Block timeout equals it', async () => {
    const { events, options } = await runFake(
      scriptCtx([{ type: 'query', sql: 'select pg_sleep(9)' }], {
        blockTimeoutSeconds: 30,
        connection: { ...CONNECTION, statementTimeoutMs: 30_000 },
      }),
      { 'select pg_sleep(9)': new Error('Query read timeout') },
    );
    expect(options[0]).toMatchObject({ statement_timeout: 30_000, query_timeout: 30_000 });
    expect(failureOf(events).error).toMatch(/^Script block 1 failed: /);
  });

  it('names it when the COMMIT times out, still an unknown outcome on a write', async () => {
    const { events } = await runFake(
      scriptCtx([{ type: 'nonQuery', sql: 'delete from t' }], {
        runAsOneTransaction: true,
        blockTimeoutSeconds: 2,
      }),
      { 'delete from t': { command: 'DELETE', rowCount: 1 } },
      { COMMIT: new Error('Query read timeout') },
    );
    expect(failureOf(events)).toMatchObject({
      kind: 'permanent',
      error: expect.stringMatching(
        /^the script could not commit within the Timeout per block of 2 seconds: Query read timeout — the COMMIT's outcome is unknown/,
      ),
    });
  });

  it('says only that the block failed when the connection’s timeout was the bound', async () => {
    const { events } = await runFake(
      scriptCtx([{ type: 'query', sql: 'select pg_sleep(9)' }], {
        blockTimeoutSeconds: 3_600,
      }),
      { 'select pg_sleep(9)': new Error('Query read timeout') },
    );
    expect(failureOf(events).error).toMatch(/^Script block 1 failed: /);
  });
});

describe('Capture messages (C10b-2b)', () => {
  const sql = 'do $$ begin raise notice $$hi$$; end $$';
  const blocks: Block[] = [{ type: 'nonQuery', sql }];
  const notice = (message: string, over: Partial<PostgresNotice> = {}): PostgresNotice => ({
    severity: 'NOTICE',
    message,
    ...over,
  });

  it('keeps the server’s messages in outputLogs, in order, with DETAIL and HINT', async () => {
    const { events } = await runFake(scriptCtx(blocks, { captureMessages: true }), {
      [sql]: {
        command: 'DO',
        notices: [
          notice('first'),
          notice('second', { severity: 'WARNING', detail: 'more', hint: 'try this' }),
        ],
      },
    });
    expect(outputsOf(events)['outputLogs']).toBe(
      'NOTICE: first\nWARNING: second\nDETAIL: more\nHINT: try this',
    );
    expect(outputsOf(events)['truncated']).toBe(false);
  });

  it('keeps nothing when Capture messages is off', async () => {
    const { events } = await runFake(scriptCtx(blocks), {
      [sql]: { command: 'DO', notices: [notice('first')] },
    });
    expect(outputsOf(events)['outputLogs']).toBe('');
  });

  it('scrubs the connection’s secret from a message', async () => {
    const { events } = await runFake(scriptCtx(blocks, { captureMessages: true }), {
      [sql]: { command: 'DO', notices: [notice(`password is ${SECRET}`)] },
    });
    expect(outputsOf(events)['outputLogs']).not.toContain(SECRET);
  });

  it('keeps whole messages up to 1 MiB, then truncates with a warning and never fails', async () => {
    const big = 'x'.repeat(400_000);
    const { events } = await runFake(scriptCtx(blocks, { captureMessages: true }), {
      [sql]: {
        command: 'DO',
        notices: [notice(big), notice(big), notice(big), notice('small')],
      },
    });
    expect(terminal(events).type).toBe('succeeded');
    const logs = outputsOf(events)['outputLogs'] as string;
    // A prefix of whole messages: the third did not fit, and the latch keeps
    // the small one after it out too.
    expect(logs).toBe(`NOTICE: ${big}\nNOTICE: ${big}`);
    expect(Buffer.byteLength(JSON.stringify(logs))).toBeLessThanOrEqual(LOOKUP_BYTE_CAP);
    expect(outputsOf(events)['truncated']).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'warned', code: WARNING_CODES.SCRIPT_MESSAGES_TRUNCATED }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'warned', code: WARNING_CODES.SCRIPT_RESULT_TRUNCATED }),
    );
  });

  it('warns once for each truncation when result sets and messages are both cut', async () => {
    const big = 'x'.repeat(600_000);
    const rows = Array.from({ length: SCRIPT_RESULT_ROW_CAP + 1 }, (_, i) => ({ i }));
    const { events } = await runFake(
      scriptCtx([{ type: 'query', sql: 'select i' }], { captureMessages: true }),
      { 'select i': { rows, notices: [notice(big), notice(big)] } },
    );
    const codes = events.flatMap((e) => (e.type === 'warned' ? [e.code] : []));
    expect(codes).toEqual([
      WARNING_CODES.SCRIPT_RESULT_TRUNCATED,
      WARNING_CODES.SCRIPT_MESSAGES_TRUNCATED,
    ]);
    expect(outputsOf(events)['truncated']).toBe(true);
  });

  it('counts a multi-byte character as its UTF-8 bytes', async () => {
    // 300k 'é' are 600k bytes: the first fits, the second does not.
    const accents = 'é'.repeat(300_000);
    const { events } = await runFake(scriptCtx(blocks, { captureMessages: true }), {
      [sql]: { command: 'DO', notices: [notice(accents), notice(accents)] },
    });
    expect(outputsOf(events)['outputLogs']).toBe(`NOTICE: ${accents}`);
    expect(outputsOf(events)['truncated']).toBe(true);
  });

  it('counts a message as it will be serialised, escapes included', async () => {
    // 350k newlines serialise to 700k bytes each: two do not fit in 1 MiB.
    const lines = '\n'.repeat(350_000);
    const { events } = await runFake(scriptCtx(blocks, { captureMessages: true }), {
      [sql]: { command: 'DO', notices: [notice(lines), notice(lines)] },
    });
    expect(outputsOf(events)['outputLogs']).toBe(`NOTICE: ${lines}`);
    expect(outputsOf(events)['truncated']).toBe(true);
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
    over: {
      runAsOneTransaction?: boolean;
      writable?: boolean;
      captureMessages?: boolean;
      blockTimeoutSeconds?: number;
    } = {},
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
      outputLogs: '',
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

  it('reads a SELECT of no columns as a Query, and refuses a SELECT INTO as one', async () => {
    await reset();
    const ok = await runLive([{ type: 'query', sql: `select from ${schema}.t` }]);
    expect(outputsOf(ok)['resultSets']).toEqual([{ rowCount: 3, rows: [{}, {}, {}] }]);
    const into = await runLive([
      { type: 'nonQuery', sql: `create table ${schema}.u (a int)` },
      { type: 'query', sql: `select a into ${schema}.v from ${schema}.t` },
    ]);
    expect(failureOf(into).error).toMatch(
      /^Script block 2 is a Query, but its statement returns no rows/,
    );
  });

  it('refuses a write in a script of Query blocks, and writes nothing', async () => {
    await reset();
    const events = await runLive(
      [{ type: 'query', sql: `insert into ${schema}.t values (7) returning a` }],
      { writable: false },
    );
    expect(failureOf(events).error).toMatch(
      /^Script block 1 writes to the store, which a script with no Non-query block may not; make it a Non-query block: cannot execute INSERT in a read-only transaction/,
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

  it('keeps RAISE NOTICE and WARNING in outputLogs under Capture messages (C10b-2b)', async () => {
    const events = await runLive(
      [
        {
          type: 'nonQuery',
          sql: `do $$ begin raise notice 'hello %', 1; raise warning 'careful' using hint = 'look'; end $$`,
        },
        { type: 'nonQuery', sql: `drop table if exists ${schema}.missing` },
      ],
      { captureMessages: true },
    );
    expect(outputsOf(events)['outputLogs']).toBe(
      `NOTICE: hello 1\nWARNING: careful\nHINT: look\nNOTICE: table "missing" does not exist, skipping`,
    );
  });

  it('cuts a block off at its Block timeout (C10b-2b)', async () => {
    const started = Date.now();
    const events = await runLive([{ type: 'query', sql: 'select pg_sleep(5)' }], {
      blockTimeoutSeconds: 1,
    });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(failureOf(events)).toMatchObject({
      kind: 'transient',
      error: expect.stringMatching(/^Script block 1 ran past the Timeout per block of 1 seconds: /),
    });
  });

  it('fills outputParameters from a procedure’s INOUT and OUT parameters (C10b-2a)', async () => {
    await reset();
    await admin((c) =>
      c.query(
        `create procedure ${schema}.tally(in v int, inout n int, out total bigint, out "Label" text)
         language plpgsql as $$ begin
           insert into ${schema}.t values (v);
           n := n * 2;
           select count(*) into total from ${schema}.t;
           "Label" := 'added ' || v;
         end $$`,
      ),
    );
    const events = await runLive([
      {
        type: 'nonQuery',
        sql: `call ${schema}.tally(:v, :n, :total, :Label)`,
        parameters: { v: 5, n: 21 },
        parameterDirections: { n: 'inOut', total: 'out', Label: 'out' },
      },
    ]);
    expect(outputsOf(events)).toEqual({
      resultSetCount: 0,
      resultSets: [],
      recordsAffected: 0,
      // bigint reads as text, as Lookup's does.
      outputParameters: { n: 42, total: '4', Label: 'added 5' },
      truncated: false,
      outputLogs: '',
    });
    expect(await count()).toBe(4);
  });
});
