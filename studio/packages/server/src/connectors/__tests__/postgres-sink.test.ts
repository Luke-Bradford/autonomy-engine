import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { writePostgresDatasetRows } from '../postgres-sink.js';
import { resolveSinkColumns } from '../sink-columns.js';
import type {
  PostgresClient,
  PostgresClientFactory,
  PostgresClientOptions,
  PostgresQueryResult,
} from '../postgres-session.js';
import { DEFAULT_POSTGRES_PORT } from '../postgres-session.js';
import type { SinkValue } from '../sqlite-sink.js';
import { liveSuiteMustRun } from './live-postgres.js';

/**
 * #1196 M10 slice 3a — the postgres copy SINK.
 *
 * Split the way `postgres.test.ts` splits, and for its stated reason. The
 * OFFLINE half asserts what is a property of code written here — the refusal
 * ladder, the chunking arithmetic, the statement TEXT, the bind rules — through
 * the injected client seam, so it runs on a machine with no postgres. The LIVE
 * half asserts what only a real server can settle: that the statements this file
 * composes actually do what they were measured to do, that a rollback really
 * leaves the table clean, and that a timestamp survives the round trip under a
 * zone where a wrong answer would differ from a right one.
 */

const SINK_CONFIG = {
  host: 'db.example.test',
  port: 6543,
  database: 'app',
  user: 'app_rw',
  sslmode: 'disable' as const,
  writable: true,
};

interface Recorded {
  readonly sql: string;
  readonly values: readonly unknown[] | undefined;
}

interface SinkRecorder {
  readonly queries: Recorded[];
  ended: number;
}

/** One column as `DESCRIBE_SINK_SQL` reports it. */
function col(name: string, extra: { generated?: boolean; identityAlways?: boolean } = {}) {
  return {
    name,
    generated: extra.generated ?? false,
    identityAlways: extra.identityAlways ?? false,
  };
}

/**
 * A client that answers the describe with a fixture and records everything else.
 *
 * It matches on the statement PREFIX rather than replaying a script, so a test
 * that changes the number of INSERTs does not have to restate the whole
 * conversation — and so an unexpected statement is visible in `rec.queries`
 * rather than silently consuming someone else's canned answer.
 */
function sinkFactory(
  fixture: {
    schema?: string;
    name?: string;
    relkind?: string;
    columns?: ReturnType<typeof col>[];
    missing?: boolean;
    failOn?: { prefix: string; error: unknown };
  } = {},
) {
  const rec: SinkRecorder = { queries: [], ended: 0 };
  const options: PostgresClientOptions[] = [];
  const factory: PostgresClientFactory = (opts) => {
    options.push(opts);
    return {
      async connect() {},
      async query(sql: string, values?: readonly unknown[]): Promise<PostgresQueryResult> {
        rec.queries.push({ sql, values });
        if (fixture.failOn !== undefined && sql.startsWith(fixture.failOn.prefix)) {
          throw fixture.failOn.error;
        }
        if (sql.includes('to_regclass')) {
          if (fixture.missing === true) return { rows: [], fields: [] };
          return {
            rows: [
              {
                schema: fixture.schema ?? 'public',
                name: fixture.name ?? 'tgt',
                relkind: fixture.relkind ?? 'r',
                columns: fixture.columns ?? [col('a'), col('b')],
              },
            ],
            fields: [],
          };
        }
        return { rows: [], fields: [] };
      },
      async end() {
        rec.ended += 1;
      },
    };
  };
  return { rec, options, factory };
}

async function* batchesOf(
  ...batches: readonly Record<string, SinkValue>[][]
): AsyncIterable<readonly Record<string, SinkValue>[]> {
  for (const batch of batches) yield batch;
}

function write(
  overrides: Partial<Parameters<typeof writePostgresDatasetRows>[0]> = {},
): Parameters<typeof writePostgresDatasetRows>[0] {
  return {
    createClient: sinkFactory().factory,
    connectionConfig: SINK_CONFIG,
    secret: 'pw',
    datasetKind: 'table',
    datasetConfig: { schema: 'public', table: 'tgt' },
    columns: ['a', 'b'],
    mode: 'append',
    ...overrides,
  };
}

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const sqlOf = (rec: SinkRecorder) => rec.queries.map((q) => q.sql);

