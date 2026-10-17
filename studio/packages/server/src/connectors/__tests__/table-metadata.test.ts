import Database from 'better-sqlite3';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_POSTGRES_PORT, GET_METADATA_ACTIVITY_TYPE } from '@autonomy-studio/shared';
import { createPostgresAdapter } from '../postgres.js';
import { sqliteAdapter } from '../sqlite.js';
import { rowCountOf } from '../table-metadata.js';
import { liveSuiteMustRun } from './live-postgres.js';
import { cleanupTempRoots, seedDb, tempRoot, writableConfig } from './sqlite-fixtures.js';
import type {
  ActivityContext,
  ActivityEvent,
  ConnectorAdapter,
  ResolvedDataset,
} from '../types.js';

/**
 * #1600 OR41 C8c — Get metadata on a database TABLE, against real stores.
 */

afterEach(cleanupTempRoots);

const table = (config: Record<string, unknown>, kind = 'table'): ResolvedDataset =>
  ({ id: 'ds-1', name: 'src', kind, config, columns: [] }) as unknown as ResolvedDataset;

function ctx(
  connectionConfig: Record<string, unknown>,
  input: Record<string, unknown>,
  source: ResolvedDataset | null = table({ table: 't' }),
  signal = new AbortController().signal,
): ActivityContext {
  return {
    runId: 'run-1',
    nodeId: 'n1',
    attemptId: 'a1',
    activityType: GET_METADATA_ACTIVITY_TYPE,
    input,
    connectionConfig,
    ...(source === null ? {} : { datasets: { source } }),
    signal,
  } as unknown as ActivityContext;
}

async function run(
  adapter: ConnectorAdapter,
  c: ActivityContext,
  secret: string | null = null,
): Promise<ActivityEvent> {
  const events: ActivityEvent[] = [];
  for await (const event of adapter.runActivity(c, secret)) events.push(event);
  expect(events).toHaveLength(1);
  return events[0] as ActivityEvent;
}

const succeeded = (e: ActivityEvent): Record<string, unknown> => {
  expect(e.type, e.type === 'failed' ? e.error : '').toBe('succeeded');
  return e.type === 'succeeded' ? e.outputs : {};
};
const failure = (e: ActivityEvent) => {
  expect(e.type).toBe('failed');
  return e.type === 'failed' ? { kind: e.kind, error: e.error } : { kind: '', error: '' };
};

const ALL = ['exists', 'structure', 'columnCount', 'rowCount'];
const UNTICKED_NULLS = {
  itemName: null,
  itemType: null,
  size: null,
  created: null,
  lastModified: null,
  contentMD5: null,
  childItems: null,
};

