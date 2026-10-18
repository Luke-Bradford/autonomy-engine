import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DatasetIoError } from '../dataset-io-error.js';
import type { PreCopyScript } from '../pre-copy-script.js';
import { writeSqliteDatasetRows, type SinkValue, type SqliteWriteMode } from '../sqlite-sink.js';
import { cleanupTempRoots, rowsOf, tempRoot, writableConfig } from './sqlite-fixtures.js';

/**
 * #1600 OR41 C3b — Copy's Pre-copy script on a real SQLite store (catalogue
 * §4.1). Every assertion reads the store, or the file system, back: the claims
 * are what the table holds and which files exist, not what the writer said.
 */

afterEach(cleanupTempRoots);

async function* batches(
  ...chunks: Record<string, SinkValue>[][]
): AsyncIterable<readonly Record<string, SinkValue>[]> {
  for (const chunk of chunks) yield chunk;
}

function store(ddl: string): { root: string; path: string } {
  const root = tempRoot();
  const path = join(root, 'pre.db');
  const db = new Database(path);
  db.exec(ddl);
  db.close();
  return { root, path };
}

function write(
  at: { root: string; path: string },
  preCopyScript: PreCopyScript,
  chunks: Record<string, SinkValue>[][],
  mode: SqliteWriteMode = 'append',
) {
  return writeSqliteDatasetRows(
    {
      connectionConfig: writableConfig(at.root, at.path),
      datasetKind: 'table',
      datasetConfig: { table: 'sink' },
      columns: ['id', 'day'],
      nullOnError: [],
      mode,
      preCopyScript,
    },
    batches(...chunks),
  );
}

async function refusal(promise: Promise<unknown>): Promise<DatasetIoError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DatasetIoError);
  return err as DatasetIoError;
}

const SEEDED =
  "CREATE TABLE sink (id INTEGER, day TEXT); INSERT INTO sink VALUES (1, 'mon'), (2, 'tue');";

describe('Pre-copy script (SQLite)', () => {
  it('runs once before the rows, with its bind values', async () => {
    const at = store(SEEDED);
    const result = await write(
      at,
      { sql: 'DELETE FROM sink WHERE day = :day', parameters: { day: 'tue' } },
      [[{ id: 3, day: 'tue' }], [{ id: 4, day: 'tue' }]],
    );
    expect(result.rowsWritten).toBe(2);
    expect(rowsOf(at.path)).toEqual([
      { id: 1, day: 'mon' },
      { id: 3, day: 'tue' },
      { id: 4, day: 'tue' },
    ]);
  });

  it('runs even when the source has no rows', async () => {
    const at = store(SEEDED);
    await write(at, { sql: 'DELETE FROM sink', parameters: {} }, []);
    expect(rowsOf(at.path)).toEqual([]);
  });

  it('runs before the describe, so a column it adds can be written', async () => {
    const at = store('CREATE TABLE sink (id INTEGER)');
    await write(at, { sql: 'ALTER TABLE sink ADD COLUMN day TEXT', parameters: {} }, [
      [{ id: 1, day: 'mon' }],
    ]);
    expect(rowsOf(at.path)).toEqual([{ id: 1, day: 'mon' }]);
  });

  it('is undone with the copy when a later row fails', async () => {
    const at = store(
      "CREATE TABLE sink (id INTEGER NOT NULL, day TEXT); INSERT INTO sink VALUES (1, 'mon');",
    );
    await refusal(
      write(at, { sql: 'DELETE FROM sink', parameters: {} }, [[{ id: null, day: 'tue' }]]),
    );
    expect(rowsOf(at.path)).toEqual([{ id: 1, day: 'mon' }]);
  });

  it('reports a failing script as the Pre-copy script, and writes nothing', async () => {
    const at = store(SEEDED);
    const err = await refusal(
      write(at, { sql: 'DELETE FROM missing_table', parameters: {} }, [[{ id: 9, day: 'x' }]]),
    );
    expect(err.message).toMatch(/^the Pre-copy script failed: .*missing_table/);
    expect(rowsOf(at.path)).toHaveLength(2);
  });

  // The confinement boundary. MEASURED (better-sqlite3 12, inside `begin
  // immediate`): `ATTACH` runs, and since the sink opens with `fileMustExist`
  // it can reach any EXISTING database file the process can open; the sink's
  // dataset may then name the attached schema. `VACUUM INTO` SQLite refuses
  // inside a transaction anyway. Each must be refused by the allow-list itself,
  // so these assert its sentence, not merely a failure.
  it.each([
    ['ATTACH', (outside: string) => `ATTACH DATABASE '${outside}' AS o`, /may not run ATTACH/],
    [
      'a leading ;',
      (outside: string) => `;ATTACH DATABASE '${outside}' AS o`,
      /must begin with its statement/,
    ],
    [
      'a comment, then ATTACH',
      (outside: string) => `/* delete */ ATTACH DATABASE '${outside}' AS o`,
      /may not run ATTACH/,
    ],
    ['VACUUM INTO', (outside: string) => `VACUUM INTO '${outside}'`, /may not run VACUUM/],
  ])('refuses %s before it reaches the store', async (_label, sqlFor, sentence) => {
    const at = store(SEEDED);
    const elsewhere = store('CREATE TABLE sink (id INTEGER, day TEXT)');
    const err = await refusal(write(at, { sql: sqlFor(elsewhere.path), parameters: {} }, [[]]));
    expect(err.kind).toBe('permanent');
    expect(err.message).toMatch(sentence);
    expect(rowsOf(at.path)).toHaveLength(2);
  });

  it.each(['PRAGMA writable_schema = 1', 'COMMIT', 'BEGIN', 'SELECT 1'])(
    'refuses a script that begins %s, naming what it may begin with',
    async (sql) => {
      const at = store(SEEDED);
      const err = await refusal(write(at, { sql, parameters: {} }, [[]]));
      expect(err.message).toMatch(
        /^a Pre-copy script on SQLite may not run \w+; it may begin with INSERT, UPDATE/,
      );
    },
  );

  it('refuses a second statement (better-sqlite3 prepares one)', async () => {
    const at = store(SEEDED);
    const err = await refusal(
      write(at, { sql: 'DELETE FROM sink; DROP TABLE sink', parameters: {} }, [[]]),
    );
    expect(err.message).toMatch(/^the Pre-copy script failed: .*more than one statement/);
    expect(rowsOf(at.path)).toHaveLength(2);
  });

  it('names a :name with no bind value', async () => {
    const at = store(SEEDED);
    const err = await refusal(
      write(at, { sql: 'DELETE FROM sink WHERE day = :day AND id = :id', parameters: { id: 1 } }, [
        [],
      ]),
    );
    expect(err.message).toBe(
      "the Pre-copy script binds 'day' with no value in Pre-copy bind values",
    );
  });

  it('binds only the names the statement uses, so a spare value is not an error', async () => {
    const at = store(SEEDED);
    await write(at, { sql: 'DELETE FROM sink WHERE id = :id', parameters: { id: 2, spare: 'x' } }, [
      [],
    ]);
    expect(rowsOf(at.path)).toEqual([{ id: 1, day: 'mon' }]);
  });

  it('runs before Overwrite, which then deletes what the script inserted', async () => {
    const at = store(SEEDED);
    await write(
      at,
      { sql: "INSERT INTO sink VALUES (7, 'sun')", parameters: {} },
      [[{ id: 8, day: 'sat' }]],
      'overwrite',
    );
    expect(rowsOf(at.path)).toEqual([{ id: 8, day: 'sat' }]);
  });
});
