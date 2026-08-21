import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { refuseForeignSink, writeRowsToSink } from '../copy-sink.js';
import type { PostgresClient, PostgresClientFactory } from '../postgres-session.js';
import type { SinkValue } from '../sqlite-sink.js';
import type { ActivityContext, ResolvedDataset } from '../types.js';

/**
 * #1196 M10 slice 3a — the SINK-KIND dispatch itself.
 *
 * It has its own file because it is the module the mesh runs through: all three
 * source adapters hand `writeRows` to it, so a fault here is a fault in every
 * pairing at once. The two WRITERS are covered by `sqlite-sink`'s and
 * `postgres-sink`'s own suites; what is asserted here is that the right one is
 * CHOSEN, that the refusal above them is derived from the catalog rather than
 * from a literal, and that an unknown kind fails CLOSED.
 *
 * The postgres arm goes through an injected client factory, which is what makes
 * the `sqlite`-source → `postgres`-sink and `fs`-source → `postgres`-sink
 * pairings assertable at all — neither of those adapters threads a factory of
 * its own, so before this file the mesh's new half had no test that could reach
 * it without a live server.
 */

const tmp = mkdtempSync(join(tmpdir(), 'copy-sink-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type ActivitySink = NonNullable<ActivityContext['sink']>;

function dataset(config: Record<string, unknown>): ResolvedDataset {
  return { id: 'ds', name: 'ds', kind: 'table', config, columns: [] };
}

async function* oneBatch(
  ...rows: Record<string, SinkValue>[]
): AsyncIterable<readonly Record<string, SinkValue>[]> {
  yield rows;
}

describe('refuseForeignSink (#1196)', () => {
  it('accepts every kind the CATALOG declares a sink, and names them all when it refuses', () => {
    // Derived from `sinkConnectionKinds`, never a literal — which is the point
    // of the rung existing once instead of three times. Before slice 3a each
    // source adapter hand-wrote its own sentence around a hardcoded 'sqlite',
    // so opening the list would have left three sentences saying otherwise.
    expect(refuseForeignSink({ kind: 'sqlite', connectionConfig: {} })).toBeNull();
    expect(refuseForeignSink({ kind: 'postgres', connectionConfig: {} })).toBeNull();
    const refusal = refuseForeignSink({ kind: 'fs', connectionConfig: {} });
    expect(refusal).toContain("'sqlite'");
    expect(refusal).toContain("'postgres'");
    expect(refusal).toContain("the sink connection is 'fs'");
  });

  it('refuses a non-store kind too', () => {
    expect(refuseForeignSink({ kind: 'http', connectionConfig: {} })).not.toBeNull();
  });
});

describe('writeRowsToSink dispatch (#1196)', () => {
  it('routes a sqlite sink to the sqlite writer, and really writes', async () => {
    const path = join(tmp, 'sink.db');
    const db = new Database(path);
    db.exec('create table people (name text, age integer)');
    db.close();

    const connection: ActivitySink = {
      kind: 'sqlite',
      connectionConfig: { roots: [tmp], path, writable: true },
    };
    const result = await writeRowsToSink(
      {
        dataset: dataset({ table: 'people' }),
        connection,
        sinkSecret: null,
        columns: ['name', 'age'],
        mode: 'append',
        onBatch: () => {},
        signal: undefined,
      },
      oneBatch({ name: 'ada', age: 36 }),
    );
    expect(result).toEqual({ rowsWritten: 1 });

    const check = new Database(path, { readonly: true });
    expect(check.prepare('select name, age from people').all()).toEqual([{ name: 'ada', age: 36 }]);
    check.close();
  });

  it('routes a postgres sink to the postgres writer — the mesh half no adapter can inject', async () => {
    // This is the `sqlite`-source (or `fs`-source) → `postgres`-sink path. Those
    // adapters pass no client factory, so production correctly uses the real
    // `pg.Client`; here the factory is injected at the seam instead, which is
    // the only way to assert the routing without a live server.
    const statements: string[] = [];
    const factory: PostgresClientFactory = (): PostgresClient => ({
      async connect() {},
      async query(sql: string) {
        statements.push(sql);
        if (sql.includes('to_regclass')) {
          return {
            rows: [
              {
                schema: 'public',
                name: 'people',
                relkind: 'r',
                columns: [
                  { name: 'name', generated: false, identityAlways: false },
                  { name: 'age', generated: false, identityAlways: false },
                ],
              },
            ],
            fields: [],
          };
        }
        return { rows: [], fields: [] };
      },
      async end() {},
    });

    const connection: ActivitySink = {
      kind: 'postgres',
      connectionConfig: {
        host: 'db.example.test',
        database: 'app',
        user: 'app_rw',
        sslmode: 'disable',
        writable: true,
      },
    };
    const result = await writeRowsToSink(
      {
        dataset: dataset({ schema: 'public', table: 'people' }),
        connection,
        sinkSecret: 'pw',
        columns: ['name', 'age'],
        mode: 'append',
        onBatch: () => {},
        signal: undefined,
        createClient: factory,
      },
      oneBatch({ name: 'ada', age: 36 }),
    );
    expect(result).toEqual({ rowsWritten: 1 });
    expect(statements).toContain('BEGIN');
    expect(statements.some((s) => s.startsWith('INSERT INTO'))).toBe(true);
    expect(statements).toContain('COMMIT');
  });

  it('carries the SINK secret to the postgres writer, not the source’s', async () => {
    // `sinkSecret` is `runActivity`'s FOURTH argument and is distinct from
    // `secret`. A copy from sqlite into postgres has no source credential at
    // all, so if this seam dropped it every such copy would fail "this postgres
    // connection has no secret" after the source was already open.
    await expect(
      writeRowsToSink(
        {
          dataset: dataset({ schema: 'public', table: 'people' }),
          connection: {
            kind: 'postgres',
            connectionConfig: {
              host: 'db.example.test',
              database: 'app',
              user: 'app_rw',
              sslmode: 'disable',
              writable: true,
            },
          },
          sinkSecret: null,
          columns: ['name'],
          mode: 'append',
          onBatch: () => {},
          signal: undefined,
        },
        oneBatch({ name: 'ada' }),
      ),
    ).rejects.toMatchObject({
      kind: 'permanent',
      message: expect.stringContaining('no secret'),
    });
  });

  it('refuses an unknown sink kind rather than falling through to a default store', async () => {
    // Unreachable through `refuseForeignSink`, which the ladder runs first. Kept
    // as the fail-CLOSED backstop for a caller that bypassed the catalog: a
    // silent default here would write the right rows into the wrong store.
    await expect(
      writeRowsToSink(
        {
          dataset: dataset({ table: 'people' }),
          connection: { kind: 'http', connectionConfig: {} },
          sinkSecret: null,
          columns: ['name'],
          mode: 'append',
          onBatch: () => {},
          signal: undefined,
        },
        oneBatch({ name: 'ada' }),
      ),
    ).rejects.toMatchObject({
      kind: 'permanent',
      message: expect.stringContaining("no copy sink writer exists for a 'http' store"),
    });
  });

  it('refuses a malformed sqlite sink config as a SINK, not as an anonymous store', async () => {
    // The sentence matters: the running adapter is the SOURCE's, so "invalid
    // sqlite connection config" would read as a complaint about the connection
    // the operator is copying FROM.
    await expect(
      writeRowsToSink(
        {
          dataset: dataset({ table: 'people' }),
          connection: { kind: 'sqlite', connectionConfig: { path: 42 } },
          sinkSecret: null,
          columns: ['name'],
          mode: 'append',
          onBatch: () => {},
          signal: undefined,
        },
        oneBatch({ name: 'ada' }),
      ),
    ).rejects.toMatchObject({
      kind: 'permanent',
      message: expect.stringContaining('invalid sqlite sink connection config'),
    });
  });
});