describe('Get metadata on a sqlite table (C8c)', () => {
  function store() {
    const root = tempRoot();
    const path = seedDb(root, 3, 'src.db');
    const db = new Database(path);
    db.exec(
      'CREATE TABLE loose (a, b NUMERIC(10, 2), c INTEGER GENERATED ALWAYS AS (a + 1) VIRTUAL, ' +
        'd TEXT GENERATED ALWAYS AS (b) STORED); CREATE VIEW v AS SELECT id FROM t;',
    );
    db.exec('CREATE INDEX t_name ON t (name);');
    db.close();
    return writableConfig(root, path);
  }

  it('answers exists, structure, column count and row count', async () => {
    const out = succeeded(await run(sqliteAdapter, ctx(store(), { fieldList: ALL })));
    expect(out).toEqual({
      path: 't',
      exists: true,
      structure: [
        { name: 'id', type: 'INTEGER' },
        { name: 'name', type: 'TEXT' },
      ],
      columnCount: 2,
      rowCount: 3,
      ...UNTICKED_NULLS,
    });
  });

  it('leaves every unticked field null, and the declared type empty where there is none', async () => {
    const out = succeeded(
      await run(
        sqliteAdapter,
        ctx(store(), { fieldList: ['structure'] }, table({ schema: 'main', table: 'LOOSE' })),
      ),
    );
    expect(out.path).toBe('main.LOOSE');
    // Generated columns too, as `SELECT *` returns them.
    expect(out.structure).toEqual([
      { name: 'a', type: '' },
      { name: 'b', type: 'NUMERIC(10, 2)' },
      { name: 'c', type: 'INTEGER' },
      { name: 'd', type: 'TEXT' },
    ]);
    expect([out.exists, out.columnCount, out.rowCount]).toEqual([null, null, null]);
  });

  it('describes and counts a view', async () => {
    const out = succeeded(
      await run(sqliteAdapter, ctx(store(), { fieldList: ALL }, table({ table: 'v' }))),
    );
    expect(out).toMatchObject({ exists: true, columnCount: 1, rowCount: 3 });
  });

  it('gives exists:false for a missing table, or an index name, only with Exists ticked', async () => {
    for (const name of ['missing', 't_name']) {
      const out = succeeded(
        await run(
          sqliteAdapter,
          ctx(store(), { fieldList: ['exists', 'rowCount'] }, table({ table: name })),
        ),
      );
      expect(out).toEqual({
        path: name,
        exists: false,
        structure: null,
        columnCount: null,
        rowCount: null,
        ...UNTICKED_NULLS,
      });
      expect(
        failure(
          await run(
            sqliteAdapter,
            ctx(store(), { fieldList: ['rowCount'] }, table({ table: name })),
          ),
        ),
      ).toEqual({ kind: 'permanent', error: `there is no table '${name}'` });
    }
  });

  it('fails a schema the store does not have, and a missing store file, rather than say false', async () => {
    const f = failure(
      await run(
        sqliteAdapter,
        ctx(store(), { fieldList: ['exists'] }, table({ schema: 'other', table: 't' })),
      ),
    );
    expect(f.kind).toBe('permanent');
    const root = tempRoot();
    const gone = failure(
      await run(
        sqliteAdapter,
        ctx(writableConfig(root, `${root}/nope.db`), { fieldList: ['exists'] }),
      ),
    );
    expect(gone.kind).toBe('permanent');
  });

  it('refuses a path, a file system field, a query dataset and no dataset', async () => {
    const cfg = store();
    expect(
      failure(await run(sqliteAdapter, ctx(cfg, { path: 't', fieldList: ['exists'] }))),
    ).toEqual({
      kind: 'permanent',
      error: 'a table is chosen on the Source tab; clear File or folder path',
    });
    expect(failure(await run(sqliteAdapter, ctx(cfg, { fieldList: ['exists', 'size'] })))).toEqual({
      kind: 'permanent',
      error: 'Size read a file system path, not a table',
    });
    expect(
      failure(
        await run(
          sqliteAdapter,
          ctx(cfg, { fieldList: ['exists'] }, table({ sql: 'select 1' }, 'query')),
        ),
      ).error,
    ).toBe('Get metadata reads a table, not a query dataset');
    expect(failure(await run(sqliteAdapter, ctx(cfg, { fieldList: ['exists'] }, null))).error).toBe(
      'Get metadata on a database reads a table — choose one on Source',
    );
  });

  it('does not start when the run is already cancelled', async () => {
    const abort = new AbortController();
    abort.abort();
    const f = failure(
      await run(
        sqliteAdapter,
        ctx(store(), { fieldList: ALL }, table({ table: 't' }), abort.signal),
      ),
    );
    expect(f.kind).toBe('cancelled');
  });
});

/** #1600 OR41 C8d-2b — Wait until on a table: the adapter answers `notReady` until it holds. */
const notReady = (e: ActivityEvent) => {
  expect(e.type, e.type === 'failed' ? e.error : '').toBe('notReady');
  return e.type === 'notReady' ? e : undefined;
};
const WAIT = { checkEverySeconds: 5, giveUpAfterSeconds: 60 };