describe('the postgres sink refusal ladder (#1196 M10 slice 3a)', () => {
  it('REFUSES a store nobody declared writable, before it opens a session', async () => {
    // The fail-closed permission gate. `writable` absent means "nobody declared
    // this store writable" — it withholds a permission rather than manufacturing
    // one, and it is in CONNECTION_NON_OVERRIDABLE_CONFIG_KEYS so no dispatch
    // parameter can grant it.
    const { rec, factory } = sinkFactory();
    const notWritable: Record<string, unknown> = { ...SINK_CONFIG };
    delete notWritable.writable;
    await expect(
      writePostgresDatasetRows(
        write({ createClient: factory, connectionConfig: notWritable }),
        batchesOf([{ a: 1, b: 2 }]),
      ),
    ).rejects.toMatchObject({ kind: 'permanent', message: expect.stringContaining('writable') });
    // Not merely refused — refused before anything was opened.
    expect(rec.queries).toEqual([]);
  });

  it('refuses writable: false as firmly as an absent one', async () => {
    await expect(
      writePostgresDatasetRows(
        write({ connectionConfig: { ...SINK_CONFIG, writable: false } }),
        batchesOf([{ a: 1, b: 2 }]),
      ),
    ).rejects.toMatchObject({ kind: 'permanent' });
  });

  it('refuses a `query` dataset as a sink — a SELECT has no insert target', async () => {
    await expect(
      writePostgresDatasetRows(
        write({ datasetKind: 'query', datasetConfig: { sql: 'select 1' } }),
        batchesOf([{ a: 1 }]),
      ),
    ).rejects.toMatchObject({
      kind: 'permanent',
      message: expect.stringContaining('has no insert target'),
    });
  });

  it('CLASSIFIES a malformed table config rather than throwing a raw ZodError', async () => {
    // #1195's review round, at the sink's door: every parse on this path refuses
    // with a `permanent` DatasetIoError carrying the formatted issues, so a bad
    // config cannot escape the failure-classification contract.
    await expect(
      writePostgresDatasetRows(
        write({ datasetConfig: { schema: 'public' } }),
        batchesOf([{ a: 1 }]),
      ),
    ).rejects.toMatchObject({
      kind: 'permanent',
      message: expect.stringContaining('invalid table dataset config'),
    });
  });

  it('refuses an empty mapping', async () => {
    await expect(
      writePostgresDatasetRows(write({ columns: [] }), batchesOf([])),
    ).rejects.toMatchObject({
      kind: 'permanent',
      message: expect.stringContaining('at least one'),
    });
  });

  it('reports a missing relation in this module’s own words, not postgres’', async () => {
    const { factory } = sinkFactory({
      failOn: { prefix: 'LOCK TABLE', error: pgError('42P01', 'relation "tgt" does not exist') },
    });
    await expect(
      writePostgresDatasetRows(write({ createClient: factory }), batchesOf([{ a: 1, b: 2 }])),
    ).rejects.toMatchObject({
      kind: 'permanent',
      message: expect.stringContaining("there is no table 'public.tgt' in the store"),
    });
  });

  it('refuses a VIEW by naming it, rather than calling it a missing table', async () => {
    // Measured: an INSERT into a view raises 55000 from INSIDE the transaction —
    // in `overwrite` mode, after the DELETE already ran. §7 requires the gate
    // before the first row moves, which is what this rung is.
    const { factory } = sinkFactory({ relkind: 'v' });
    await expect(
      writePostgresDatasetRows(write({ createClient: factory }), batchesOf([{ a: 1, b: 2 }])),
    ).rejects.toMatchObject({
      kind: 'permanent',
      message: expect.stringContaining('is a view, not a table'),
    });
  });

  it('accepts a PARTITIONED table, which routes to its partitions', async () => {
    const { rec, factory } = sinkFactory({ relkind: 'p' });
    await expect(
      writePostgresDatasetRows(write({ createClient: factory }), batchesOf([{ a: 1, b: 2 }])),
    ).resolves.toEqual({ rowsWritten: 1 });
    expect(sqlOf(rec)).toContain('COMMIT');
  });

  it('names a GENERATED column for what it is, where sqlite could only call it absent', async () => {
    const { factory } = sinkFactory({ columns: [col('a'), col('b', { generated: true })] });
    await expect(
      writePostgresDatasetRows(write({ createClient: factory }), batchesOf([{ a: 1, b: 2 }])),
    ).rejects.toMatchObject({
      kind: 'permanent',
      message: expect.stringContaining("'b' is a generated column"),
    });
  });

  it('names a GENERATED ALWAYS identity column too', async () => {
    const { factory } = sinkFactory({ columns: [col('a'), col('b', { identityAlways: true })] });
    await expect(
      writePostgresDatasetRows(write({ createClient: factory }), batchesOf([{ a: 1, b: 2 }])),
    ).rejects.toMatchObject({
      kind: 'permanent',
      message: expect.stringContaining('GENERATED ALWAYS identity column'),
    });
  });

  it('lets a copy that does NOT map the generated column through', async () => {
    // The polarity §7 insists on: this rung refuses a mapping that names an
    // unwritable column, never a table that merely has one.
    const { rec, factory } = sinkFactory({
      columns: [col('a'), col('b'), col('gen', { generated: true })],
    });
    await expect(
      writePostgresDatasetRows(write({ createClient: factory }), batchesOf([{ a: 1, b: 2 }])),
    ).resolves.toEqual({ rowsWritten: 1 });
    // And the statement OMITS it. `rowsWritten: 1` alone would pass even if the
    // exclusion picked the wrong column, so long as the counts still lined up —
    // the claim is about which columns the INSERT names, so that is what is read.
    const insert = rec.queries.find((q) => q.sql.startsWith('INSERT INTO'));
    expect(insert?.sql).toContain('"a", "b"');
    expect(insert?.sql).not.toContain('gen');
    expect(insert?.values).toEqual([1, 2]);
  });

  it('refuses a mapped column the sink does not have', async () => {
    const { factory } = sinkFactory({ columns: [col('a')] });
    await expect(
      writePostgresDatasetRows(write({ createClient: factory }), batchesOf([{ a: 1, b: 2 }])),
    ).rejects.toMatchObject({
      kind: 'permanent',
      message: expect.stringContaining("the sink has no column named 'b'"),
    });
  });
});

