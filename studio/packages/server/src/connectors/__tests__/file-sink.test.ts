import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { COPY_ACTIVITY_TYPE, type CopyWriteMode, type DatasetKind } from '@autonomy-studio/shared';
import { DatasetIoError } from '../dataset-io-error.js';
import { writeRowsToSink, type SinkWriteRequest } from '../copy-sink.js';
import { readDelimitedDatasetBatches } from '../delimited-io.js';
import { fsAdapter } from '../fs.js';
import { readJsonDatasetBatches } from '../json-io.js';
import type { SinkValue } from '../sqlite-sink.js';
import type { ActivityContext, ActivityEvent } from '../types.js';
import { cleanupTempRoots, tempRoot } from './temp-roots.js';

/**
 * #1405 OR14 — a file as a copy SINK: rows written into a delimited file on an
 * `fs` connection, through the real sink dispatch (`writeRowsToSink`), and read
 * back through the real delimited READER. The round trip is the contract: what
 * the writer puts down, the reader takes up unchanged.
 */

afterEach(cleanupTempRoots);

type Rows = readonly Record<string, SinkValue>[];

async function* batchesOf(...batches: Rows[]): AsyncIterable<Rows> {
  for (const batch of batches) yield batch;
}

function request(over: {
  root: string;
  config: Record<string, unknown>;
  kind?: DatasetKind;
  columns?: readonly string[];
  mode?: CopyWriteMode;
  writable?: boolean;
  preCopyScript?: SinkWriteRequest['preCopyScript'];
  keyColumns?: readonly string[];
  verifyBeforeCommit?: SinkWriteRequest['verifyBeforeCommit'];
  onBatch?: (rowsWritten: number) => void;
  signal?: AbortSignal;
}): SinkWriteRequest {
  return {
    dataset: {
      id: 'ds-out',
      name: 'out',
      kind: over.kind ?? 'delimited',
      config: over.config,
      columns: [],
    },
    connection: {
      kind: 'fs',
      connectionConfig: { roots: [over.root], writable: over.writable ?? true },
    },
    sinkSecret: null,
    columns: over.columns ?? ['id', 'name'],
    nullOnError: [],
    mode: over.mode ?? 'overwrite',
    keyColumns: over.keyColumns ?? [],
    preCopyScript: over.preCopyScript ?? null,
    autoCreate: null,
    onRowRejected: null,
    verifyBeforeCommit: over.verifyBeforeCommit ?? null,
    onBatch: over.onBatch ?? (() => undefined),
    signal: over.signal,
  };
}

async function readBack(
  root: string,
  config: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for await (const batch of readDelimitedDatasetBatches({
    connectionConfig: { roots: [root] },
    datasetKind: 'delimited',
    datasetConfig: config,
  })) {
    rows.push(...batch);
  }
  return rows;
}

async function refusal(promise: Promise<unknown>): Promise<DatasetIoError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DatasetIoError);
  return err as DatasetIoError;
}

