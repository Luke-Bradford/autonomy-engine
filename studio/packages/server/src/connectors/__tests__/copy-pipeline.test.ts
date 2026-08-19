import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CopyMappingError,
  newCopyCounters,
  pumpCopyRows,
  type CopyPumpMappingEntry,
} from '@autonomy-studio/shared';
import {
  DatasetIoError,
  readSqliteDatasetBatches,
  writeSqliteDatasetRows,
  type SinkValue,
} from '../sqlite.js';
import {
  cleanupTempRoots,
  rowsOf,
  seedDb,
  seedSink,
  tempRoot,
  writableConfig,
} from './sqlite-fixtures.js';

/**
 * #996 M5 — the three slices COMPOSED: reader (#1119) → pump (#1129) → sink (#1125),
 * SQLite → SQLite, against real database files.
 *
 * Each slice is thoroughly tested alone and none of that proves they fit. This
 * suite exists for the joins: that the pump's yielded batch type is what the
 * sink accepts, that `rowsRead = rowsWritten + rowsFailed` holds end to end, and
 * that a copy-wide refusal raised in the MIDDLE of the sink's open transaction
 * still reaches the caller as a permanent failure with nothing written.
 *
 * It is deliberately NOT the `copy` activity: there is no catalog entry and no
 * dataset resolution yet (#1130). This is the data path under them.
 */

afterEach(cleanupTempRoots);

const idAndName: CopyPumpMappingEntry[] = [
  { source: 'id', sink: 'id', type: 'integer', onError: 'fail' },
  { source: 'name', sink: 'name', type: 'string', onError: 'fail' },
];

/** A source table of TEXT values, for exercising coercion against a real store. */
function seedText(root: string, values: string[], name = 'src.db'): string {
  const path = join(root, name);
  const db = new Database(path);
  db.exec('CREATE TABLE src (v TEXT)');
  const insert = db.prepare('INSERT INTO src (v) VALUES (?)');
  for (const v of values) insert.run(v);
  db.close();
  return path;
}