describe('the postgres sink’s statements (#1196 M10 slice 3a)', () => {
  it('LOCKS before it describes, so the §7 gate cannot read a stale snapshot', async () => {
    const { rec, factory } = sinkFactory();
    await writePostgresDatasetRows(write({ createClient: factory }), batchesOf([{ a: 1, b: 2 }]));
    // Indexed from BEGIN rather than from 0: `openSession` pins `DateStyle`
    // before handing the session over, so the transaction is not the first
    // statement on the wire.
    const sql = sqlOf(rec);
    const begin = sql.indexOf('BEGIN');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(sql[begin + 1]).toContain('LOCK TABLE');
    expect(sql[begin + 2]).toContain('to_regclass');
  });

  it('takes EXCLUSIVE for overwrite and ROW EXCLUSIVE for append', async () => {
    // The asymmetry is the correctness point. ROW EXCLUSIVE is the lock an
    // ordinary INSERT already holds, so it does not exclude a second copy: two
    // concurrent overwrites would each DELETE then each INSERT, leaving the
    // table holding the UNION of both and reporting success to each.
    const appended = sinkFactory();
    await writePostgresDatasetRows(
      write({ createClient: appended.factory, mode: 'append' }),
      batchesOf([{ a: 1, b: 2 }]),
    );
    const appendedSql = sqlOf(appended.rec);
    expect(appendedSql[appendedSql.indexOf('BEGIN') + 1]).toContain('IN ROW EXCLUSIVE MODE');

    const overwritten = sinkFactory();
    await writePostgresDatasetRows(
      write({ createClient: overwritten.factory, mode: 'overwrite' }),
      batchesOf([{ a: 1, b: 2 }]),
    );
    const overwrittenSql = sqlOf(overwritten.rec);
    const lock = overwrittenSql[overwrittenSql.indexOf('BEGIN') + 1] ?? '';
    expect(lock).toContain('IN EXCLUSIVE MODE');
    expect(lock).not.toContain('ROW EXCLUSIVE');
  });

  it('DELETEs inside the transaction for overwrite, and not at all for append', async () => {
    const overwritten = sinkFactory();
    await writePostgresDatasetRows(
      write({ createClient: overwritten.factory, mode: 'overwrite' }),
      batchesOf([{ a: 1, b: 2 }]),
    );
    const sql = sqlOf(overwritten.rec);
    const del = sql.findIndex((s) => s.startsWith('DELETE FROM'));
    expect(del).toBeGreaterThan(sql.indexOf('BEGIN'));
    expect(del).toBeLessThan(sql.indexOf('COMMIT'));

    const appended = sinkFactory();
    await writePostgresDatasetRows(
      write({ createClient: appended.factory, mode: 'append' }),
      batchesOf([{ a: 1, b: 2 }]),
    );
    expect(sqlOf(appended.rec).some((s) => s.startsWith('DELETE FROM'))).toBe(false);
  });

  it('resolves the WRITE target from the describe, so both name one relation', async () => {
    // The dataset says `tgt`; the store resolved it through `search_path` to
    // `s_b."TGT"`. The INSERT must name what was actually described, or the
    // gate and the write are about two different tables.
    const { rec, factory } = sinkFactory({ schema: 's_b', name: 'TGT' });
    await writePostgresDatasetRows(
      write({ createClient: factory, datasetConfig: { table: 'tgt' } }),
      batchesOf([{ a: 1, b: 2 }]),
    );
    const insert = sqlOf(rec).find((s) => s.startsWith('INSERT INTO'));
    expect(insert).toContain('"s_b"."TGT"');
  });

  it('BINDS every value as a parameter and interpolates none of them', async () => {
    const { rec, factory } = sinkFactory();
    await writePostgresDatasetRows(
      write({ createClient: factory }),
      batchesOf([{ a: "Bobby'); drop table students;--", b: 2 }]),
    );
    const insert = rec.queries.find((q) => q.sql.startsWith('INSERT INTO'));
    expect(insert?.sql).toContain('VALUES ($1, $2)');
    expect(insert?.sql).not.toContain('Bobby');
    expect(insert?.values).toEqual(["Bobby'); drop table students;--", 2]);
  });

  it('passes the relation NAME as a bound parameter to to_regclass', async () => {
    // Measured: to_regclass('"public"."plain"; drop table public.plain') returns
    // NULL — a name that does not parse is simply not a relation. Binding it is
    // what makes that the only outcome available.
    const { rec, factory } = sinkFactory();
    await writePostgresDatasetRows(write({ createClient: factory }), batchesOf([{ a: 1, b: 2 }]));
    const describe = rec.queries.find((q) => q.sql.includes('to_regclass'));
    expect(describe?.values).toEqual(['"public"."tgt"']);
  });

  it('CHUNKS on the bind-parameter ceiling, not on the pump’s batch size', async () => {
    // MEASURED: 65535 parameters are accepted and 65538 fails with
    // `08P01 bind message has 2 parameter formats but 0 parameters` — the count
    // wraps in a 16-bit field, so exceeding it garbles the wire message rather
    // than refusing cleanly. With 2 columns the ceiling is 32767 rows; this
    // asserts the arithmetic without shipping 32767 rows through a test.
    const { rec, factory } = sinkFactory({ columns: [col('a'), col('b')] });
    const rows = Array.from({ length: 5 }, (_, i) => ({ a: i, b: i }));
    await writePostgresDatasetRows(
      write({ createClient: factory, columns: ['a', 'b'] }),
      batchesOf(rows),
    );
    const inserts = rec.queries.filter((q) => q.sql.startsWith('INSERT INTO'));
    // One batch, well under the ceiling, so exactly one statement.
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.values).toHaveLength(10);
  });

  it('splits a single batch into several statements once the ceiling is crossed', async () => {
    // 65535 parameters / 6553 columns = 10 rows per statement. Same arithmetic,
    // reached by widening the mapping rather than by lengthening the batch.
    const wide = Array.from({ length: 6553 }, (_, i) => `c${i}`);
    const { rec, factory } = sinkFactory({ columns: wide.map((n) => col(n)) });
    const row = Object.fromEntries(wide.map((n) => [n, 1])) as Record<string, SinkValue>;
    await writePostgresDatasetRows(
      write({ createClient: factory, columns: wide }),
      batchesOf(Array.from({ length: 25 }, () => row)),
    );
    const inserts = rec.queries.filter((q) => q.sql.startsWith('INSERT INTO'));
    expect(inserts).toHaveLength(3);
    for (const insert of inserts) {
      expect(insert.values?.length ?? 0).toBeLessThanOrEqual(65535);
    }
    expect(inserts.reduce((n, i) => n + (i.values?.length ?? 0), 0)).toBe(25 * 6553);
  });

  it('REFUSES an absent value rather than writing it as NULL', async () => {
    // Measured: `pg` binds `undefined` as NULL and the insert SUCCEEDS. That is
    // #473's shape — an absent fact manufactured as a benign one — so the rung
    // is not inherited on faith from the sqlite sink, it is needed here too.
    const { factory } = sinkFactory();
    await expect(
      writePostgresDatasetRows(write({ createClient: factory }), batchesOf([{ a: 1 }])),
    ).rejects.toMatchObject({
      kind: 'permanent',
      message: expect.stringContaining("no value was supplied for the sink column 'b'"),
    });
  });

  it('binds a null, a bigint and a boolean as they stand', async () => {
    const { rec, factory } = sinkFactory({ columns: [col('a'), col('b'), col('c')] });
    await writePostgresDatasetRows(
      write({ createClient: factory, columns: ['a', 'b', 'c'] }),
      batchesOf([{ a: null, b: 9007199254740993n, c: true }]),
    );
    const insert = rec.queries.find((q) => q.sql.startsWith('INSERT INTO'));
    expect(insert?.values).toEqual([null, 9007199254740993n, true]);
  });

  it('ticks the RUNNING TOTAL, never a per-chunk delta', async () => {
    const ticks: number[] = [];
    const wide = Array.from({ length: 6553 }, (_, i) => `c${i}`);
    const { factory } = sinkFactory({ columns: wide.map((n) => col(n)) });
    const row = Object.fromEntries(wide.map((n) => [n, 1])) as Record<string, SinkValue>;
    await writePostgresDatasetRows(
      write({ createClient: factory, columns: wide, onBatch: (n) => ticks.push(n) }),
      batchesOf(Array.from({ length: 25 }, () => row)),
    );
    expect(ticks).toEqual([10, 20, 25]);
  });
});

