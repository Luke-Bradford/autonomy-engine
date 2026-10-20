import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { autoCreateLockKey } from '../auto-create-table.js';
import { DatasetIoError } from '../dataset-io-error.js';
import { writePostgresDatasetRows } from '../postgres-sink.js';
import { resolveSinkColumns } from '../sink-columns.js';
import type {
  PostgresClient,
  PostgresClientFactory,
  PostgresClientOptions,
  PostgresExtendedQuery,
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
  /** Set when the statement was sent as a `PostgresExtendedQuery` (C3b). */
  readonly queryMode?: 'extended';
}

interface SinkRecorder {
  readonly queries: Recorded[];
  ended: number;
}

/** One column as `DESCRIBE_SINK_SQL` reports it. */
function col(
  name: string,
  extra: { generated?: boolean; identityAlways?: boolean; notNull?: boolean } = {},
) {
  return {
    name,
    generated: extra.generated ?? false,
    identityAlways: extra.identityAlways ?? false,
    notNull: extra.notNull ?? false,
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
    fillsNulls?: boolean;
    primaryKey?: string[];
    missing?: boolean;
    failOn?: { prefix: string; error: unknown };
    /** What an INSERT reports as its `rowCount`, given how many tuples it sent.
     * Defaults to every tuple landing — the plain-table case. */
    insertRowCount?: (sent: number) => number | null | undefined;
    /** What an Upsert's UPDATE reports as its `rowCount` (C3a). */
    updateRowCount?: number;
    /** Auto-create's existence checks, answered in turn (C3c). Past the end,
     * the relation exists unless `missing`. */
    exists?: boolean[];
    /** Auto-create's `pg_try_advisory_lock` answers, in turn; past the end, granted. */
    locks?: boolean[];
    /** What `current_schema()` answers (C3c). */
    currentSchema?: string;
    /** Called with every statement before it is answered. */
    onQuery?: (sql: string) => void;
    /** An INSERT's error, given its bound values; `undefined` lets it land (C6d-1). */
    insertError?: (values: readonly unknown[]) => unknown;
  } = {},
) {
  const rec: SinkRecorder = { queries: [], ended: 0 };
  const options: PostgresClientOptions[] = [];
  const factory: PostgresClientFactory = (opts) => {
    options.push(opts);
    return {
      async connect() {},
      async query(
        input: string | PostgresExtendedQuery,
        given?: readonly unknown[],
      ): Promise<PostgresQueryResult> {
        const sql = typeof input === 'string' ? input : input.text;
        const values = typeof input === 'string' ? given : input.values;
        rec.queries.push(
          typeof input === 'string' ? { sql, values } : { sql, values, queryMode: input.queryMode },
        );
        if (fixture.failOn !== undefined && sql.startsWith(fixture.failOn.prefix)) {
          throw fixture.failOn.error;
        }
        fixture.onQuery?.(sql);
        if (sql.includes('pg_try_advisory_lock')) {
          return { rows: [{ locked: fixture.locks?.shift() ?? true }], fields: [] };
        }
        if (sql.includes('current_schema()')) {
          return { rows: [{ schema: fixture.currentSchema ?? 'public' }], fields: [] };
        }
        if (sql.includes('is not null as "exists"')) {
          return {
            rows: [{ exists: fixture.exists?.shift() ?? fixture.missing !== true }],
            fields: [],
          };
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
                primaryKey: fixture.primaryKey ?? [],
                fillsNulls: fixture.fillsNulls ?? false,
              },
            ],
            fields: [],
          };
        }
        if (sql.startsWith('UPDATE')) {
          return { rows: [], fields: [], rowCount: fixture.updateRowCount ?? 0 };
        }
        if (sql.startsWith('INSERT INTO')) {
          const error = fixture.insertError?.(values ?? []);
          if (error !== undefined) throw error;
          const sent = (sql.match(/\(\$\d/g) ?? []).length;
          const rowCount = (fixture.insertRowCount ?? ((n: number) => n))(sent);
          return { rows: [], fields: [], rowCount };
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
    nullOnError: [],
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

  it('does NOT refuse a writable column whose case-twin is generated', async () => {
    // The review finding on PR #1197. The unwritable rung used to build its own
    // fold index over the unwritable columns ALONE, so a table holding a
    // writable `id` and a generated `"ID"` refused a mapping naming `id` as
    // "is a generated column" — postgres would have accepted that INSERT. Both
    // rungs now read the SAME resolution, so the exact spelling wins and only a
    // mapping that really lands on the generated column is refused.
    const { rec, factory } = sinkFactory({
      columns: [col('id'), col('ID', { generated: true }), col('b')],
    });
    await expect(
      writePostgresDatasetRows(
        write({ createClient: factory, columns: ['id', 'b'] }),
        batchesOf([{ id: 1, b: 2 }]),
      ),
    ).resolves.toEqual({ rowsWritten: 1 });
    const insert = rec.queries.find((q) => q.sql.startsWith('INSERT INTO'));
    expect(insert?.sql).toContain('"id", "b"');
    expect(insert?.sql).not.toContain('"ID"');
  });

  it('still refuses the mapping that DOES land on the generated twin', async () => {
    const { factory } = sinkFactory({
      columns: [col('id'), col('ID', { generated: true }), col('b')],
    });
    await expect(
      writePostgresDatasetRows(
        write({ createClient: factory, columns: ['ID', 'b'] }),
        batchesOf([{ ID: 1, b: 2 }]),
      ),
    ).rejects.toMatchObject({
      kind: 'permanent',
      message: expect.stringContaining("'ID' is a generated column"),
    });
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

describe("the postgres sink: the store's own NOT NULL, for an onError:'null' row (#1162)", () => {
  it('REFUSES before the overwrite DELETE and before any INSERT', async () => {
    const { rec, factory } = sinkFactory({ columns: [col('a'), col('b', { notNull: true })] });
    await expect(
      writePostgresDatasetRows(
        write({ createClient: factory, mode: 'overwrite', nullOnError: ['b'] }),
        batchesOf([{ a: 1, b: 2 }]),
      ),
    ).rejects.toMatchObject({
      kind: 'permanent',
      message: expect.stringMatching(
        /sink column 'b' sets onError:'null', but the sink table in the store is NOT NULL/,
      ),
    });
    expect(rec.queries.some((q) => /^(DELETE|INSERT)/.test(q.sql))).toBe(false);
  });

  it('ADMITS it when a trigger, rule or foreign partition can decide the NULL instead', async () => {
    const { factory } = sinkFactory({
      columns: [col('a'), col('b', { notNull: true })],
      fillsNulls: true,
    });
    await expect(
      writePostgresDatasetRows(
        write({ createClient: factory, nullOnError: ['b'] }),
        batchesOf([{ a: 1, b: 2 }]),
      ),
    ).resolves.toEqual({ rowsWritten: 1 });
  });

  it('ADMITS a NOT NULL column whose row does not set onError:null', async () => {
    const { factory } = sinkFactory({ columns: [col('a'), col('b', { notNull: true })] });
    await expect(
      writePostgresDatasetRows(
        write({ createClient: factory, nullOnError: ['a'] }),
        batchesOf([{ a: 1, b: 2 }]),
      ),
    ).resolves.toEqual({ rowsWritten: 1 });
  });

  it("keys on the store's EXACT spelling — a NOT NULL case-twin does not refuse its neighbour", async () => {
    // `id` nullable, `"ID"` NOT NULL: a fold-keyed lookup would refuse a mapping
    // naming `id`, which postgres would have accepted.
    const { factory } = sinkFactory({
      columns: [col('id'), col('ID', { notNull: true }), col('b')],
    });
    await expect(
      writePostgresDatasetRows(
        write({ createClient: factory, columns: ['id', 'b'], nullOnError: ['id'] }),
        batchesOf([{ id: 1, b: 2 }]),
      ),
    ).resolves.toEqual({ rowsWritten: 1 });
    const { factory: twin } = sinkFactory({
      columns: [col('id'), col('ID', { notNull: true }), col('b')],
    });
    await expect(
      writePostgresDatasetRows(
        write({ createClient: twin, columns: ['ID', 'b'], nullOnError: ['ID'] }),
        batchesOf([{ ID: 1, b: 2 }]),
      ),
    ).rejects.toThrow(/sink column 'ID'/);
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

  it('counts what the store says LANDED, not the tuples it sent (#1270)', async () => {
    // A BEFORE trigger returning NULL, or a DO INSTEAD rule, keeps fewer rows
    // than the statement carried; the INSERT's own `rowCount` is the only
    // witness to that.
    const ticks: number[] = [];
    const { factory } = sinkFactory({ insertRowCount: (sent) => sent - 1 });
    const result = await writePostgresDatasetRows(
      write({ createClient: factory, onBatch: (n) => ticks.push(n) }),
      batchesOf([
        { a: 1, b: 2 },
        { a: 3, b: 4 },
        { a: 5, b: 6 },
      ]),
    );
    expect(result).toEqual({ rowsWritten: 2 });
    expect(ticks).toEqual([2]);
  });

  it('REFUSES, and rolls back, when the INSERT reports no row count (#1270)', async () => {
    // Guessing the tuple count here is exactly the overstatement #1270 removed.
    const { rec, factory } = sinkFactory({ insertRowCount: () => null });
    await expect(
      writePostgresDatasetRows(write({ createClient: factory }), batchesOf([{ a: 1, b: 2 }])),
    ).rejects.toMatchObject({ kind: 'permanent', message: expect.stringContaining('row count') });
    expect(sqlOf(rec)).toContain('ROLLBACK');
    expect(sqlOf(rec)).not.toContain('COMMIT');
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
  it('refuses a mapped name that folds onto TWO real columns and matches NEITHER exactly', () => {
    // MEASURED: `create table cc("id" int, "ID" int)` succeeds on postgres,
    // where sqlite refuses to create `SINK` alongside `sink`. A fold-keyed index
    // over that pair silently keeps whichever came last.
    expect(() => resolveSinkColumns(['Id'], ['id', 'ID'])).toThrow(
      /differ only in case/ as unknown as Error,
    );
  });

  it('PREFERS an exact spelling over refusing, when the mapping supplies one', () => {
    // Postgres identifiers are exact once quoted, so a mapping naming `id` where
    // the store has both `id` and `"ID"` has named one of them unambiguously.
    // Refusing it anyway would make the rung's own advice — "name the column
    // exactly as the store spells it" — impossible to follow.
    expect(resolveSinkColumns(['id'], ['id', 'ID'])).toEqual([{ mapped: 'id', actual: 'id' }]);
    expect(resolveSinkColumns(['ID'], ['id', 'ID'])).toEqual([{ mapped: 'ID', actual: 'ID' }]);
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

describe('the postgres sink: Skip incompatible rows (#1600 OR41 C6d-1)', () => {
  const dup = pgError('23505', 'duplicate key value violates unique constraint "tgt_pkey"');
  Object.assign(dup, { constraint: 'tgt_pkey', detail: 'Key (a)=(2) already exists.' });
  const rejectA2 = (values: readonly unknown[]) => {
    // Every INSERT holding a = 2, as postgres fails a whole statement.
    for (let i = 0; i < values.length; i += 2) if (values[i] === 2) return dup;
    return undefined;
  };
  const rowsAt = (...as: number[]) => as.map((a) => ({ a, b: 'x' }));

  it('replays a rejected batch row by row under savepoints, skipping the rejected row', async () => {
    const { rec, factory } = sinkFactory({ insertError: rejectA2 });
    const rejected: [number, string][] = [];
    const result = await writePostgresDatasetRows(
      write({ createClient: factory, onRowRejected: (p, r) => rejected.push([p, r]) }),
      batchesOf(rowsAt(1, 2, 3), rowsAt(4)),
    );
    // Built from the code and the constraint, never the message or the detail,
    // which quote the value.
    expect(rejected).toEqual([[1, "23505 unique_violation, constraint 'tgt_pkey'"]]);
    expect(result.rowsWritten).toBe(3);
    const sql = sqlOf(rec);
    const from = sql.indexOf('SAVEPOINT studio_copy_batch');
    const tail = sql.slice(from, sql.indexOf('COMMIT') + 1).map((q) => q.split(' (')[0]);
    expect(tail).toEqual([
      'SAVEPOINT studio_copy_batch',
      'INSERT INTO "public"."tgt"',
      'ROLLBACK TO SAVEPOINT studio_copy_batch',
      'SAVEPOINT studio_copy_row',
      'INSERT INTO "public"."tgt"',
      'RELEASE SAVEPOINT studio_copy_row',
      'SAVEPOINT studio_copy_row',
      'INSERT INTO "public"."tgt"',
      'ROLLBACK TO SAVEPOINT studio_copy_row',
      'RELEASE SAVEPOINT studio_copy_row',
      'SAVEPOINT studio_copy_row',
      'INSERT INTO "public"."tgt"',
      'RELEASE SAVEPOINT studio_copy_row',
      'RELEASE SAVEPOINT studio_copy_batch',
      // The second batch holds no rejected row: one savepoint, one INSERT.
      'SAVEPOINT studio_copy_batch',
      'INSERT INTO "public"."tgt"',
      'RELEASE SAVEPOINT studio_copy_batch',
      'COMMIT',
    ]);
  });

  it('numbers a rejected row by its place in the batch across a bind-limit flush', async () => {
    // Two columns bind 32,767 rows per statement, so row 32,768 is in the
    // second statement of the same batch.
    const rows = Array.from({ length: 32_770 }, (_, i) => ({ a: i === 32_768 ? 2 : 10 + i, b: 'x' }));
    const rejected: number[] = [];
    const result = await writePostgresDatasetRows(
      write({
        createClient: sinkFactory({ insertError: rejectA2 }).factory,
        onRowRejected: (p) => rejected.push(p),
      }),
      batchesOf(rows),
    );
    expect(rejected).toEqual([32_768]);
    expect(result.rowsWritten).toBe(32_769);
  });

  it('fails the copy on an error that is not the row\'s, without a replay', async () => {
    const denied = pgError('42501', 'permission denied for table tgt');
    const { rec, factory } = sinkFactory({ insertError: () => denied });
    await expect(
      writePostgresDatasetRows(
        write({ createClient: factory, onRowRejected: () => {} }),
        batchesOf(rowsAt(1, 2)),
      ),
    ).rejects.toThrow(/permission denied/);
    const sql = sqlOf(rec);
    expect(sql.filter((q) => q.startsWith('INSERT INTO'))).toHaveLength(1);
    expect(sql).not.toContain('SAVEPOINT studio_copy_row');
    expect(sql).toContain('ROLLBACK');
  });

  it('names the column a NOT NULL or a bound type error reports, and only the code without one', async () => {
    const notNull = Object.assign(pgError('23502', 'null value in column "b"'), { column: 'b' });
    const badInt = pgError('22P02', 'invalid input syntax for type integer: "abc"');
    const rejected: string[] = [];
    await writePostgresDatasetRows(
      write({
        createClient: sinkFactory({
          insertError: (v) => (v.length !== 2 ? notNull : v[0] === 1 ? notNull : v[0] === 2 ? badInt : undefined),
        }).factory,
        onRowRejected: (_, r) => rejected.push(r),
      }),
      batchesOf(rowsAt(1, 2, 3)),
    );
    expect(rejected).toEqual([
      "23502 not_null_violation, column 'b'",
      '22P02 invalid_text_representation',
    ]);
    expect(rejected.join()).not.toContain('abc');
  });

  it('off, writes exactly the statements it wrote before C6d', async () => {
    const { rec, factory } = sinkFactory();
    await writePostgresDatasetRows(write({ createClient: factory }), batchesOf(rowsAt(1, 2)));
    expect(sqlOf(rec).some((q) => q.includes('SAVEPOINT'))).toBe(false);
  });

  it('refuses it with Upsert', async () => {
    await expect(
      writePostgresDatasetRows(
        write({
          createClient: sinkFactory({ primaryKey: ['a'] }).factory,
          mode: 'upsert',
          onRowRejected: () => {},
        }),
        batchesOf(rowsAt(1)),
      ),
    ).rejects.toThrow(/does not apply to Upsert/);
  });
});

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

/**
 * #1600 OR41 C3a — Truncate then insert and Upsert: the statements on the wire.
 * What the table ends up holding is the live suite's to prove (below); these
 * pin the shape, lock and order that run everywhere, CI or not.
 */
describe('the postgres sink: Truncate then insert and Upsert (C3a)', () => {
  const lockOf = (rec: SinkRecorder) => {
    const sql = sqlOf(rec);
    return sql[sql.indexOf('BEGIN') + 1] ?? '';
  };

  it('Truncate takes ACCESS EXCLUSIVE up front and TRUNCATEs after the gate, before any INSERT', async () => {
    const { rec, factory } = sinkFactory();
    await writePostgresDatasetRows(
      write({ createClient: factory, mode: 'truncate' }),
      batchesOf([{ a: 1, b: 2 }]),
    );
    expect(lockOf(rec)).toContain('IN ACCESS EXCLUSIVE MODE');
    const sql = sqlOf(rec);
    const truncate = sql.indexOf('TRUNCATE "public"."tgt"');
    expect(truncate).toBeGreaterThan(sql.findIndex((q) => q.includes('to_regclass')));
    expect(truncate).toBeLessThan(sql.findIndex((q) => q.startsWith('INSERT INTO')));
    expect(sql.some((q) => q.startsWith('DELETE'))).toBe(false);
  });

  it("refuses a TRUNCATE postgres will not run (0A000) in postgres's words, with what to do instead", async () => {
    const { rec, factory } = sinkFactory({
      failOn: {
        prefix: 'TRUNCATE',
        error: pgError('0A000', 'cannot truncate a table referenced in a foreign key constraint'),
      },
    });
    const err = await writePostgresDatasetRows(
      write({ createClient: factory, mode: 'truncate' }),
      batchesOf([{ a: 1, b: 2 }]),
    ).then(
      () => undefined,
      (e: unknown) => e as DatasetIoError,
    );
    expect(err?.kind).toBe('permanent');
    expect(err?.message).toMatch(
      /could not empty 'public\.tgt' \(Overwrite deletes the rows instead\)/,
    );
    expect(err?.message).toMatch(/referenced in a foreign key constraint/);
    expect(sqlOf(rec)).toContain('ROLLBACK');
  });

  it('Upsert takes SHARE ROW EXCLUSIVE, stages typed like the target, then updates and inserts', async () => {
    const { rec, factory } = sinkFactory({ updateRowCount: 1 });
    const result = await writePostgresDatasetRows(
      write({ createClient: factory, mode: 'upsert', keyColumns: ['a'] }),
      batchesOf([
        { a: 1, b: 'x' },
        { a: 2, b: 'y' },
      ]),
    );
    expect(lockOf(rec)).toContain('IN SHARE ROW EXCLUSIVE MODE');
    const sql = sqlOf(rec);
    const stage = sql.findIndex((q) => q.startsWith('CREATE TEMP TABLE'));
    expect(sql[stage]).toBe(
      'CREATE TEMP TABLE "studio_copy_upsert" ON COMMIT DROP AS SELECT "a", "b", 0::bigint AS ' +
        '"studio_copy_ord" FROM "public"."tgt" WITH NO DATA',
    );
    expect(sql.slice(stage + 1, stage + 5)).toEqual([
      'TRUNCATE pg_temp."studio_copy_upsert"',
      'INSERT INTO pg_temp."studio_copy_upsert" ("a", "b", "studio_copy_ord") VALUES ($1, $2, $3), ($4, $5, $6)',
      'UPDATE "public"."tgt" AS t SET "b" = d."b" FROM (SELECT DISTINCT ON ("a") * FROM ' +
        'pg_temp."studio_copy_upsert" ORDER BY "a", "studio_copy_ord" DESC) AS d WHERE t."a" = d."a"',
      'INSERT INTO "public"."tgt" ("a", "b") SELECT d."a", d."b" FROM (SELECT DISTINCT ON ("a") * ' +
        'FROM pg_temp."studio_copy_upsert" ORDER BY "a", "studio_copy_ord" DESC) AS d WHERE NOT ' +
        'EXISTS (SELECT 1 FROM "public"."tgt" AS t WHERE t."a" = d."a")',
    ]);
    // Each row carries its order in the source, so the last of a repeated key wins.
    expect(rec.queries[stage + 2]?.values).toEqual([1, 'x', 1, 2, 'y', 2]);
    // The UPDATE's 1 plus the INSERT…SELECT's 0 (the fake's count for no tuples).
    expect(result.rowsWritten).toBe(1);
  });

  it("defaults to the table's primary key, and skips the UPDATE when every mapped column is a key", async () => {
    const { rec, factory } = sinkFactory({ columns: [col('a')], primaryKey: ['a'] });
    await writePostgresDatasetRows(
      write({ createClient: factory, mode: 'upsert', columns: ['a'] }),
      batchesOf([{ a: 1 }]),
    );
    const sql = sqlOf(rec);
    expect(sql.some((q) => q.startsWith('UPDATE'))).toBe(false);
    expect(sql.some((q) => q.includes('DISTINCT ON ("a")'))).toBe(true);
  });

  it('refuses a NULL key before the chunk is sent, and rolls back', async () => {
    const { rec, factory } = sinkFactory();
    const err = await writePostgresDatasetRows(
      write({ createClient: factory, mode: 'upsert', keyColumns: ['a'] }),
      batchesOf([{ a: null, b: 'x' }]),
    ).then(
      () => undefined,
      (e: unknown) => e as DatasetIoError,
    );
    expect(err?.message).toMatch(/row 1: the Upsert key column 'a' is NULL/);
    const sql = sqlOf(rec);
    expect(sql.some((q) => q.startsWith('INSERT'))).toBe(false);
    expect(sql).toContain('ROLLBACK');
  });

  it('refuses a mapping that writes the staging order column', async () => {
    const { factory } = sinkFactory({ columns: [col('a'), col('studio_copy_ord')] });
    const err = await writePostgresDatasetRows(
      write({
        createClient: factory,
        mode: 'upsert',
        keyColumns: ['a'],
        columns: ['a', 'studio_copy_ord'],
      }),
      batchesOf([{ a: 1, studio_copy_ord: 2 }]),
    ).then(
      () => undefined,
      (e: unknown) => e as DatasetIoError,
    );
    expect(err?.message).toMatch(
      /a column named 'studio_copy_ord', which this mapping also writes/,
    );
  });

  it('chunks an Upsert on the parameter ceiling counting the order column', async () => {
    // 32767 columns + the order column = 32768 parameters a row, so one row a
    // statement: a chunk that forgot the extra column would send two rows
    // (65534 + 2 > 65535) and garble the bind message.
    const names = Array.from({ length: 32767 }, (_, i) => `c${i}`);
    const { rec, factory } = sinkFactory({ columns: names.map((n) => col(n)) });
    const row = Object.fromEntries(names.map((n) => [n, 1]));
    await writePostgresDatasetRows(
      write({ createClient: factory, mode: 'upsert', keyColumns: ['c0'], columns: names }),
      batchesOf([row, row]),
    );
    const staged = rec.queries.filter((q) => q.sql.startsWith('INSERT INTO pg_temp'));
    expect(staged).toHaveLength(2);
  });
});

describe('the postgres sink: Pre-copy script (C3b)', () => {
  it('runs after the lock and before the describe, over the extended protocol, with $n values', async () => {
    const { rec, factory } = sinkFactory();
    await writePostgresDatasetRows(
      write({
        createClient: factory,
        preCopyScript: { sql: 'DELETE FROM tgt WHERE d = :d OR e = :d', parameters: { d: 'x' } },
      }),
      batchesOf([{ a: 1, b: 2 }]),
    );
    const sql = sqlOf(rec);
    const script = rec.queries.findIndex((q) => q.sql.startsWith('DELETE FROM tgt'));
    expect(sql[script - 1]).toMatch(/^LOCK TABLE/);
    expect(script).toBeLessThan(sql.findIndex((q) => q.includes('to_regclass')));
    expect(rec.queries[script]).toEqual({
      sql: 'DELETE FROM tgt WHERE d = $1 OR e = $1',
      values: ['x'],
      queryMode: 'extended',
    });
  });

  it('sends a script with no bind values over the extended protocol too', async () => {
    const { rec, factory } = sinkFactory();
    await writePostgresDatasetRows(
      write({ createClient: factory, preCopyScript: { sql: 'DELETE FROM tgt', parameters: {} } }),
      batchesOf(),
    );
    expect(rec.queries.find((q) => q.sql === 'DELETE FROM tgt')).toEqual({
      sql: 'DELETE FROM tgt',
      values: [],
      queryMode: 'extended',
    });
  });

  it.each(['COMMIT', 'ROLLBACK', 'SET search_path = x', 'VACUUM tgt', '; DELETE FROM tgt'])(
    'refuses %s before it reaches the server, and rolls back',
    async (scriptSql) => {
      const { rec, factory } = sinkFactory();
      const err = await writePostgresDatasetRows(
        write({ createClient: factory, preCopyScript: { sql: scriptSql, parameters: {} } }),
        batchesOf([{ a: 1, b: 2 }]),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DatasetIoError);
      expect((err as DatasetIoError).message).toMatch(
        /Pre-copy script (on PostgreSQL may not run|must begin with its statement)/,
      );
      expect(rec.queries.some((q) => q.queryMode === 'extended')).toBe(false);
      expect(sqlOf(rec).at(-1)).toBe('ROLLBACK');
    },
  );

  it("names a failing script and redacts the credential from the server's words", async () => {
    const { factory } = sinkFactory({
      failOn: { prefix: 'DELETE FROM audit', error: pgError('42501', 'permission denied for pw') },
    });
    const err = await writePostgresDatasetRows(
      write({ createClient: factory, preCopyScript: { sql: 'DELETE FROM audit', parameters: {} } }),
      batchesOf([{ a: 1, b: 2 }]),
    ).catch((e: unknown) => e);
    expect((err as DatasetIoError).message).toMatch(
      /^the Pre-copy script failed: permission denied for /,
    );
    expect((err as DatasetIoError).message).not.toContain('pw');
  });
});

describe('the postgres sink: Auto-create from mapping (C3c)', () => {
  const COLUMNS = [
    { name: 'a', type: 'integer' as const },
    { name: 'b', type: 'string' as const },
  ];
  const EXISTS = 'select to_regclass($1) is not null as "exists"';
  const TRY_LOCK = 'select pg_try_advisory_lock($1::bigint) as "locked"';
  const UNLOCK = 'select pg_advisory_unlock($1::bigint)';
  const CURRENT_SCHEMA = 'select current_schema() as "schema"';
  /** The statements from BEGIN on: the session's own setup precedes it. */
  const fromBegin = (rec: SinkRecorder) => sqlOf(rec).slice(sqlOf(rec).indexOf('BEGIN'));
  const valuesOf = (rec: SinkRecorder, sql: string) =>
    rec.queries.filter((q) => q.sql === sql).map((q) => q.values);

  it('takes the advisory lock before looking the name up, then creates, all before the LOCK', async () => {
    const { rec, factory } = sinkFactory({ exists: [false] });
    await writePostgresDatasetRows(
      write({ createClient: factory, autoCreate: COLUMNS }),
      batchesOf([{ a: 1, b: 2 }]),
    );
    expect(fromBegin(rec).slice(0, 5)).toEqual([
      'BEGIN',
      TRY_LOCK,
      EXISTS,
      'CREATE TABLE "public"."tgt" ("a" bigint, "b" text)',
      'LOCK TABLE "public"."tgt" IN ROW EXCLUSIVE MODE',
    ]);
    expect(valuesOf(rec, EXISTS)).toEqual([['"public"."tgt"']]);
    expect(valuesOf(rec, TRY_LOCK)).toEqual([[autoCreateLockKey('public', 'tgt')]]);
    // Held to the COMMIT, so the next copy finds the committed table, then released.
    const queries = sqlOf(rec);
    expect(queries.filter((q) => q === UNLOCK)).toHaveLength(1);
    expect(queries.indexOf(UNLOCK)).toBeGreaterThan(queries.indexOf('COMMIT'));
    expect(valuesOf(rec, UNLOCK)).toEqual([[autoCreateLockKey('public', 'tgt')]]);
  });

  it('keys an unqualified name on the schema CREATE would use, so both spellings share a lock', async () => {
    const { rec, factory } = sinkFactory({ exists: [false], currentSchema: 'public' });
    await writePostgresDatasetRows(
      write({ createClient: factory, datasetConfig: { table: 'tgt' }, autoCreate: COLUMNS }),
      batchesOf([{ a: 1, b: 2 }]),
    );
    expect(fromBegin(rec).slice(0, 4)).toEqual(['BEGIN', CURRENT_SCHEMA, TRY_LOCK, EXISTS]);
    expect(valuesOf(rec, TRY_LOCK)).toEqual([[autoCreateLockKey('public', 'tgt')]]);
    expect(autoCreateLockKey('public', 'tgt')).not.toBe(autoCreateLockKey('other', 'tgt'));
    expect(autoCreateLockKey('public', 'tgt')).toMatch(/^-?\d+$/);
  });

  it('releases the lock at once and creates nothing when the table exists', async () => {
    const { rec, factory } = sinkFactory({ exists: [true] });
    await writePostgresDatasetRows(
      write({ createClient: factory, autoCreate: COLUMNS }),
      batchesOf([{ a: 1, b: 2 }]),
    );
    expect(fromBegin(rec).slice(0, 5)).toEqual([
      'BEGIN',
      TRY_LOCK,
      EXISTS,
      UNLOCK,
      'LOCK TABLE "public"."tgt" IN ROW EXCLUSIVE MODE',
    ]);
    expect(valuesOf(rec, UNLOCK)).toEqual([[autoCreateLockKey('public', 'tgt')]]);
  });

  it('still writes when releasing the lock fails, and tries the release again after COMMIT', async () => {
    const { rec, factory } = sinkFactory({
      exists: [true],
      failOn: { prefix: UNLOCK, error: pgError('08006', 'connection failure') },
    });
    const result = await writePostgresDatasetRows(
      write({ createClient: factory, autoCreate: COLUMNS }),
      batchesOf([{ a: 1, b: 2 }]),
    );
    expect(result.rowsWritten).toBe(1);
    const queries = sqlOf(rec);
    expect(queries.filter((q) => q === UNLOCK)).toHaveLength(2);
    expect(queries.lastIndexOf(UNLOCK)).toBeGreaterThan(queries.indexOf('COMMIT'));
  });

  it('waits while another copy holds the lock, then creates nothing once it has created the table', async () => {
    const { rec, factory } = sinkFactory({ exists: [true], locks: [false, false] });
    await writePostgresDatasetRows(
      write({ createClient: factory, autoCreate: COLUMNS }),
      batchesOf([{ a: 1, b: 2 }]),
    );
    expect(sqlOf(rec).filter((q) => q === TRY_LOCK)).toHaveLength(3);
    expect(sqlOf(rec).some((q) => q.startsWith('CREATE TABLE'))).toBe(false);
  });

  it('stops waiting on a cancel, creates nothing, and rolls back', async () => {
    const controller = new AbortController();
    let tries = 0;
    const { rec, factory } = sinkFactory({
      locks: [false, false, false, false],
      onQuery: (sql) => {
        if (sql === TRY_LOCK && ++tries === 2) controller.abort();
      },
    });
    const err = await writePostgresDatasetRows(
      write({ createClient: factory, autoCreate: COLUMNS, signal: controller.signal }),
      batchesOf([{ a: 1, b: 2 }]),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'cancelled' });
    // It stops at the try the cancel landed on, rather than waiting out the lock.
    expect(sqlOf(rec).filter((q) => q === TRY_LOCK)).toHaveLength(2);
    expect(sqlOf(rec).some((q) => q.startsWith('CREATE TABLE'))).toBe(false);
    // Released after the ROLLBACK even though it was never granted: a grant whose
    // reply was lost would look the same, and unlocking an unheld lock is a no-op.
    expect(sqlOf(rec).slice(-2)).toEqual(['ROLLBACK', UNLOCK]);
  });

  it('stops waiting at the statement timeout with no signal, as the LOCK it precedes would', async () => {
    const { rec, factory } = sinkFactory({ locks: Array<boolean>(50).fill(false) });
    const err = await writePostgresDatasetRows(
      write({
        createClient: factory,
        connectionConfig: { ...SINK_CONFIG, statementTimeoutMs: 250 },
        autoCreate: COLUMNS,
      }),
      batchesOf([{ a: 1, b: 2 }]),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      kind: 'transient',
      message:
        "Auto-create waited 250ms for another copy creating 'public.tgt', and it is still running",
    });
    const tries = sqlOf(rec).filter((q) => q === TRY_LOCK).length;
    expect(tries).toBeGreaterThan(1);
    expect(tries).toBeLessThan(50);
    expect(sqlOf(rec).slice(-2)).toEqual(['ROLLBACK', UNLOCK]);
  });

  it('rolls the create back on a cancel that lands while it runs', async () => {
    const controller = new AbortController();
    const { rec, factory } = sinkFactory({
      exists: [false],
      onQuery: (sql) => {
        if (sql.startsWith('CREATE TABLE')) controller.abort();
      },
    });
    const err = await writePostgresDatasetRows(
      write({ createClient: factory, autoCreate: COLUMNS, signal: controller.signal }),
      batchesOf([{ a: 1, b: 2 }]),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'cancelled' });
    expect(sqlOf(rec).some((q) => q.startsWith('LOCK TABLE'))).toBe(false);
    expect(sqlOf(rec).slice(-2)).toEqual(['ROLLBACK', UNLOCK]);
  });

  it('creates every type as its PostgreSQL column type, an unqualified name unqualified', async () => {
    const { rec, factory } = sinkFactory({
      exists: [false],
      columns: ['s', 'i', 'n', 'b', 'd', 't', 'x'].map((name) => col(name)),
    });
    await writePostgresDatasetRows(
      write({
        createClient: factory,
        datasetConfig: { table: 'tgt' },
        columns: ['s', 'i', 'n', 'b', 'd', 't', 'x'],
        autoCreate: [
          { name: 's', type: 'string' },
          { name: 'i', type: 'integer' },
          { name: 'n', type: 'number' },
          { name: 'b', type: 'boolean' },
          { name: 'd', type: 'date' },
          { name: 't', type: 'timestamp' },
          { name: 'x', type: 'binary' },
        ],
      }),
      batchesOf(),
    );
    expect(sqlOf(rec).find((q) => q.startsWith('CREATE TABLE'))).toBe(
      'CREATE TABLE "tgt" ("s" text, "i" bigint, "n" double precision, "b" boolean, ' +
        '"d" date, "t" timestamptz, "x" bytea)',
    );
  });

  it.each([
    [
      [
        { name: 'a', type: 'integer' as const },
        { name: 'A', type: 'string' as const },
      ],
      "Auto-create cannot create both 'a' and 'A': the copy matches sink columns without case",
    ],
    [
      [{ name: 'c'.repeat(64), type: 'string' as const }],
      `Auto-create cannot create '${'c'.repeat(64)}': a PostgreSQL name is at most 63 characters`,
    ],
  ])('refuses %j before any statement after BEGIN, and rolls back', async (autoCreate, message) => {
    const { rec, factory } = sinkFactory({ exists: [false] });
    const err = await writePostgresDatasetRows(
      write({ createClient: factory, autoCreate, columns: autoCreate.map((c) => c.name) }),
      batchesOf([{ a: 1 }]),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'permanent', message });
    expect(fromBegin(rec)).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('refuses a table name over 63 characters, which the server would truncate', async () => {
    const { rec, factory } = sinkFactory();
    const err = await writePostgresDatasetRows(
      write({
        createClient: factory,
        datasetConfig: { schema: 'public', table: 't'.repeat(64) },
        autoCreate: COLUMNS,
      }),
      batchesOf([{ a: 1, b: 2 }]),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      kind: 'permanent',
      message: `Auto-create cannot create '${'t'.repeat(64)}': a PostgreSQL name is at most 63 characters`,
    });
    expect(fromBegin(rec)).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it("reports a refused CREATE in the store's words, permanent, and rolls back", async () => {
    const { rec, factory } = sinkFactory({
      exists: [false],
      failOn: {
        prefix: 'CREATE TABLE',
        error: pgError('42501', 'permission denied for schema public'),
      },
    });
    const err = await writePostgresDatasetRows(
      write({ createClient: factory, autoCreate: COLUMNS }),
      batchesOf([{ a: 1, b: 2 }]),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      kind: 'permanent',
      message: "the copy into 'public.tgt' failed: permission denied for schema public",
    });
    // The lock it took is released after the ROLLBACK, not left to the session.
    expect(sqlOf(rec).slice(-2)).toEqual(['ROLLBACK', UNLOCK]);
  });
});

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

  it('skips the rows a real postgres rejects under Skip incompatible rows, and keeps the rest (C6d-1)', async () => {
    await withAdminClient(async (c) => {
      await c.query(
        "drop table if exists sink_skip; create table sink_skip(a int primary key, b varchar(3) not null check (b <> 'bad'))",
      );
    });
    const rejected: [number, string][] = [];
    const result = await writePostgresDatasetRows(
      liveWrite({
        datasetConfig: { schema: 'public', table: 'sink_skip' },
        onRowRejected: (p, r) => rejected.push([p, r]),
      }),
      batchesOf(
        [
          { a: 1, b: 'ok' },
          { a: 1, b: 'dup' },
          { a: 2, b: null },
          { a: 3, b: 'too long' },
          { a: 4, b: 'bad' },
        ],
        [
          { a: 'x', b: 'ok' },
          { a: 6, b: 'ok' },
        ],
      ),
    );
    expect(rejected).toEqual([
      [1, "23505 unique_violation, constraint 'sink_skip_pkey'"],
      [2, "23502 not_null_violation, column 'b'"],
      [3, '22001 string_data_right_truncation'],
      [4, "23514 check_violation, constraint 'sink_skip_b_check'"],
      [0, '22P02 invalid_text_representation'],
    ]);
    expect(result.rowsWritten).toBe(2);
    const rows = await withAdminClient((c) => c.query('select a, b from sink_skip order by a'));
    expect(rows.rows).toEqual([
      { a: 1, b: 'ok' },
      { a: 6, b: 'ok' },
    ]);
  });

  it("REFUSES an onError:'null' row into a real NOT NULL column, and the table is untouched (#1162)", async () => {
    await withAdminClient(async (c) => {
      await c.query(
        "drop table if exists sink_nn; create table sink_nn(a int, b text not null); insert into sink_nn values (1, 'kept')",
      );
    });
    await expect(
      writePostgresDatasetRows(
        liveWrite({
          datasetConfig: { schema: 'public', table: 'sink_nn' },
          mode: 'overwrite',
          nullOnError: ['b'],
        }),
        batchesOf([{ a: 2, b: 'x' }]),
      ),
    ).rejects.toThrow(/sink column 'b'.*NOT NULL/);
    const rows = await withAdminClient((c) => c.query('select a, b from sink_nn'));
    expect(rows.rows).toEqual([{ a: 1, b: 'kept' }]);
  });

  it('ADMITS it when a BEFORE INSERT trigger on a PARTITION fills the column (#1162)', async () => {
    // Measured: postgres runs a BEFORE ROW trigger before the NOT NULL check, so
    // this insert succeeds — refusing it would refuse work that succeeds.
    await withAdminClient(async (c) => {
      await c.query(`
        drop table if exists sink_fill;
        create or replace function sink_fill_b() returns trigger language plpgsql as
          $f$ begin new.b := coalesce(new.b, 'filled'); return new; end $f$;
        create table sink_fill(a int, b text not null) partition by range (a);
        create table sink_fill_p partition of sink_fill for values from (0) to (100);
        create trigger sink_fill_t before insert on sink_fill_p
          for each row execute function sink_fill_b();`);
    });
    await expect(
      writePostgresDatasetRows(
        liveWrite({ datasetConfig: { schema: 'public', table: 'sink_fill' }, nullOnError: ['b'] }),
        batchesOf([{ a: 1, b: null }]),
      ),
    ).resolves.toEqual({ rowsWritten: 1 });
    const rows = await withAdminClient((c) => c.query('select a, b from sink_fill'));
    expect(rows.rows).toEqual([{ a: 1, b: 'filled' }]);
  });

  it('ADMITS it when an INSERT rule rewrites the statement (#1162)', async () => {
    // A `DO INSTEAD` rule means the INSERT never reaches the NOT NULL column.
    await withAdminClient(async (c) => {
      await c.query(`
        drop table if exists sink_ruled;
        create table sink_ruled(a int, b text not null);
        create rule sink_ruled_r as on insert to sink_ruled do instead nothing;`);
    });
    await expect(
      writePostgresDatasetRows(
        liveWrite({ datasetConfig: { schema: 'public', table: 'sink_ruled' }, nullOnError: ['b'] }),
        batchesOf([{ a: 1, b: null }]),
      ),
      // #1270 — and it says nothing landed, because nothing did.
    ).resolves.toEqual({ rowsWritten: 0 });
  });

  it('still REFUSES behind a DISABLED trigger or a DO ALSO rule — the constraint still fires (#1162)', async () => {
    await withAdminClient(async (c) => {
      await c.query(`
        drop table if exists sink_off; drop table if exists sink_also; drop table if exists sink_also_log;
        create or replace function sink_off_b() returns trigger language plpgsql as
          $f$ begin new.b := coalesce(new.b, 'filled'); return new; end $f$;
        create table sink_off(a int, b text not null);
        create trigger sink_off_t before insert on sink_off for each row execute function sink_off_b();
        alter table sink_off disable trigger sink_off_t;
        create table sink_also_log(a int);
        create table sink_also(a int, b text not null);
        create rule sink_also_r as on insert to sink_also do also insert into sink_also_log values (new.a);`);
    });
    for (const table of ['sink_off', 'sink_also']) {
      await expect(
        writePostgresDatasetRows(
          liveWrite({ datasetConfig: { schema: 'public', table }, nullOnError: ['b'] }),
          batchesOf([{ a: 1, b: 'x' }]),
        ),
      ).rejects.toThrow(/sink column 'b'.*NOT NULL/);
    }
  });

  it('counts only the rows the store KEPT — a BEFORE trigger returning NULL (#1270)', async () => {
    await withAdminClient(async (c) => {
      await c.query(`
        drop table if exists sink_skip;
        create or replace function sink_skip_b() returns trigger language plpgsql as
          $f$ begin if new.b is null then return null; end if; return new; end $f$;
        create table sink_skip(a int, b text);
        create trigger sink_skip_t before insert on sink_skip for each row execute function sink_skip_b();`);
    });
    await expect(
      writePostgresDatasetRows(
        liveWrite({ datasetConfig: { schema: 'public', table: 'sink_skip' } }),
        batchesOf([
          { a: 1, b: 'kept' },
          { a: 2, b: null },
          { a: 3, b: 'kept' },
        ]),
      ),
    ).resolves.toEqual({ rowsWritten: 2 });
  });

  it('reports the rows a DO INSTEAD rule redirected, per its command status (#1270)', async () => {
    // Postgres §41.6 "Rules and Command Status": under an unconditional INSTEAD
    // rule the status is that of the rule's last same-type query (else zero —
    // the DO INSTEAD NOTHING case above). So the count is of rows that landed in
    // the rule's TARGET; sqlite has no rules and never counts a row placed elsewhere.
    await withAdminClient(async (c) => {
      await c.query(`
        drop table if exists sink_redirect; drop table if exists sink_redirect_to;
        create table sink_redirect_to(a int);
        create table sink_redirect(a int, b text);
        create rule sink_redirect_r as on insert to sink_redirect
          do instead insert into sink_redirect_to values (new.a);`);
    });
    await expect(
      writePostgresDatasetRows(
        liveWrite({ datasetConfig: { schema: 'public', table: 'sink_redirect' } }),
        batchesOf([
          { a: 1, b: 'x' },
          { a: 2, b: 'y' },
        ]),
      ),
    ).resolves.toEqual({ rowsWritten: 2 });
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

  /**
   * #1600 OR41 C3a — Truncate then insert and Upsert against a real table. The
   * offline suite pins the statements; these prove what the table holds.
   */
  describe('Truncate then insert and Upsert (C3a)', () => {
    const tableRows = async (table: string) =>
      (await withAdminClient((c) => c.query(`select * from ${table} order by 1`))).rows;
    const upsertInto = (
      table: string,
      columns: string[],
      keyColumns: string[],
      ...chunks: Record<string, SinkValue>[][]
    ) =>
      writePostgresDatasetRows(
        liveWrite({
          datasetConfig: { schema: 'public', table },
          columns,
          mode: 'upsert',
          keyColumns,
        }),
        batchesOf(...chunks),
      );

    it('Truncate empties the table, then inserts', async () => {
      await withAdminClient((c) =>
        c.query(
          "drop table if exists sink_tr; create table sink_tr(a int, b text); insert into sink_tr values (1, 'a')",
        ),
      );
      await expect(
        writePostgresDatasetRows(
          liveWrite({ datasetConfig: { schema: 'public', table: 'sink_tr' }, mode: 'truncate' }),
          batchesOf([{ a: 9, b: 'z' }]),
        ),
      ).resolves.toEqual({ rowsWritten: 1 });
      expect(await tableRows('sink_tr')).toEqual([{ a: 9, b: 'z' }]);
    });

    it('Truncate refuses a table a foreign key references, and leaves it intact', async () => {
      await withAdminClient((c) =>
        c.query(
          'drop table if exists sink_trc; drop table if exists sink_trp;' +
            'create table sink_trp(a int primary key, b text);' +
            'create table sink_trc(p int references sink_trp(a));' +
            "insert into sink_trp values (1, 'kept'); insert into sink_trc values (1)",
        ),
      );
      await expect(
        writePostgresDatasetRows(
          liveWrite({ datasetConfig: { schema: 'public', table: 'sink_trp' }, mode: 'truncate' }),
          batchesOf([{ a: 2, b: 'x' }]),
        ),
      ).rejects.toMatchObject({
        kind: 'permanent',
        message: expect.stringContaining('Overwrite deletes the rows instead'),
      });
      expect(await tableRows('sink_trp')).toEqual([{ a: 1, b: 'kept' }]);
    });

    it('Upsert updates matched keys, inserts the rest, and a rerun adds nothing', async () => {
      // No unique constraint on the key: Upsert does not need one.
      await withAdminClient((c) =>
        c.query(
          "drop table if exists sink_up; create table sink_up(a int, b text); insert into sink_up values (1, 'a'), (2, 'b')",
        ),
      );
      const rows = [
        { a: 2, b: 'B' },
        { a: 3, b: 'c' },
      ];
      await expect(upsertInto('sink_up', ['a', 'b'], ['a'], rows)).resolves.toEqual({
        rowsWritten: 2,
      });
      // The rerun matches both rows: two updates, no insert.
      await expect(upsertInto('sink_up', ['a', 'b'], ['a'], rows)).resolves.toEqual({
        rowsWritten: 2,
      });
      expect(await tableRows('sink_up')).toEqual([
        { a: 1, b: 'a' },
        { a: 2, b: 'B' },
        { a: 3, b: 'c' },
      ]);
    });

    it("Upsert uses a composite primary key, and the source's last row for a key wins", async () => {
      await withAdminClient((c) =>
        c.query(
          'drop table if exists sink_upk; create table sink_upk(a int, b int, v text, primary key (b, a));' +
            "insert into sink_upk values (1, 1, 'x')",
        ),
      );
      await upsertInto(
        'sink_upk',
        ['a', 'b', 'v'],
        [],
        [
          { a: 1, b: 1, v: 'first' },
          { a: 1, b: 1, v: 'last' },
        ],
        [{ a: 2, b: 1, v: 'n' }],
      );
      expect(await tableRows('sink_upk')).toEqual([
        { a: 1, b: 1, v: 'last' },
        { a: 2, b: 1, v: 'n' },
      ]);
    });

    it('Upsert with every mapped column a key inserts only the missing keys', async () => {
      await withAdminClient((c) =>
        c.query(
          'drop table if exists sink_upo; create table sink_upo(a int primary key); insert into sink_upo values (1)',
        ),
      );
      await expect(upsertInto('sink_upo', ['a'], [], [{ a: 1 }, { a: 7 }])).resolves.toEqual({
        rowsWritten: 1,
      });
      expect(await tableRows('sink_upo')).toEqual([{ a: 1 }, { a: 7 }]);
    });

    it('Upsert reads only the key attributes of a PRIMARY KEY … INCLUDE', async () => {
      await withAdminClient((c) =>
        c.query(
          'drop table if exists sink_upi; create table sink_upi(a int, b text, primary key (a) include (b));' +
            "insert into sink_upi values (1, 'a')",
        ),
      );
      await upsertInto('sink_upi', ['a', 'b'], [], [{ a: 1, b: 'A' }]);
      expect(await tableRows('sink_upi')).toEqual([{ a: 1, b: 'A' }]);
    });

    it('Upsert refuses a table with no primary key and no Key columns, untouched', async () => {
      await withAdminClient((c) =>
        c.query(
          "drop table if exists sink_upz; create table sink_upz(a int, b text); insert into sink_upz values (1, 'a')",
        ),
      );
      await expect(
        upsertInto('sink_upz', ['a', 'b'], [], [{ a: 1, b: 'A' }]),
      ).rejects.toMatchObject({
        kind: 'permanent',
        message: expect.stringContaining(
          "Upsert needs Key columns: 'public.sink_upz' has no primary key",
        ),
      });
      expect(await tableRows('sink_upz')).toEqual([{ a: 1, b: 'a' }]);
    });

    it("Upsert resolves a key by the store's case rule, and stages typed values as the target types them", async () => {
      await withAdminClient((c) =>
        c.query(
          'drop table if exists sink_upt; create table sink_upt(id int, amount numeric(10,2), at timestamptz, doc jsonb);' +
            "insert into sink_upt values (1, 1.00, '2026-01-01T00:00:00Z', '{}')",
        ),
      );
      await expect(
        upsertInto(
          'sink_upt',
          ['id', 'amount', 'at', 'doc'],
          ['ID'],
          [
            { id: 1, amount: '12.50', at: '2026-10-18T12:00:00Z', doc: '{"k":1}' },
            { id: 2, amount: '3', at: '2026-10-18T13:00:00Z', doc: '[]' },
          ],
        ),
      ).resolves.toEqual({ rowsWritten: 2 });
      const rows = await withAdminClient((c) =>
        c.query(
          "select id, amount::text as amount, to_char(at at time zone 'UTC', 'HH24') as hour, doc from sink_upt order by id",
        ),
      );
      expect(rows.rows).toEqual([
        { id: 1, amount: '12.50', hour: '12', doc: { k: 1 } },
        { id: 2, amount: '3.00', hour: '13', doc: [] },
      ]);
    });

    it('Upsert fails on a NULL key and rolls back what it had written', async () => {
      await withAdminClient((c) =>
        c.query(
          "drop table if exists sink_upn; create table sink_upn(a int, b text); insert into sink_upn values (1, 'a')",
        ),
      );
      await expect(
        upsertInto('sink_upn', ['a', 'b'], ['a'], [{ a: 1, b: 'A' }], [{ a: null, b: 'n' }]),
      ).rejects.toMatchObject({ kind: 'permanent', message: expect.stringContaining('is NULL') });
      expect(await tableRows('sink_upn')).toEqual([{ a: 1, b: 'a' }]);
    });
  });

  // #1600 OR41 C3b — the claims the offline suite can only assert the shape of.
  describe('Auto-create from mapping (C3c)', () => {
    const EVERY_TYPE = [
      { name: 's', type: 'string' as const },
      { name: 'i', type: 'integer' as const },
      { name: 'n', type: 'number' as const },
      { name: 'b', type: 'boolean' as const },
      { name: 'd', type: 'date' as const },
      { name: 't', type: 'timestamp' as const },
      { name: 'x', type: 'binary' as const },
    ];

    it('creates the table with every type, writes each value back exactly, and nullable', async () => {
      await withAdminClient((c) => c.query('drop table if exists sink_ac'));
      const bytes = new Uint8Array([0, 1, 254]);
      await writePostgresDatasetRows(
        liveWrite({
          datasetConfig: { schema: 'public', table: 'sink_ac' },
          columns: EVERY_TYPE.map((c) => c.name),
          autoCreate: EVERY_TYPE,
        }),
        batchesOf([
          {
            s: 'Ann',
            i: 9007199254740993n,
            n: 1.5,
            b: true,
            d: '2026-07-15',
            t: '2026-07-15T13:45:00.000Z',
            x: bytes,
          },
          { s: null, i: null, n: null, b: null, d: null, t: null, x: null },
        ]),
      );
      const shape = await withAdminClient((c) =>
        c.query(
          `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as "notNull"
             from pg_attribute a where a.attrelid = 'public.sink_ac'::regclass and a.attnum > 0
            order by a.attnum`,
        ),
      );
      expect(shape.rows).toEqual([
        { name: 's', type: 'text', notNull: false },
        { name: 'i', type: 'bigint', notNull: false },
        { name: 'n', type: 'double precision', notNull: false },
        { name: 'b', type: 'boolean', notNull: false },
        { name: 'd', type: 'date', notNull: false },
        { name: 't', type: 'timestamp with time zone', notNull: false },
        { name: 'x', type: 'bytea', notNull: false },
      ]);
      const back = await withAdminClient((c) =>
        c.query(
          `select s, i::text as i, n, b, d::text as d, (t at time zone 'UTC')::text as t, x
             from sink_ac order by s nulls last`,
        ),
      );
      expect(back.rows[0]).toMatchObject({
        s: 'Ann',
        i: '9007199254740993',
        n: 1.5,
        b: true,
        d: '2026-07-15',
        t: '2026-07-15 13:45:00',
      });
      expect(new Uint8Array(back.rows[0].x as Buffer)).toEqual(bytes);
      expect(back.rows[1]).toMatchObject({ s: null, i: null, b: null });
    });

    it('undoes the create when the copy fails', async () => {
      await withAdminClient((c) => c.query('drop table if exists sink_ac_fail'));
      await expect(
        writePostgresDatasetRows(
          liveWrite({
            datasetConfig: { schema: 'public', table: 'sink_ac_fail' },
            columns: ['a'],
            mode: 'upsert',
            autoCreate: [{ name: 'a', type: 'integer' }],
          }),
          batchesOf([{ a: 1 }]),
        ),
      ).rejects.toThrow(/Upsert needs Key columns/);
      expect(
        (await withAdminClient((c) => c.query("select to_regclass('public.sink_ac_fail') as r")))
          .rows,
      ).toEqual([{ r: null }]);
    });

    it('makes a copy wait for one that is creating the table, then write into it', async () => {
      await withAdminClient((c) => c.query('drop table if exists sink_ac_race'));
      // The first "copy" is held open by hand, after its CREATE and before its
      // COMMIT, holding the lock a copy takes. A second copy must neither fail
      // on the uncommitted table nor create its own: it waits, then writes.
      const holder = new pg.Client({
        host: live.host,
        port: live.port,
        database: live.database,
        user: live.user,
        password,
      });
      await holder.connect();
      try {
        // The lock a copy takes, held to the session's end as a creating copy holds it.
        await holder.query('select pg_advisory_lock($1::bigint)', [
          autoCreateLockKey('public', 'sink_ac_race'),
        ]);
        await holder.query('BEGIN');
        await holder.query('CREATE TABLE public.sink_ac_race (a bigint)');
        await holder.query('insert into public.sink_ac_race values (1)');
        let settled = false;
        const second = writePostgresDatasetRows(
          liveWrite({
            datasetConfig: { schema: 'public', table: 'sink_ac_race' },
            columns: ['a'],
            autoCreate: [{ name: 'a', type: 'integer' }],
          }),
          batchesOf([{ a: 2n }]),
        ).finally(() => {
          settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(settled).toBe(false);
        await holder.query('COMMIT');
        await holder.end();
        await second;
      } finally {
        await holder.end().catch(() => undefined);
      }
      expect(
        (await withAdminClient((c) => c.query('select a from sink_ac_race order by a'))).rows,
      ).toEqual([{ a: '1' }, { a: '2' }]);
    });

    it('writes into an existing table as it is', async () => {
      await withAdminClient((c) =>
        c.query('drop table if exists sink_ac_old; create table sink_ac_old(a text, extra int)'),
      );
      await writePostgresDatasetRows(
        liveWrite({
          datasetConfig: { schema: 'public', table: 'sink_ac_old' },
          columns: ['a'],
          autoCreate: [{ name: 'a', type: 'integer' }],
        }),
        batchesOf([{ a: 5n }]),
      );
      expect(
        (await withAdminClient((c) => c.query('select a, extra from sink_ac_old'))).rows,
      ).toEqual([{ a: '5', extra: null }]);
    });
  });

  describe('Pre-copy script (C3b)', () => {
    it('runs with its bind value inside the copy, and is undone when the copy fails', async () => {
      await withAdminClient((c) =>
        c.query(
          "drop table if exists sink_pre; create table sink_pre(a int not null, b text); insert into sink_pre values (1, 'keep'), (2, 'drop')",
        ),
      );
      await writePostgresDatasetRows(
        liveWrite({
          datasetConfig: { schema: 'public', table: 'sink_pre' },
          preCopyScript: { sql: 'delete from sink_pre where b = :b', parameters: { b: 'drop' } },
        }),
        batchesOf([{ a: 3, b: 'new' }]),
      );
      expect(
        await withAdminClient((c) => c.query('select a, b from sink_pre order by a')),
      ).toMatchObject({
        rows: [
          { a: 1, b: 'keep' },
          { a: 3, b: 'new' },
        ],
      });
      await expect(
        writePostgresDatasetRows(
          liveWrite({
            datasetConfig: { schema: 'public', table: 'sink_pre' },
            preCopyScript: { sql: 'delete from sink_pre', parameters: {} },
          }),
          batchesOf([{ a: null, b: 'x' }]),
        ),
      ).rejects.toBeInstanceOf(DatasetIoError);
      expect(
        (await withAdminClient((c) => c.query('select a from sink_pre order by a'))).rows,
      ).toEqual([{ a: 1 }, { a: 3 }]);
    });

    it('lets the server refuse a second statement, so a COMMIT cannot follow an allowed word', async () => {
      await withAdminClient((c) =>
        c.query(
          "drop table if exists sink_pre2; create table sink_pre2(a int, b text); insert into sink_pre2 values (1, 'keep')",
        ),
      );
      await expect(
        writePostgresDatasetRows(
          liveWrite({
            datasetConfig: { schema: 'public', table: 'sink_pre2' },
            preCopyScript: { sql: 'delete from sink_pre2; commit', parameters: {} },
          }),
          batchesOf([{ a: 2, b: 'x' }]),
        ),
      ).rejects.toThrow(/^the Pre-copy script failed: cannot insert multiple commands/);
      expect((await withAdminClient((c) => c.query('select a from sink_pre2'))).rows).toEqual([
        { a: 1 },
      ]);
    });
  });
});