describe('Get metadata Wait until on a sqlite table (C8d-2b)', () => {
  function store() {
    const root = tempRoot();
    const path = seedDb(root, 3, 'src.db');
    const db = new Database(path);
    db.exec('CREATE TABLE empty (id INTEGER); CREATE VIEW none AS SELECT id FROM t WHERE 0;');
    db.close();
    return writableConfig(root, path);
  }
  const wait = (waitUntil: string, fieldList: string[], name: string, cfg = store()) =>
    run(sqliteAdapter, ctx(cfg, { fieldList, waitUntil, ...WAIT }, table({ table: name })));

  it('a missing table is not yet, with or without Exists ticked, carrying the timers', async () => {
    for (const fieldList of [['exists'], ['structure']]) {
      expect(notReady(await wait('exists', fieldList, 'later'))).toEqual({
        type: 'notReady',
        reason: "there is no table 'later' yet",
        recheckAfterSeconds: 5,
        giveUpAfterSeconds: 60,
      });
    }
  });

  it('once it exists, reads the ticked fields', async () => {
    expect(succeeded(await wait('exists', ['exists', 'rowCount'], 'empty'))).toMatchObject({
      path: 'empty',
      exists: true,
      rowCount: 0,
    });
  });

  it('It is not empty waits for a row, in a table or a view, then reads the fields', async () => {
    for (const name of ['empty', 'none']) {
      for (const fieldList of [['exists'], ['exists', 'rowCount']]) {
        expect(notReady(await wait('nonEmpty', fieldList, name))?.reason).toBe(
          `'${name}' has no rows yet`,
        );
      }
    }
    expect(notReady(await wait('nonEmpty', ['exists'], 'later'))?.reason).toBe(
      "there is no table 'later' yet",
    );
    expect(succeeded(await wait('nonEmpty', ['columnCount', 'rowCount'], 't'))).toMatchObject({
      columnCount: 2,
      rowCount: 3,
    });
    expect(succeeded(await wait('nonEmpty', ['exists'], 't'))).toMatchObject({ exists: true });
  });

  it('refuses It is at least N bytes, and still fails a schema the store does not have', async () => {
    const sized = await run(
      sqliteAdapter,
      ctx(
        store(),
        { fieldList: ['exists'], waitUntil: 'minimumSize', minimumSize: 1, ...WAIT },
        table({ table: 't' }),
      ),
    );
    expect(failure(sized)).toEqual({
      kind: 'permanent',
      error:
        'It is at least N bytes needs a file; wait for a table with It exists or It is not empty',
    });
    const other = await run(
      sqliteAdapter,
      ctx(
        store(),
        { fieldList: ['exists'], waitUntil: 'exists', ...WAIT },
        table({ schema: 'other', table: 't' }),
      ),
    );
    expect(failure(other).kind).toBe('permanent');
  });
});