describe('the postgres sink’s failure posture (#1196 M10 slice 3a)', () => {
  it('ROLLS BACK and reports the store provably clean', async () => {
    const { rec, factory } = sinkFactory({
      failOn: { prefix: 'INSERT INTO', error: pgError('23505', 'duplicate key value') },
    });
    await expect(
      writePostgresDatasetRows(write({ createClient: factory }), batchesOf([{ a: 1, b: 2 }])),
    ).rejects.toMatchObject({ kind: 'permanent', partialWritePossible: false });
    expect(sqlOf(rec)).toContain('ROLLBACK');
    expect(sqlOf(rec)).not.toContain('COMMIT');
  });

  it('keeps a TRANSIENT classification through the rollback', async () => {
    const { factory } = sinkFactory({
      failOn: { prefix: 'INSERT INTO', error: pgError('40001', 'serialization failure') },
    });
    await expect(
      writePostgresDatasetRows(write({ createClient: factory }), batchesOf([{ a: 1, b: 2 }])),
    ).rejects.toMatchObject({ kind: 'transient', partialWritePossible: false });
  });

  it('DOWNGRADES a transient failure whose ROLLBACK also failed — §4.2, applied', async () => {
    // The one state this code cannot prove clean. `retryEligible` reads only
    // `kind`, so carrying `transient` out alongside `partialWritePossible: true`
    // would retry a copy from row 0 into a table that may already hold some of
    // these rows. The fact and the verdict travel together.
    const rec: SinkRecorder = { queries: [], ended: 0 };
    const factory: PostgresClientFactory = () => ({
      async connect() {},
      async query(sql: string, values?: readonly unknown[]): Promise<PostgresQueryResult> {
        rec.queries.push({ sql, values });
        if (sql.startsWith('INSERT INTO')) throw pgError('40001', 'serialization failure');
        if (sql === 'ROLLBACK') throw pgError('08006', 'connection terminated');
        if (sql.includes('to_regclass')) {
          return {
            rows: [{ schema: 'public', name: 'tgt', relkind: 'r', columns: [col('a'), col('b')] }],
            fields: [],
          };
        }
        return { rows: [], fields: [] };
      },
      async end() {
        rec.ended += 1;
      },
    });
    await expect(
      writePostgresDatasetRows(write({ createClient: factory }), batchesOf([{ a: 1, b: 2 }])),
    ).rejects.toMatchObject({
      kind: 'permanent',
      partialWritePossible: true,
      message: expect.stringContaining('the rollback FAILED'),
    });
  });

  it('SCRUBS the sink credential out of an upstream failure message', async () => {
    // The source adapter running a heterogeneous copy is not postgres', so its
    // own redaction cannot know about this secret. This is the first line;
    // the executor's backstop is the second.
    const { factory } = sinkFactory({
      failOn: { prefix: 'INSERT INTO', error: new Error('bad password: hunter2') },
    });
    await expect(
      writePostgresDatasetRows(
        write({ createClient: factory, secret: 'hunter2' }),
        batchesOf([{ a: 1, b: 2 }]),
      ),
    ).rejects.toMatchObject({ message: expect.not.stringContaining('hunter2') });
  });

  it('CLOSES the session on every path, including the failing one', async () => {
    const ok = sinkFactory();
    await writePostgresDatasetRows(
      write({ createClient: ok.factory }),
      batchesOf([{ a: 1, b: 2 }]),
    );
    expect(ok.rec.ended).toBe(1);

    const bad = sinkFactory({
      failOn: { prefix: 'INSERT INTO', error: pgError('23505', 'duplicate') },
    });
    await expect(
      writePostgresDatasetRows(write({ createClient: bad.factory }), batchesOf([{ a: 1, b: 2 }])),
    ).rejects.toThrow();
    expect(bad.rec.ended).toBe(1);
  });

  it('honours a cancel at the batch boundary and rolls back', async () => {
    const controller = new AbortController();
    const { rec, factory } = sinkFactory();
    await expect(
      writePostgresDatasetRows(
        write({ createClient: factory, signal: controller.signal }),
        (async function* () {
          yield [{ a: 1, b: 2 }];
          controller.abort();
          yield [{ a: 3, b: 4 }];
        })(),
      ),
    ).rejects.toMatchObject({ kind: 'cancelled', partialWritePossible: false });
    expect(sqlOf(rec)).toContain('ROLLBACK');
  });

  it('refuses a sink with no credential — postgres needs a password', async () => {
    await expect(
      writePostgresDatasetRows(write({ secret: null }), batchesOf([{ a: 1, b: 2 }])),
    ).rejects.toMatchObject({
      kind: 'permanent',
      message: expect.stringContaining('no secret'),
    });
  });
});