describe('a delimited file as a copy sink (#1405)', () => {
  it('writes a header and every row, and the reader reads them back unchanged', async () => {
    const root = tempRoot('file-sink-');
    const config = { path: 'out.csv', header: true };
    const ticks: number[] = [];

    const result = await writeRowsToSink(
      request({ root, config, onBatch: (n) => ticks.push(n) }),
      batchesOf(
        [
          { id: 1, name: 'ada' },
          { id: 2, name: 'say "hi", grace' },
        ],
        [{ id: 3n, name: 'two\nlines' }],
      ),
    );

    expect(result).toEqual({ rowsWritten: 3 });
    expect(ticks).toEqual([2, 3]);
    expect(readFileSync(join(root, 'out.csv'), 'utf8')).toBe(
      'id,name\r\n1,ada\r\n2,"say ""hi"", grace"\r\n3,"two\nlines"\r\n',
    );
    expect(await readBack(root, config)).toEqual([
      { id: '1', name: 'ada' },
      { id: '2', name: 'say "hi", grace' },
      { id: '3', name: 'two\nlines' },
    ]);
  });

  it('writes no header row when the dataset has none', async () => {
    const root = tempRoot('file-sink-');
    await writeRowsToSink(
      request({ root, config: { path: 'out.csv', header: false } }),
      batchesOf([{ id: 1, name: 'ada' }]),
    );
    expect(readFileSync(join(root, 'out.csv'), 'utf8')).toBe('1,ada\r\n');
  });

  it('writes each value type as text, a null as the null marker, and bytes as base64', async () => {
    const root = tempRoot('file-sink-');
    const config = { path: 'out.csv', header: true, nullValue: '\\N', delimiter: ';' };
    await writeRowsToSink(
      request({ root, config, columns: ['n', 'b', 'x', 'bin', 'empty'] }),
      batchesOf([
        { n: 1.5, b: true, x: null, bin: new Uint8Array([104, 105]), empty: '' },
        { n: -2, b: false, x: 'v', bin: null, empty: 'e' },
      ]),
    );
    expect(readFileSync(join(root, 'out.csv'), 'utf8')).toBe(
      'n;b;x;bin;empty\r\n1.5;true;\\N;aGk=;""\r\n-2;false;v;\\N;e\r\n',
    );
  });

  it('writes the declared encoding, and the reader decodes it back', async () => {
    const root = tempRoot('file-sink-');
    for (const encoding of ['utf-16le', 'utf-16be', 'windows-1252'] as const) {
      const config = { path: `out-${encoding}.csv`, header: true, encoding };
      await writeRowsToSink(request({ root, config }), batchesOf([{ id: 1, name: 'café €5' }]));
      expect(await readBack(root, config)).toEqual([{ id: '1', name: 'café €5' }]);
    }
    // The windows-1252 bytes are the code page's own, not UTF-8's.
    expect([...readFileSync(join(root, 'out-windows-1252.csv'))].slice(-9)).toEqual([
      0x63, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x35, 0x0d, 0x0a,
    ]);
  });

  it('refuses a value windows-1252 cannot hold, and leaves no file behind', async () => {
    const root = tempRoot('file-sink-');
    const err = await refusal(
      writeRowsToSink(
        request({ root, config: { path: 'out.csv', header: true, encoding: 'windows-1252' } }),
        batchesOf([{ id: 1, name: '日本' }]),
      ),
    );
    expect(err.kind).toBe('permanent');
    expect(err.message).toContain('windows-1252');
    expect(readdirSync(root)).toEqual([]);
  });

  it('gzips the file when the dataset says so, and the reader reads it back', async () => {
    const root = tempRoot('file-sink-');
    const config = { path: 'out.csv.gz', header: true, compression: 'gzip' };
    await writeRowsToSink(request({ root, config }), batchesOf([{ id: 1, name: 'ada' }]));
    expect(gunzipSync(readFileSync(join(root, 'out.csv.gz'))).toString('utf8')).toBe(
      'id,name\r\n1,ada\r\n',
    );
    expect(await readBack(root, config)).toEqual([{ id: '1', name: 'ada' }]);
  });

  it('Overwrite replaces an existing file whole', async () => {
    const root = tempRoot('file-sink-');
    writeFileSync(join(root, 'out.csv'), 'old,file\r\n9,z\r\n');
    await writeRowsToSink(
      request({ root, config: { path: 'out.csv', header: true }, mode: 'overwrite' }),
      batchesOf([{ id: 1, name: 'ada' }]),
    );
    expect(readFileSync(join(root, 'out.csv'), 'utf8')).toBe('id,name\r\n1,ada\r\n');
  });

  it('Append writes a new file, and refuses to replace one that is already there', async () => {
    const root = tempRoot('file-sink-');
    const config = { path: 'run-1.csv', header: true };
    await writeRowsToSink(
      request({ root, config, mode: 'append' }),
      batchesOf([{ id: 1, name: 'ada' }]),
    );
    expect(readFileSync(join(root, 'run-1.csv'), 'utf8')).toBe('id,name\r\n1,ada\r\n');

    const err = await refusal(
      writeRowsToSink(
        request({ root, config, mode: 'append' }),
        batchesOf([{ id: 2, name: 'grace' }]),
      ),
    );
    expect(err.kind).toBe('permanent');
    expect(err.message).toContain('already exists');
    // The first run's file is untouched, and no temp is left beside it.
    expect(readFileSync(join(root, 'run-1.csv'), 'utf8')).toBe('id,name\r\n1,ada\r\n');
    expect(readdirSync(root)).toEqual(['run-1.csv']);
  });

  it('leaves the old file whole when the rows fail part-way', async () => {
    const root = tempRoot('file-sink-');
    writeFileSync(join(root, 'out.csv'), 'old\r\n');
    async function* failing(): AsyncIterable<Rows> {
      yield [{ id: 1, name: 'ada' }];
      throw new DatasetIoError('permanent', 'row 2 failed coercion');
    }
    const err = await refusal(
      writeRowsToSink(request({ root, config: { path: 'out.csv', header: true } }), failing()),
    );
    // The reader's own error reaches the copy unchanged.
    expect(err.message).toBe('row 2 failed coercion');
    expect(readFileSync(join(root, 'out.csv'), 'utf8')).toBe('old\r\n');
    expect(readdirSync(root)).toEqual(['out.csv']);
  });

  it('runs Verify after copy before the file is put in place', async () => {
    const root = tempRoot('file-sink-');
    const seen: number[] = [];
    const err = await refusal(
      writeRowsToSink(
        request({
          root,
          config: { path: 'out.csv', header: true },
          verifyBeforeCommit: (n) => {
            seen.push(n);
            return 'counts differ';
          },
        }),
        batchesOf([{ id: 1, name: 'ada' }]),
      ),
    );
    expect(seen).toEqual([1]);
    expect(err.message).toBe('counts differ');
    expect(existsSync(join(root, 'out.csv'))).toBe(false);
  });

  it('refuses a connection without Allow writes', async () => {
    const root = tempRoot('file-sink-');
    const err = await refusal(
      writeRowsToSink(
        request({ root, config: { path: 'out.csv', header: true }, writable: false }),
        batchesOf([{ id: 1, name: 'ada' }]),
      ),
    );
    expect(err.kind).toBe('permanent');
    expect(err.message).toContain('Allow writes');
    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses a path outside the connection’s folders', async () => {
    const root = tempRoot('file-sink-');
    mkdirSync(join(root, 'inner'));
    const err = await refusal(
      writeRowsToSink(
        request({
          root: join(root, 'inner'),
          config: { path: '../escape.csv', header: true },
        }),
        batchesOf([{ id: 1, name: 'ada' }]),
      ),
    );
    expect(err.kind).toBe('permanent');
    expect(err.message).toContain('outside the allowed roots');
    expect(existsSync(join(root, 'escape.csv'))).toBe(false);
  });

  it('refuses Upsert, a Pre-copy script, and a dataset kind it cannot write', async () => {
    const root = tempRoot('file-sink-');
    const config = { path: 'out.csv', header: true };
    const rows = () => batchesOf([{ id: 1, name: 'ada' }]);
    expect(
      (await refusal(writeRowsToSink(request({ root, config, mode: 'upsert' }), rows()))).message,
    ).toContain('Upsert');
    expect(
      (
        await refusal(
          writeRowsToSink(
            request({ root, config, preCopyScript: { sql: 'delete from t', parameters: {} } }),
            rows(),
          ),
        )
      ).message,
    ).toContain('Pre-copy script');
    expect(
      (await refusal(writeRowsToSink(request({ root, config, kind: 'excel' }), rows()))).message,
    ).toContain("'excel'");
    expect(readdirSync(root)).toEqual([]);
  });

  it('stops on a cancelled signal and leaves nothing behind', async () => {
    const root = tempRoot('file-sink-');
    const abort = new AbortController();
    abort.abort();
    const err = await refusal(
      writeRowsToSink(
        request({ root, config: { path: 'out.csv', header: true }, signal: abort.signal }),
        batchesOf([{ id: 1, name: 'ada' }]),
      ),
    );
    expect(err.kind).toBe('cancelled');
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('a Copy activity writing a file (#1405)', () => {
  it('copies a CSV into JSON Lines, typed by the mapping', async () => {
    const root = tempRoot('file-sink-');
    writeFileSync(join(root, 'in.csv'), 'id,name\n1,ada\n2,\n');
    const ctx = {
      runId: 'run-1',
      nodeId: 'n1',
      attemptId: 'a1',
      activityType: COPY_ACTIVITY_TYPE,
      input: {
        mode: 'overwrite',
        mapping: [
          { source: 'id', sink: 'id', type: 'integer' },
          { source: 'name', sink: 'name', type: 'string' },
        ],
      },
      connectionConfig: { roots: [root] },
      sink: { kind: 'fs', connectionConfig: { roots: [root], writable: true } },
      datasets: {
        source: {
          id: 'ds-in',
          name: 'in',
          kind: 'delimited',
          config: { path: 'in.csv', header: true, nullValue: '' },
          columns: [],
        },
        sink: {
          id: 'ds-out',
          name: 'out',
          kind: 'jsonl',
          config: { path: 'out.jsonl' },
          columns: [],
        },
      },
      signal: new AbortController().signal,
    } as unknown as ActivityContext;

    const events: ActivityEvent[] = [];
    for await (const event of fsAdapter.runActivity(ctx, null)) events.push(event);

    expect(events.at(-1)).toMatchObject({ type: 'succeeded', outputs: { rowsWritten: 2 } });
    expect(readFileSync(join(root, 'out.jsonl'), 'utf8')).toBe(
      '{"id":1,"name":"ada"}\n{"id":2,"name":null}\n',
    );
  });

  it('copies a CSV into a gzipped CSV with other options, typed by the mapping', async () => {
    const root = tempRoot('file-sink-');
    writeFileSync(join(root, 'in.csv'), 'id,name\n1,ada\n2,grace\n');
    const sinkConfig = { path: 'out.csv.gz', header: true, delimiter: '|', compression: 'gzip' };
    const ctx = {
      runId: 'run-1',
      nodeId: 'n1',
      attemptId: 'a1',
      activityType: COPY_ACTIVITY_TYPE,
      input: {
        mode: 'overwrite',
        mapping: [
          { source: 'name', sink: 'who', type: 'string' },
          { source: 'id', sink: 'n', type: 'integer' },
        ],
      },
      connectionConfig: { roots: [root] },
      sink: { kind: 'fs', connectionConfig: { roots: [root], writable: true } },
      datasets: {
        source: {
          id: 'ds-in',
          name: 'in',
          kind: 'delimited',
          config: { path: 'in.csv', header: true },
          columns: [],
        },
        sink: { id: 'ds-out', name: 'out', kind: 'delimited', config: sinkConfig, columns: [] },
      },
      signal: new AbortController().signal,
    } as unknown as ActivityContext;

    const events: ActivityEvent[] = [];
    for await (const event of fsAdapter.runActivity(ctx, null)) events.push(event);

    expect(events.at(-1)).toMatchObject({
      type: 'succeeded',
      outputs: { rowsRead: 2, rowsWritten: 2, rowsFailed: 0 },
    });
    expect(gunzipSync(readFileSync(join(root, 'out.csv.gz'))).toString('utf8')).toBe(
      'who|n\r\nada|1\r\ngrace|2\r\n',
    );
  });
});

async function readJsonBack(
  root: string,
  kind: DatasetKind,
  config: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for await (const batch of readJsonDatasetBatches({
    connectionConfig: { roots: [root] },
    datasetKind: kind,
    datasetConfig: config,
  })) {
    rows.push(...batch);
  }
  return rows;
}

describe('a JSON or JSON Lines file as a copy sink (#1405)', () => {
  const rows = (): AsyncIterable<Rows> =>
    batchesOf(
      [
        { id: 1, name: 'ada', big: 12345678901234567890n, ok: true },
        { id: 2.5, name: null, big: null, ok: false },
      ],
      [{ id: 3, name: 'say "hi"\n', big: 1n, ok: true }],
    );
  const columns = ['id', 'name', 'big', 'ok'];

  it('writes one array of objects, keyed by the mapping, and reads it back', async () => {
    const root = tempRoot('file-sink-');
    const config = { path: 'out.json' };
    const result = await writeRowsToSink(request({ root, config, kind: 'json', columns }), rows());
    expect(result).toEqual({ rowsWritten: 3 });
    expect(readFileSync(join(root, 'out.json'), 'utf8')).toBe(
      '[\n{"id":1,"name":"ada","big":12345678901234567890,"ok":true},\n' +
        '{"id":2.5,"name":null,"big":null,"ok":false},\n' +
        '{"id":3,"name":"say \\"hi\\"\\n","big":1,"ok":true}\n]\n',
    );
    expect((await readJsonBack(root, 'json', config))[2]).toEqual({
      id: 3,
      name: 'say "hi"\n',
      big: 1,
      ok: true,
    });
  });

  it('writes an empty array when there are no rows', async () => {
    const root = tempRoot('file-sink-');
    await writeRowsToSink(
      request({ root, config: { path: 'out.json' }, kind: 'json', columns }),
      batchesOf(),
    );
    expect(readFileSync(join(root, 'out.json'), 'utf8')).toBe('[]\n');
  });

  it('writes one object per line, gzipped, and reads it back', async () => {
    const root = tempRoot('file-sink-');
    const config = { path: 'out.jsonl.gz', compression: 'gzip' };
    await writeRowsToSink(request({ root, config, kind: 'jsonl', columns }), rows());
    expect(gunzipSync(readFileSync(join(root, 'out.jsonl.gz'))).toString('utf8')).toBe(
      '{"id":1,"name":"ada","big":12345678901234567890,"ok":true}\n' +
        '{"id":2.5,"name":null,"big":null,"ok":false}\n' +
        '{"id":3,"name":"say \\"hi\\"\\n","big":1,"ok":true}\n',
    );
    expect(await readJsonBack(root, 'jsonl', config)).toHaveLength(3);
  });

  it('writes bytes as a base64 string', async () => {
    const root = tempRoot('file-sink-');
    await writeRowsToSink(
      request({ root, config: { path: 'out.jsonl' }, kind: 'jsonl', columns: ['b'] }),
      batchesOf([{ b: new Uint8Array([104, 105]) }]),
    );
    expect(readFileSync(join(root, 'out.jsonl'), 'utf8')).toBe('{"b":"aGk="}\n');
  });
});