describe('reader → pump → sink', () => {
  it('copies every row, and the counters agree end to end', async () => {
    const root = tempRoot();
    seedDb(root, 5);
    const sinkPath = seedSink(root, 'out.db');
    const counters = newCopyCounters();

    const result = await writeSqliteDatasetRows(
      {
        connectionConfig: writableConfig(root, sinkPath),
        datasetKind: 'table',
        datasetConfig: { table: 'sink' },
        columns: ['id', 'name'],
        mode: 'append',
        onBatch: (rowsWritten) => (counters.rowsWritten = rowsWritten),
      },
      pumpCopyRows(
        readSqliteDatasetBatches({
          connectionConfig: { roots: [root], path: join(root, 'app.db') },
          datasetKind: 'table',
          datasetConfig: { table: 't' },
          batchRows: 2,
        }),
        { mapping: idAndName, counters },
      ),
    );

    expect(result.rowsWritten).toBe(5);
    expect(counters).toMatchObject({
      rowsRead: 5,
      rowsWritten: 5,
      rowsFailed: 0,
      truncated: false,
      failuresByCode: {},
    });
    expect(rowsOf(sinkPath, 'SELECT id, name FROM sink ORDER BY id')).toEqual([
      { id: 1, name: 'row-1' },
      { id: 2, name: 'row-2' },
      { id: 3, name: 'row-3' },
      { id: 4, name: 'row-4' },
      { id: 5, name: 'row-5' },
    ]);
  });

  it('a row that fails coercion never reaches the store, and the rest still land', async () => {
    const root = tempRoot();
    const srcPath = seedText(root, ['1', '1.5', '3']);
    const sinkPath = seedSink(root, 'out.db');
    const counters = newCopyCounters();

    await writeSqliteDatasetRows(
      {
        connectionConfig: writableConfig(root, sinkPath),
        datasetKind: 'table',
        datasetConfig: { table: 'sink' },
        columns: ['id'],
        mode: 'append',
        onBatch: (rowsWritten) => (counters.rowsWritten = rowsWritten),
      },
      pumpCopyRows(
        readSqliteDatasetBatches({
          connectionConfig: { roots: [root], path: srcPath },
          datasetKind: 'table',
          datasetConfig: { table: 'src' },
        }),
        {
          mapping: [{ source: 'v', sink: 'id', type: 'integer', onError: 'fail' }],
          counters,
        },
      ),
    );

    // §6.2's headline refusal, proved against a store: "1.5" does not become 1.
    expect(rowsOf(sinkPath, 'SELECT id FROM sink ORDER BY rowid')).toEqual([{ id: 1 }, { id: 3 }]);
    expect(counters.rowsRead).toBe(counters.rowsWritten + counters.rowsFailed);
    expect(counters.failuresByCode).toEqual({ not_integral: 1 });
  });

  it('refuses a broken mapping through the sink as PERMANENT, with nothing written', async () => {
    const root = tempRoot();
    seedDb(root, 3);
    const sinkPath = seedSink(root, 'out.db');
    const counters = newCopyCounters();

    const err = await writeSqliteDatasetRows(
      {
        connectionConfig: writableConfig(root, sinkPath),
        datasetKind: 'table',
        datasetConfig: { table: 'sink' },
        columns: ['id'],
        mode: 'append',
      },
      pumpCopyRows(
        readSqliteDatasetBatches({
          connectionConfig: { roots: [root], path: join(root, 'app.db') },
          datasetKind: 'table',
          datasetConfig: { table: 't' },
        }),
        { mapping: [{ source: 'nosuch', sink: 'id', type: 'integer', onError: 'fail' }], counters },
      ),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );

    // The sink wraps whatever its iterator throws. The KIND is what §4 cares
    // about and `storeFailure` gets it right by default; the original error
    // survives as `cause`, so slice 4 can still read the code.
    expect(err).toBeInstanceOf(DatasetIoError);
    const failure = err as DatasetIoError;
    expect(failure.kind).toBe('permanent');
    expect(failure.message).toContain('nosuch');
    expect((failure.cause as CopyMappingError).code).toBe('missing_source_column');
    expect(rowsOf(sinkPath)).toEqual([]);
    expect(counters.rowsRead).toBe(0);
  });

  it('an `overwrite` copy that fails mid-stream leaves the ORIGINAL rows intact', async () => {
    // The end-to-end property, not the mechanism: the sink's transaction is what
    // protects those rows, and whether it unwinds by an explicit `rollback` or by
    // the connection closing on an uncommitted transaction is slice 2's business.
    // Its suite owns the explicit path (deleting the `rollback` call turns two of
    // its tests red and this one stays green — checked, not assumed).
    const root = tempRoot();
    const srcPath = seedText(root, ['1', '2']);
    const sinkPath = seedSink(root, 'out.db');
    const db = new Database(sinkPath);
    db.prepare('INSERT INTO sink (id, name) VALUES (?, ?)').run(99, 'existing');
    db.close();

    async function* explodes(): AsyncIterable<readonly Record<string, SinkValue>[]> {
      for await (const batch of pumpCopyRows(
        readSqliteDatasetBatches({
          connectionConfig: { roots: [root], path: srcPath },
          datasetKind: 'table',
          datasetConfig: { table: 'src' },
        }),
        {
          mapping: [{ source: 'v', sink: 'id', type: 'integer', onError: 'fail' }],
          counters: newCopyCounters(),
        },
      )) {
        yield batch;
        throw new Error('the source went away mid-copy');
      }
    }

    await expect(
      writeSqliteDatasetRows(
        {
          connectionConfig: writableConfig(root, sinkPath),
          datasetKind: 'table',
          datasetConfig: { table: 'sink' },
          columns: ['id'],
          mode: 'overwrite',
        },
        explodes(),
      ),
    ).rejects.toBeInstanceOf(DatasetIoError);

    expect(rowsOf(sinkPath, 'SELECT id, name FROM sink')).toEqual([{ id: 99, name: 'existing' }]);
  });
});