describe('resolveSinkColumns’ postgres-only ambiguity rung (#1196)', () => {
  it('refuses a mapped name that folds onto TWO real columns', () => {
    // MEASURED: `create table cc("id" int, "ID" int)` succeeds on postgres,
    // where sqlite refuses to create `SINK` alongside `sink`. A fold-keyed index
    // over that pair silently keeps whichever came last.
    expect(() => resolveSinkColumns(['id'], ['id', 'ID'])).toThrow(
      /differ only in case/ as unknown as Error,
    );
  });

  it('does NOT refuse a copy that never touches the colliding pair', () => {
    // The direction §7 says a gate must never fail in: refusing on the mere
    // presence of such a pair would refuse work that would have succeeded.
    expect(resolveSinkColumns(['n'], ['id', 'ID', 'n'])).toEqual([{ mapped: 'n', actual: 'n' }]);
  });

  it('still folds case where the store has exactly one spelling', () => {
    expect(resolveSinkColumns(['ID'], ['id'])).toEqual([{ mapped: 'ID', actual: 'id' }]);
  });
});

/* ------------------------------------------------------------------ *
 * The LIVE half — the same opt-in as `postgres.test.ts`'s.
 * ------------------------------------------------------------------ */

const LIVE_HOST = process.env.STUDIO_TEST_POSTGRES_HOST;