describe('rowCountOf (C8c)', () => {
  it('reads a number, a bigint or postgres text, and refuses what a number cannot hold', () => {
    expect(rowCountOf(3)).toBe(3);
    expect(rowCountOf(3n)).toBe(3);
    expect(rowCountOf('42')).toBe(42);
    expect(rowCountOf(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => rowCountOf('9007199254740993')).toThrow(/more than Row count can report/);
    expect(() => rowCountOf(-1)).toThrow(/not a count/);
    expect(() => rowCountOf(null)).toThrow(/not a count/);
  });
});

const LIVE_HOST = process.env.STUDIO_TEST_POSTGRES_HOST;

describe('the live postgres service for Get metadata', () => {
  it('is present whenever CI claims to provide one', () => {
    if (!liveSuiteMustRun(process.env)) return;
    expect(LIVE_HOST).toBeDefined();
  });
});

describe.skipIf(LIVE_HOST === undefined)('Get metadata on a live postgres table (C8c)', () => {
  const live = {
    host: LIVE_HOST ?? '',
    port: Number(process.env.STUDIO_TEST_POSTGRES_PORT ?? DEFAULT_POSTGRES_PORT),
    database: process.env.STUDIO_TEST_POSTGRES_DATABASE ?? 'postgres',
    user: process.env.STUDIO_TEST_POSTGRES_USER ?? 'postgres',
    sslmode: 'disable' as const,
    connectTimeoutMs: 5_000,
  };
  const password = process.env.STUDIO_TEST_POSTGRES_PASSWORD ?? '';
  const schema = `studio_meta_${process.pid}_${Date.now()}`;
  const role = `${schema}_r`;
  const adapter = createPostgresAdapter();

  async function admin(sql: string) {
    const c = new pg.Client({ ...live, password, ssl: false });
    await c.connect();
    try {
      await c.query(sql);
    } finally {
      await c.end();
    }
  }

  beforeAll(async () => {
    await admin(
      `CREATE SCHEMA ${schema};` +
        `CREATE TABLE ${schema}.orders (id int primary key, note varchar(20), dropped int);` +
        `ALTER TABLE ${schema}.orders DROP COLUMN dropped;` +
        `INSERT INTO ${schema}.orders VALUES (1, 'a'), (2, 'b');` +
        `CREATE VIEW ${schema}.recent AS SELECT id FROM ${schema}.orders;` +
        `CREATE SEQUENCE ${schema}.ids;` +
        `CREATE TABLE ${schema}.secret (x int);` +
        `CREATE TABLE ${schema}.empty (id int);` +
        `CREATE MATERIALIZED VIEW ${schema}.unfilled AS SELECT 1 AS x WITH NO DATA;` +
        `CREATE ROLE ${role} LOGIN PASSWORD 'pw';` +
        `GRANT USAGE ON SCHEMA ${schema} TO ${role};` +
        `GRANT SELECT ON ${schema}.orders TO ${role};`,
    );
  });
  afterAll(async () => {
    await admin(`DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP ROLE IF EXISTS ${role};`);
  });

  const at = (name: string) => table({ schema, table: name });

  it('answers exists, structure (store types, dropped columns left out), column count and row count', async () => {
    const out = succeeded(
      await run(adapter, ctx(live, { fieldList: ALL }, at('orders')), password),
    );
    expect(out).toEqual({
      path: `${schema}.orders`,
      exists: true,
      structure: [
        { name: 'id', type: 'integer' },
        { name: 'note', type: 'character varying(20)' },
      ],
      columnCount: 2,
      rowCount: 2,
      ...UNTICKED_NULLS,
    });
  });

  it('describes and counts a view', async () => {
    const out = succeeded(
      await run(adapter, ctx(live, { fieldList: ALL }, at('recent')), password),
    );
    expect(out).toMatchObject({ exists: true, columnCount: 1, rowCount: 2 });
  });

  it('gives exists:false for a missing table and for a sequence of that name', async () => {
    for (const name of ['missing', 'ids']) {
      const out = succeeded(
        await run(adapter, ctx(live, { fieldList: ['exists', 'structure'] }, at(name)), password),
      );
      expect(out).toMatchObject({ exists: false, structure: null });
    }
  });

  it('answers a schema the server does not have', async () => {
    const out = await run(
      adapter,
      ctx(live, { fieldList: ['exists'] }, table({ schema: `${schema}_none`, table: 'orders' })),
      password,
    );
    expect(out).toEqual({ type: 'succeeded', outputs: expect.objectContaining({ exists: false }) });
  });

  it("refuses a table the connection's role cannot read", async () => {
    const f = failure(
      await run(
        adapter,
        ctx({ ...live, user: role }, { fieldList: ['exists'] }, at('secret')),
        'pw',
      ),
    );
    expect(f).toEqual({
      kind: 'permanent',
      error: `the connection's role cannot read the table '${schema}.secret'`,
    });
    const ok = succeeded(
      await run(
        adapter,
        ctx({ ...live, user: role }, { fieldList: ['rowCount'] }, at('orders')),
        'pw',
      ),
    );
    expect(ok.rowCount).toBe(2);
  });
  // #1600 OR41 C8d-2b — Wait until on a table.
  const waitOn = (waitUntil: string, fieldList: string[], target: ResolvedDataset) =>
    run(adapter, ctx(live, { fieldList, waitUntil, ...WAIT }, target), password);

  it('C8d-2b: a missing table, or one in a schema the server does not have, is not yet', async () => {
    expect(notReady(await waitOn('exists', ['structure'], at('later')))?.reason).toBe(
      `there is no table '${schema}.later' yet`,
    );
    expect(
      notReady(await waitOn('exists', ['exists'], table({ schema: `${schema}_none`, table: 'x' })))
        ?.reason,
    ).toBe(`there is no table '${schema}_none.x' yet`);
  });

  it('C8d-2b: It is not empty waits for a row, then reads the fields', async () => {
    for (const fieldList of [['exists'], ['exists', 'rowCount']]) {
      expect(notReady(await waitOn('nonEmpty', fieldList, at('empty')))?.reason).toBe(
        `'${schema}.empty' has no rows yet`,
      );
    }
    expect(succeeded(await waitOn('nonEmpty', ['rowCount'], at('orders')))).toMatchObject({
      rowCount: 2,
    });
    expect(succeeded(await waitOn('nonEmpty', ['exists'], at('recent')))).toMatchObject({
      exists: true,
    });
    const sized = await run(
      adapter,
      ctx(
        live,
        { fieldList: ['exists'], waitUntil: 'minimumSize', minimumSize: 1, ...WAIT },
        at('orders'),
      ),
      password,
    );
    expect(failure(sized).error).toMatch(/^It is at least N bytes needs a file/);
  });

  it('C8d-2b: an unpopulated materialized view, or a table the role cannot read, fails while waiting', async () => {
    const unfilled = failure(await waitOn('nonEmpty', ['exists'], at('unfilled')));
    expect(unfilled.kind).toBe('permanent');
    expect(unfilled.error).toMatch(/has not been populated/);
    const unreadable = failure(
      await run(
        adapter,
        ctx(
          { ...live, user: role },
          { fieldList: ['exists'], waitUntil: 'exists', ...WAIT },
          at('secret'),
        ),
        'pw',
      ),
    );
    expect(unreadable).toEqual({
      kind: 'permanent',
      error: `the connection's role cannot read the table '${schema}.secret'`,
    });
  });
});
