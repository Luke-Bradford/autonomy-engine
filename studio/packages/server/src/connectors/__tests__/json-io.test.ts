import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatasetKind } from '@autonomy-studio/shared';
import { DatasetIoError } from '../dataset-io-error.js';
import {
  describeJsonDatasetColumns,
  jsonCoercionFor,
  readJsonDatasetBatches,
  resolveJsonDatasetAddress,
  type JsonDatasetRead,
} from '../json-io.js';
import { cleanupTempRoots, tempRoot } from './temp-roots.js';

/**
 * #1405 OR14 — the `json` and `jsonl` READER over an `fs` connection, on real
 * files. The record grammar itself is `shared`'s (`json-records.test.ts`); what
 * only this layer owns is naming the columns, binding records to them, the
 * file, the decoder and gzip.
 */

let root: string;
beforeEach(() => {
  root = tempRoot('json-root-');
});
afterEach(cleanupTempRoots);

async function seed(name: string, contents: string | Uint8Array): Promise<string> {
  const path = join(root, name);
  await writeFile(path, contents);
  return path;
}

function read(
  path: string,
  kind: DatasetKind = 'json',
  config: Record<string, unknown> = {},
  over: Partial<JsonDatasetRead> = {},
): JsonDatasetRead {
  return {
    connectionConfig: { roots: [root] },
    datasetKind: kind,
    datasetConfig: { path, ...config },
    ...over,
  };
}

async function rowsOf(args: JsonDatasetRead): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for await (const batch of readJsonDatasetBatches(args)) out.push(...batch);
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

describe('json — one array of objects', () => {
  it('binds each object to the first object’s keys, carrying nested values as JSON text', async () => {
    const path = await seed(
      'in.json',
      '[{"id":1,"name":"ada","tags":["x","y"],"ok":true},\n {"id":2,"name":null,"tags":{"k":1},"ok":false}]',
    );
    expect(await rowsOf(read(path))).toEqual([
      { id: 1, name: 'ada', tags: '["x","y"]', ok: true },
      { id: 2, name: null, tags: '{"k":1}', ok: false },
    ]);
    expect(await describeJsonDatasetColumns(read(path))).toEqual(['id', 'name', 'tags', 'ok']);
  });

  it('binds a key a record leaves out as absent, so only a mapping that wants it fails', async () => {
    const path = await seed('short.json', '[{"a":1,"b":2},{"a":3}]');
    const rows = await rowsOf(read(path));
    expect(rows[1]).toEqual({ a: 3, b: undefined });
    expect(Object.keys(rows[1]!)).toEqual(['a', 'b']);
  });

  it('refuses a record with a key the first one does not have, naming the record', async () => {
    const path = await seed('extra.json', '[{"a":1},{"a":2,"b":3}]');
    const err = await refusalOf(() => rowsOf(read(path)));
    expect(err.kind).toBe('permanent');
    expect(err.message).toContain('record 2');
    expect(err.message).toContain("'b'");
  });

  it('refuses a record that is not an object', async () => {
    const path = await seed('scalar.json', '[{"a":1},5]');
    const err = await refusalOf(() => rowsOf(read(path)));
    expect(err.message).toContain('record 2 is not a JSON object');
  });

  it('refuses an empty array, which cannot name its columns', async () => {
    const path = await seed('empty.json', '[]');
    expect((await refusalOf(() => rowsOf(read(path)))).message).toContain('no records');
    expect((await refusalOf(() => describeJsonDatasetColumns(read(path)))).message).toContain(
      'no records',
    );
  });

  it('refuses a file that is not JSON, naming the file', async () => {
    const path = await seed('bad.json', '[{"a":1},{"a":}]');
    const err = await refusalOf(() => rowsOf(read(path)));
    expect(err.kind).toBe('permanent');
    expect(err.message).toContain('bad.json');
    expect(err.message).toContain('element 2');
  });

  it('refuses a file that is not UTF-8', async () => {
    const path = await seed('latin.json', Uint8Array.from([0x5b, 0x22, 0xe9, 0x22, 0x5d]));
    expect((await refusalOf(() => rowsOf(read(path)))).message).toContain('utf-8');
  });

  it('batches by batchRows', async () => {
    const path = await seed('many.json', JSON.stringify([1, 2, 3, 4, 5].map((n) => ({ n }))));
    const sizes: number[] = [];
    for await (const batch of readJsonDatasetBatches(read(path, 'json', {}, { batchRows: 2 }))) {
      sizes.push(batch.length);
    }
    expect(sizes).toEqual([2, 2, 1]);
  });
});

describe('jsonl — one object per line', () => {
  it('reads each line, gzipped too, a byte at a time', async () => {
    const text = '{"id":1,"name":"ada"}\n\n{"id":2,"name":"grace"}\n';
    const plain = await seed('in.jsonl', text);
    const gz = await seed('in.jsonl.gz', gzipSync(text));
    const expected = [
      { id: 1, name: 'ada' },
      { id: 2, name: 'grace' },
    ];
    expect(await rowsOf(read(plain, 'jsonl'))).toEqual(expected);
    expect(await rowsOf(read(gz, 'jsonl', { compression: 'gzip' }, { chunkBytes: 1 }))).toEqual(
      expected,
    );
    expect(await describeJsonDatasetColumns(read(gz, 'jsonl', { compression: 'gzip' }))).toEqual([
      'id',
      'name',
    ]);
  });

  it('refuses a line that is not JSON, naming the line', async () => {
    const path = await seed('bad.jsonl', '{"a":1}\nnope\n');
    expect((await refusalOf(() => rowsOf(read(path, 'jsonl')))).message).toContain('line 2');
  });
});

describe('the dataset around the reader', () => {
  it('refuses a dataset kind it does not read', async () => {
    const path = await seed('in.csv', 'a\n1\n');
    const err = await refusalOf(() => rowsOf(read(path, 'delimited')));
    expect(err.message).toContain("'delimited'");
  });

  it('refuses a path outside the connection’s folders', async () => {
    const err = await refusalOf(() => rowsOf(read('../elsewhere.json')));
    expect(err.message).toContain('outside the allowed roots');
  });

  it('resolves the address to the confined path', async () => {
    const path = await seed('in.json', '[]');
    const address = await resolveJsonDatasetAddress({
      connectionConfig: { roots: [root] },
      dataset: { kind: 'jsonl', config: { path } },
    });
    expect(address).toMatchObject({ kind: 'fs', store: path, object: path });
    expect(address.storeIdentity).toEqual(expect.any(String));
  });

  it('hands the pump the date format, and no null marker', () => {
    expect(jsonCoercionFor({ path: 'x.json', dateFormat: 'yyyy-MM-dd' })).toEqual({
      dateFormat: 'yyyy-MM-dd',
    });
    expect(jsonCoercionFor({ path: 'x.json' })).toEqual({});
  });
});