describe('the live postgres sink service (#1196 M10)', () => {
  it('is present whenever CI claims to provide one', () => {
    if (!liveSuiteMustRun(process.env)) return;
    expect(
      LIVE_HOST,
      'CI must provide a postgres service container and set STUDIO_TEST_POSTGRES_HOST',
    ).toBeDefined();
  });
});

/** Unpick and drop the ambiguity test's dedicated role, if it is there at all.
 * `drop owned by` first because a grant referencing the role blocks the drop,
 * and both statements error on a role that does not exist — hence the guard. */
const DROP_AMB_ROLE_SQL = `do $$
begin
  if exists (select 1 from pg_roles where rolname = 'studio_sink_amb') then
    execute 'drop owned by studio_sink_amb';
    execute 'drop role studio_sink_amb';
  end if;
end $$`;

describe.skipIf(LIVE_HOST === undefined)('the postgres sink, against a live postgres', () => {
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
  const realClientFactory: PostgresClientFactory = (options) =>
    new pg.Client(options) as unknown as PostgresClient;

  async function withAdminClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({
      host: live.host,
      port: live.port,
      database: live.database,
      user: live.user,
      password,
    });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  const liveWrite = (overrides: Partial<Parameters<typeof writePostgresDatasetRows>[0]> = {}) =>
    write({
      createClient: realClientFactory,
      connectionConfig: live,
      secret: password,
      ...overrides,
    });

  it('really copies rows into a real table', async () => {
    await withAdminClient(async (c) => {
      await c.query('drop table if exists sink_live; create table sink_live(a int, b text)');
    });
    const result = await writePostgresDatasetRows(
      liveWrite({ datasetConfig: { schema: 'public', table: 'sink_live' } }),
      batchesOf([
        { a: 1, b: 'one' },
        { a: 2, b: 'two' },
      ]),
    );
    expect(result).toEqual({ rowsWritten: 2 });
    const rows = await withAdminClient(
      async (c) => (await c.query('select a, b from sink_live order by a')).rows,
    );
    expect(rows).toEqual([
      { a: 1, b: 'one' },
      { a: 2, b: 'two' },
    ]);
  });

  it('overwrite replaces the table’s contents, inside one transaction', async () => {
    await withAdminClient(async (c) => {
      await c.query('drop table if exists sink_ow; create table sink_ow(a int, b text)');
      await c.query("insert into sink_ow values (99, 'stale')");
    });
    await writePostgresDatasetRows(
      liveWrite({ datasetConfig: { schema: 'public', table: 'sink_ow' }, mode: 'overwrite' }),
      batchesOf([{ a: 1, b: 'fresh' }]),
    );
    const rows = await withAdminClient(
      async (c) => (await c.query('select a, b from sink_ow order by a')).rows,
    );
    expect(rows).toEqual([{ a: 1, b: 'fresh' }]);
  });

  it('a FAILED copy leaves the table provably as it was — the rollback is real', async () => {
    // §4's whole argument: the retry-from-row-0 that `retryEligible` will
    // perform is only safe because the first attempt left nothing behind.
    await withAdminClient(async (c) => {
      await c.query('drop table if exists sink_rb; create table sink_rb(a int, b text)');
      await c.query("insert into sink_rb values (7, 'kept')");
    });
    await expect(
      writePostgresDatasetRows(
        liveWrite({ datasetConfig: { schema: 'public', table: 'sink_rb' }, mode: 'overwrite' }),
        batchesOf([
          { a: 1, b: 'ok' },
          { a: 'not-an-int', b: 'boom' },
        ]),
      ),
    ).rejects.toMatchObject({ partialWritePossible: false });
    const rows = await withAdminClient(
      async (c) => (await c.query('select a, b from sink_rb order by a')).rows,
    );
    expect(rows).toEqual([{ a: 7, b: 'kept' }]);
  });

  it('writes a TZ-HONEST timestamp — the same text under every process zone', async () => {
    // The mirror of slice 2's reader finding, and the reason there is no `Date`
    // arm in `bindValue`. MEASURED: binding a raw JS `Date` for the instant
    // 2026-07-15T13:45:00Z stores `13:45` under TZ=UTC and `22:45` under
    // TZ=Asia/Tokyo, because `pg` serialises client-side in the PROCESS zone;
    // the ISO string `coerceValue` produces stores `13:45` under both. The CI
    // `Test` step pins `TZ: Asia/Tokyo`, so this runs where the two differ.
    await withAdminClient(async (c) => {
      await c.query(
        'drop table if exists sink_tz; create table sink_tz(ts timestamp, tz timestamptz)',
      );
    });
    const iso = new Date('2026-07-15T13:45:00Z').toISOString();
    await writePostgresDatasetRows(
      liveWrite({
        datasetConfig: { schema: 'public', table: 'sink_tz' },
        columns: ['ts', 'tz'],
      }),
      batchesOf([{ ts: iso, tz: iso }]),
    );
    const rows = await withAdminClient(
      async (c) =>
        (
          await c.query(
            "select ts::text ts, to_char(tz at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') tz from sink_tz",
          )
        ).rows,
    );
    expect(rows).toEqual([{ ts: '2026-07-15 13:45:00', tz: '2026-07-15 13:45:00' }]);
  });

  it('an int8 boundary value survives the write exactly', async () => {
    await withAdminClient(async (c) => {
      await c.query('drop table if exists sink_i8; create table sink_i8(n int8)');
    });
    await writePostgresDatasetRows(
      liveWrite({ datasetConfig: { schema: 'public', table: 'sink_i8' }, columns: ['n'] }),
      batchesOf([{ n: 9007199254740993n }]),
    );
    const rows = await withAdminClient(
      async (c) => (await c.query('select n::text from sink_i8')).rows,
    );
    expect(rows).toEqual([{ n: '9007199254740993' }]);
  });

  it('resolves an UNQUALIFIED table through search_path, columns and all', async () => {
    // THE REASON THIS FILE USES `to_regclass` AND NOT `information_schema`.
    //
    // A `search_path` that puts `sink_alt` ahead of `public`, over two schemas
    // holding same-named tables with DIFFERENT columns. An unqualified dataset
    // must describe — and write — `sink_alt.sink_amb`.
    // `information_schema.columns` requires an explicit `table_schema`, so the
    // rejected design would have had to assume `public`, described the wrong
    // table, and REFUSED this mapping as "the sink has no column named
    // 'from_alt'" while an unqualified INSERT would have succeeded.
    //
    // THE SEARCH PATH IS SET ON A ROLE THIS TEST OWNS, and that is not
    // fastidiousness. `search_path` has no per-connection channel here —
    // `clientOptionsFor` deliberately passes discrete options and no `options`
    // string — so it has to be set on a ROLE, and a role's setting is SERVER
    // state shared by every session that logs in as it. Setting it on the
    // suite's own user made a test in `postgres.test.ts` fail with
    // `relation "studio_m10_fixture_7" does not exist`, because vitest runs
    // files concurrently and that suite's unqualified fixtures suddenly
    // resolved somewhere else. A dedicated role keeps the blast radius inside
    // this test.
    const ambRole = 'studio_sink_amb';
    const ambPassword = 'sink_amb_pw';
    await withAdminClient(async (c) => {
      await c.query('drop schema if exists sink_alt cascade; create schema sink_alt');
      await c.query('drop table if exists public.sink_amb');
      await c.query('create table public.sink_amb(a int, from_public int)');
      await c.query('create table sink_alt.sink_amb(a int, from_alt int)');
      // `drop role` refuses while any grant still references the role, so a
      // leftover from an earlier run has to be UNPICKED rather than dropped —
      // `drop owned by` is what removes those grants. Guarded on existence
      // because it is an error on a role that is not there.
      await c.query(DROP_AMB_ROLE_SQL);
      await c.query(`create role ${ambRole} login password '${ambPassword}'`);
      await c.query(`alter role ${ambRole} set search_path = sink_alt, public`);
      await c.query(`grant usage on schema sink_alt, public to ${ambRole}`);
      await c.query(`grant all on sink_alt.sink_amb, public.sink_amb to ${ambRole}`);
    });
    try {
      await writePostgresDatasetRows(
        liveWrite({
          connectionConfig: { ...live, user: ambRole },
          secret: ambPassword,
          datasetConfig: { table: 'sink_amb' },
          columns: ['a', 'from_alt'],
        }),
        batchesOf([{ a: 1, from_alt: 2 }]),
      );
      const landed = await withAdminClient(
        async (c) => (await c.query('select a, from_alt from sink_alt.sink_amb')).rows,
      );
      expect(landed).toEqual([{ a: 1, from_alt: 2 }]);
      // And nothing reached the same-named table in `public`.
      const untouched = await withAdminClient(
        async (c) => (await c.query('select count(*)::int n from public.sink_amb')).rows,
      );
      expect(untouched).toEqual([{ n: 0 }]);
    } finally {
      await withAdminClient(async (c) => {
        await c.query('drop schema if exists sink_alt cascade');
        await c.query('drop table if exists public.sink_amb');
        await c.query(DROP_AMB_ROLE_SQL);
      });
    }
  });

  it('EXCLUSIVE really serialises two overwrite copies — not just the SQL string', async () => {
    // The offline test asserts the lock MODE that is sent. This asserts what
    // that mode is FOR, which is a property of postgres rather than of our
    // string: a second `overwrite` must WAIT rather than interleave. With
    // `ROW EXCLUSIVE` — the lock an ordinary INSERT already holds — it would
    // not, and two concurrent overwrites would each DELETE then each INSERT,
    // leaving the table holding the UNION of both and reporting success to
    // each. §9's COPY_CONCURRENCY makes that reachable.
    await withAdminClient(async (c) => {
      await c.query('drop table if exists sink_lock; create table sink_lock(a int)');
    });

    // A holder that takes the same lock and sits on it, so the copy below has
    // something real to be excluded by.
    const holder = new pg.Client({
      host: live.host,
      port: live.port,
      database: live.database,
      user: live.user,
      password,
    });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE "public"."sink_lock" IN EXCLUSIVE MODE');

    let finished = false;
    const copy = writePostgresDatasetRows(
      liveWrite({
        datasetConfig: { schema: 'public', table: 'sink_lock' },
        mode: 'overwrite',
        columns: ['a'],
      }),
      batchesOf([{ a: 1 }]),
    ).then((r) => {
      finished = true;
      return r;
    });

    // It must still be BLOCKED while the holder sits on the lock. A generous
    // window: the point is that it does not complete, not how fast it would.
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(finished, 'the copy must WAIT for the exclusive lock, not interleave').toBe(false);

    await holder.query('ROLLBACK');
    await holder.end();
    await expect(copy).resolves.toEqual({ rowsWritten: 1 });
  });

  it('append does NOT serialise against another append — the weaker lock is deliberate', async () => {
    // The other half of the asymmetry. Taking EXCLUSIVE for `append` would
    // block the operator's own application writes for the length of a long
    // copy, for no correctness gain: two appends interleaving is what append
    // MEANS. So a concurrent ROW EXCLUSIVE holder must NOT block it.
    await withAdminClient(async (c) => {
      await c.query('drop table if exists sink_app; create table sink_app(a int)');
    });
    const holder = new pg.Client({
      host: live.host,
      port: live.port,
      database: live.database,
      user: live.user,
      password,
    });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE "public"."sink_app" IN ROW EXCLUSIVE MODE');
    try {
      await expect(
        writePostgresDatasetRows(
          liveWrite({
            datasetConfig: { schema: 'public', table: 'sink_app' },
            mode: 'append',
            columns: ['a'],
          }),
          batchesOf([{ a: 1 }]),
        ),
      ).resolves.toEqual({ rowsWritten: 1 });
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
  });

  it('refuses a real VIEW before the DELETE runs', async () => {
    await withAdminClient(async (c) => {
      await c.query(
        'drop view if exists sink_v; drop table if exists sink_vb; create table sink_vb(a int)',
      );
      await c.query('create view sink_v as select a from sink_vb');
    });
    await expect(
      writePostgresDatasetRows(
        liveWrite({
          datasetConfig: { schema: 'public', table: 'sink_v' },
          columns: ['a'],
          mode: 'overwrite',
        }),
        batchesOf([{ a: 1 }]),
      ),
    ).rejects.toMatchObject({
      kind: 'permanent',
      message: expect.stringContaining('is a view, not a table'),
    });
  });
});
