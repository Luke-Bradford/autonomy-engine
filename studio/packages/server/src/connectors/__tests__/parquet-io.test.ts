import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { parquetWriteBuffer, type ColumnSource } from 'hyparquet-writer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatasetKind } from '@autonomy-studio/shared';
import { DatasetIoError } from '../dataset-io-error.js';
import {
  describeParquetDatasetColumns,
  readParquetDatasetBatches,
  resolveParquetDatasetAddress,
  type ParquetDatasetRead,
} from '../parquet-io.js';
import { cleanupTempRoots, tempRoot } from './temp-roots.js';

/**
 * #1405 OR14 — the `parquet` READER over an `fs` connection, on real files
 * written by the same library a copy writes them with.
 */

let root: string;
beforeEach(() => {
  root = tempRoot('parquet-root-');
});
afterEach(cleanupTempRoots);

const COLUMNS: ColumnSource[] = [
  { name: 'id', data: [1n, 2n, 3n, 4n, 5n], type: 'INT64' },
  { name: 'name', data: ['ada', 'grace', null, 'edsger', 'barbara'], type: 'STRING' },
  { name: 'score', data: [1.5, 2, 3.25, null, 0], type: 'DOUBLE' },
  { name: 'ok', data: [true, false, true, null, false], type: 'BOOLEAN' },
  {
    name: 'at',
    data: [new Date('2026-01-02T03:04:05.000Z'), null, null, null, null],
    type: 'TIMESTAMP',
  },
];

async function seed(name: string, bytes: ArrayBuffer | Uint8Array | string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, typeof bytes === 'string' ? bytes : new Uint8Array(bytes));
  return path;
}

function read(
  path: string,
  kind: DatasetKind = 'parquet',
  over: Partial<ParquetDatasetRead> = {},
): ParquetDatasetRead {
  return {
    connectionConfig: { roots: [root] },
    datasetKind: kind,
    datasetConfig: { path },
    ...over,
  };
}

async function batchesOf(args: ParquetDatasetRead): Promise<Record<string, unknown>[][]> {
  const out: Record<string, unknown>[][] = [];
  for await (const batch of readParquetDatasetBatches(args)) out.push(batch);
  return out;
}

async function refusalOf(run: () => Promise<unknown>): Promise<DatasetIoError> {
  const err = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DatasetIoError);
  return err as DatasetIoError;
}

describe('parquet reader (#1405)', () => {
  it('reads typed values across row groups, in batches of batchRows', async () => {
    const path = await seed(
      'in.parquet',
      parquetWriteBuffer({ columnData: COLUMNS, rowGroupSize: 2 }),
    );
    const batches = await batchesOf(read(path, 'parquet', { batchRows: 3 }));
    // Batches never span a row group: 2 + 2 + 1.
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
    const rows = batches.flat();
    expect(rows[0]).toEqual({
      id: 1n,
      name: 'ada',
      score: 1.5,
      ok: true,
      at: new Date('2026-01-02T03:04:05.000Z'),
    });
    expect(rows[2]).toEqual({ id: 3n, name: null, score: 3.25, ok: true, at: null });
    expect(rows.map((r) => r['id'])).toEqual([1n, 2n, 3n, 4n, 5n]);
  });

  it('describes the columns from the file’s schema', async () => {
    const path = await seed('in.parquet', parquetWriteBuffer({ columnData: COLUMNS }));
    expect(await describeParquetDatasetColumns(read(path))).toEqual([
      'id',
      'name',
      'score',
      'ok',
      'at',
    ]);
  });

  it('reads a file with no rows as no rows, and still names its columns', async () => {
    const path = await seed(
      'empty.parquet',
      parquetWriteBuffer({ columnData: [{ name: 'id', data: [], type: 'INT64' }] }),
    );
    expect(await batchesOf(read(path))).toEqual([]);
    expect(await describeParquetDatasetColumns(read(path))).toEqual(['id']);
  });

  it('reads gzip- and zstd-compressed column chunks', async () => {
    for (const [codec, compress] of [
      ['GZIP', (input: Uint8Array) => new Uint8Array(gzipSync(input))],
      ['ZSTD', (input: Uint8Array) => new Uint8Array(zstdCompressSync(input))],
    ] as const) {
      const path = await seed(
        `in-${codec}.parquet`,
        parquetWriteBuffer({ columnData: COLUMNS, codec, compressors: { [codec]: compress } }),
      );
      expect((await batchesOf(read(path))).flat()).toHaveLength(5);
    }
  });

  it('carries a nested value as its JSON text', async () => {
    const path = await seed(
      'nested.parquet',
      parquetWriteBuffer({
        columnData: [
          { name: 'id', data: [1, 2], type: 'INT32' },
          { name: 'doc', data: [{ a: 1, b: [1, 2] }, null], type: 'JSON' },
        ],
      }),
    );
    expect((await batchesOf(read(path))).flat()).toEqual([
      { id: 1, doc: '{"a":1,"b":[1,2]}' },
      { id: 2, doc: null },
    ]);
  });

  it('refuses a file that is not Parquet, naming the file', async () => {
    const path = await seed('not.parquet', 'id,name\n1,ada\n');
    const err = await refusalOf(() => batchesOf(read(path)));
    expect(err.kind).toBe('permanent');
    expect(err.message).toContain('not.parquet');
    expect(err.message).toContain('not a Parquet file');
    expect((await refusalOf(() => describeParquetDatasetColumns(read(path)))).kind).toBe(
      'permanent',
    );
  });

  it('refuses a missing file, a path outside the folders, and another kind', async () => {
    expect((await refusalOf(() => batchesOf(read(join(root, 'nope.parquet'))))).message).toContain(
      'nope.parquet',
    );
    expect((await refusalOf(() => batchesOf(read('../x.parquet')))).message).toContain(
      'outside the allowed roots',
    );
    expect((await refusalOf(() => batchesOf(read('x.parquet', 'json')))).message).toContain(
      "'json'",
    );
  });

  it('resolves the address to the confined path', async () => {
    const path = await seed('in.parquet', parquetWriteBuffer({ columnData: COLUMNS }));
    const address = await resolveParquetDatasetAddress({
      connectionConfig: { roots: [root] },
      dataset: { kind: 'parquet', config: { path } },
    });
    expect(address).toMatchObject({ kind: 'fs', store: path, object: path });
  });
});
