import { mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises';

// Pass every export straight through to the real implementation — only `open`
// becomes a spy, so a test can prove the handle the reader took was CLOSED. The
// idiom (and the reason it is a pass-through rather than a fake) is `fs.test.ts`'s:
// this layer's whole subject is real filesystem behaviour, and a fake would test
// itself.
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  newCopyCounters,
  pumpCopyRows,
  type CopyPumpMappingEntry,
} from '@autonomy-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatasetIoError } from '../dataset-io-error.js';
import {
  describeDelimitedDatasetColumns,
  readDelimitedDatasetBatches,
  type DelimitedDatasetRead,
} from '../delimited-io.js';

/**
 * #996 M7 slice 2 (#1165) — the `delimited` reader.
 *
 * REAL FILES, not a mocked filesystem: the whole point of this layer is the
 * things a pure parser cannot be asked about — confinement, `O_NOFOLLOW`,
 * decoder boundaries, file handles being closed. Mocking `node:fs` here would
 * test the mock. The temp roots are `realpath`'d because `os.tmpdir()` is itself
 * a symlink on macOS (`/var` → `/private/var`), and the confinement guard
 * compares canonical-against-canonical.
 *
 * WHAT IS DELIBERATELY NOT RE-TESTED HERE: the row grammar. Slice 1 already runs
 * its whole corpus a second time at ONE CHARACTER per chunk
 * (`shared/datamove/delimited.test.ts`), so quoting, CRLF, embedded newlines and
 * chunk-boundary independence are pinned where they belong. What only THIS layer
 * can reach is the DECODER boundary — a multi-byte character or a BOM split
 * across a `read()` — and the mapping of the grammar's refusals onto a
 * `DatasetIoError` kind.
 */

let root: string;
let outside: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'delim-root-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'delim-out-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function seed(name: string, contents: string | Uint8Array): Promise<string> {
  const path = join(root, name);
  await writeFile(path, contents);
  return path;
}

function read(
  path: string,
  config: Record<string, unknown> = {},
  over: Partial<DelimitedDatasetRead> = {},
): DelimitedDatasetRead {
  return {
    connectionConfig: { roots: [root] },
    datasetKind: 'delimited',
    datasetConfig: { path, header: true, ...config },
    ...over,
  };
}

async function rowsOf(args: DelimitedDatasetRead): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for await (const batch of readDelimitedDatasetBatches(args)) out.push(...batch);
  return out;
}

/** The thrown `DatasetIoError`, or a failure that says what came instead. */
async function refusalOf(run: () => Promise<unknown>): Promise<DatasetIoError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof DatasetIoError) return err;
    throw new Error(`expected a DatasetIoError, got ${String(err)}`);
  }
  throw new Error('expected a refusal, but the read succeeded');
}

describe('naming', () => {
  it('binds the header row as names and does not copy it as data', async () => {
    const path = await seed('h.csv', 'id,name\n1,ada\n2,grace\n');
    expect(await rowsOf(read(path))).toEqual([
      { id: '1', name: 'ada' },
      { id: '2', name: 'grace' },
    ]);
    expect(await describeDelimitedDatasetColumns(read(path))).toEqual(['id', 'name']);
  });

  it('names columns positionally when the file has no header', async () => {
    const path = await seed('n.csv', '1,ada\n2,grace\n');
    expect(await rowsOf(read(path, { header: false }))).toEqual([
      { column1: '1', column2: 'ada' },
      { column1: '2', column2: 'grace' },
    ]);
    expect(await describeDelimitedDatasetColumns(read(path, { header: false }))).toEqual([
      'column1',
      'column2',
    ]);
  });

  it('never names a column from the dataset declaration (§7 — declared columns are not the gate)', async () => {
    const path = await seed('n.csv', '1,ada\n');
    // A `columns` declaration is an authoring aid and reaches the reader
    // nowhere: the names below must be positional regardless of it.
    const rows = await rowsOf(read(path, { header: false }));
    expect(Object.keys(rows[0]!)).toEqual(['column1', 'column2']);
  });

  it('refuses a duplicated header name, in BOTH entry points', async () => {
    const path = await seed('d.csv', 'a,b,a\n1,2,3\n');
    for (const run of [
      () => rowsOf(read(path)),
      () => describeDelimitedDatasetColumns(read(path)),
    ]) {
      const err = await refusalOf(run);
      expect(err.kind).toBe('permanent');
      expect(err.message).toContain("names 'a' more than once");
    }
  });

  it('refuses an unnamed header column, naming its position', async () => {
    const path = await seed('e.csv', 'a,,c\n1,2,3\n');
    const err = await refusalOf(() => rowsOf(read(path)));
    expect(err.kind).toBe('permanent');
    expect(err.message).toContain('no name for column 2');
  });

  it('preserves header whitespace verbatim rather than inventing a trimmed name', async () => {
    const path = await seed('w.csv', 'a, b\n1,2\n');
    expect(await describeDelimitedDatasetColumns(read(path))).toEqual(['a', ' b']);
  });
});

describe('ragged rows', () => {
  it('binds a SHORT row to the full key set, with the missing columns absent', async () => {
    const path = await seed('s.csv', 'a,b,c\n1,2\n');
    const rows = await rowsOf(read(path));
    // The KEY must exist — `planColumns` resolves the plan from the first row's
    // key set, so a row that omitted its missing keys could change the plan.
    expect(Object.keys(rows[0]!)).toEqual(['a', 'b', 'c']);
    expect(rows[0]!['c']).toBeUndefined();
  });

  it('refuses a LONG row, naming the data-row ordinal and both counts', async () => {
    const path = await seed('l.csv', 'a,b\n1,2\n3,4,5\n');
    const err = await refusalOf(() => rowsOf(read(path)));
    expect(err.kind).toBe('permanent');
    expect(err.message).toContain('data row 2 carries 3 fields but the source has 2 columns');
  });

  it('counts the data-row ordinal past a blank line, which is not a row', async () => {
    const path = await seed('lb.csv', 'a,b\n1,2\n\n3,4,5\n');
    const err = await refusalOf(() => rowsOf(read(path)));
    // Physically line 4; the second DATA row. The message must not claim a line.
    expect(err.message).toContain('data row 2');
    expect(err.message).not.toContain('line');
  });
});

describe('the empty-source boundary', () => {
  it('succeeds over ZERO rows for a header row with no data', async () => {
    const path = await seed('ho.csv', 'a,b\n');
    expect(await rowsOf(read(path))).toEqual([]);
    expect(await describeDelimitedDatasetColumns(read(path))).toEqual(['a', 'b']);
  });

  it('refuses a file with no rows at all — it cannot say what its columns are', async () => {
    const path = await seed('empty.csv', '');
    const err = await refusalOf(() => describeDelimitedDatasetColumns(read(path)));
    expect(err.kind).toBe('permanent');
    expect(err.message).toContain('contains no rows');
  });

  it('says "no rows" and not "empty" for a file of blank lines', async () => {
    const path = await seed('blank.csv', '\n\n\n');
    const err = await refusalOf(() => rowsOf(read(path)));
    expect(err.message).toContain('contains no rows');
  });
});

describe('decoding', () => {
  it('decodes utf-16le and strips its BOM', async () => {
    const bytes = new Uint8Array([0xff, 0xfe, ...utf16le('a,b\n1,2\n')]);
    const path = await seed('u16.csv', bytes);
    expect(await rowsOf(read(path, { encoding: 'utf-16le' }))).toEqual([{ a: '1', b: '2' }]);
  });

  it('strips a utf-8 BOM even when it lands across a READ boundary', async () => {
    const path = await seed('bom.csv', '﻿a,b\n1,2\n');
    // One byte per `read()` puts the three BOM bytes in three separate decoder
    // calls — the boundary only THIS layer can produce.
    expect(await rowsOf(read(path, {}, { chunkBytes: 1 }))).toEqual([{ a: '1', b: '2' }]);
  });

  it('carries a multi-byte character across a READ boundary intact', async () => {
    const path = await seed('mb.csv', 'a,b\n€,🎉\n');
    expect(await rowsOf(read(path, {}, { chunkBytes: 1 }))).toEqual([{ a: '€', b: '🎉' }]);
  });

  it('refuses undecodable bytes rather than writing U+FFFD into the sink', async () => {
    const path = await seed('bad.csv', new Uint8Array([0x61, 0x2c, 0x62, 0x0a, 0xff, 0xfe, 0x0a]));
    const err = await refusalOf(() => rowsOf(read(path)));
    expect(err.kind).toBe('permanent');
    expect(err.message).toContain('not valid utf-8');
  });

  it('refuses a file that ends mid-multi-byte-sequence — the FLUSH is what catches it', async () => {
    // A lone leading byte of a 3-byte sequence at EOF: no `{stream:true}` call
    // reports it, only the final `decode()`.
    const path = await seed('trunc.csv', new Uint8Array([0x61, 0x0a, 0x62, 0x0a, 0xe2, 0x82]));
    const err = await refusalOf(() => rowsOf(read(path)));
    expect(err.message).toContain('not valid utf-8');
  });

  it('does NOT refuse windows-1252, whose cover is uneven by construction', async () => {
    // Every byte maps, so `fatal` can never fire — stated in the reader's
    // docblock as a limit rather than left to be discovered as a surprise.
    const path = await seed('w.csv', new Uint8Array([0x61, 0x0a, 0x80, 0x0a]));
    expect(await rowsOf(read(path, { encoding: 'windows-1252', header: true }))).toEqual([
      { a: '€' },
    ]);
  });
});

describe('confinement and the file itself', () => {
  it('refuses a path outside the connection roots', async () => {
    const path = join(outside, 'x.csv');
    await writeFile(path, 'a\n1\n');
    const err = await refusalOf(() => rowsOf(read(path)));
    expect(err.kind).toBe('permanent');
  });

  it('refuses a symlink AT the target (O_NOFOLLOW / lstat)', async () => {
    const real = join(outside, 'secret.csv');
    await writeFile(real, 'a\n1\n');
    const link = join(root, 'link.csv');
    await symlink(real, link);
    const err = await refusalOf(() => rowsOf(read(link)));
    expect(err.kind).toBe('permanent');
  });

  it('refuses a directory rather than reporting it as a file with no columns', async () => {
    const dir = join(root, 'adir');
    await mkdir(dir);
    const err = await refusalOf(() => rowsOf(read(dir)));
    expect(err.kind).toBe('permanent');
    expect(err.message).toContain('not a regular file');
  });

  it('classifies a missing parent directory instead of letting a raw errno escape', async () => {
    // `resolveWithinRoots` leaves `realpath` on the parent unguarded on purpose.
    const err = await refusalOf(() => rowsOf(read(join(root, 'nope', 'x.csv'))));
    expect(err).toBeInstanceOf(DatasetIoError);
    expect(err.kind).toBe('permanent');
  });

  it('refuses a missing file', async () => {
    const err = await refusalOf(() => rowsOf(read(join(root, 'gone.csv'))));
    expect(err.kind).toBe('permanent');
  });
});

describe('config validation at dispatch (§8)', () => {
  it('refuses a malformed fs connection config rather than trusting the stored row', async () => {
    const path = await seed('c.csv', 'a\n1\n');
    const err = await refusalOf(() =>
      rowsOf(read(path, {}, { connectionConfig: { roots: ['relative/root'] } })),
    );
    expect(err.kind).toBe('permanent');
    expect(err.message).toContain('invalid fs connection config');
  });

  it('refuses a malformed delimited dataset config', async () => {
    const path = await seed('c.csv', 'a\n1\n');
    // `header` is REQUIRED with no default, deliberately (#1163).
    const err = await refusalOf(() =>
      rowsOf({ ...read(path), datasetConfig: { path } }),
    );
    expect(err.kind).toBe('permanent');
    expect(err.message).toContain('invalid delimited dataset config');
  });

  it('refuses a dataset kind this store does not read', async () => {
    const path = await seed('c.csv', 'a\n1\n');
    const err = await refusalOf(() => rowsOf({ ...read(path), datasetKind: 'excel' }));
    expect(err.kind).toBe('permanent');
    expect(err.message).toContain("this one is 'excel'");
  });
});

describe('failure mapping and cancellation', () => {
  it('maps a grammar refusal to a permanent DatasetIoError, carrying the code in `cause`', async () => {
    const path = await seed('q.csv', 'a\n"unclosed\n');
    const err = await refusalOf(() => rowsOf(read(path)));
    expect(err.kind).toBe('permanent');
    expect((err.cause as { code?: string } | undefined)?.code).toBe('unterminated_quote');
  });

  it('reports `cancelled` when the signal aborts', async () => {
    const path = await seed('big.csv', `a\n${'x\n'.repeat(500)}`);
    const controller = new AbortController();
    controller.abort();
    const err = await refusalOf(() => rowsOf(read(path, {}, { signal: controller.signal })));
    expect(err.kind).toBe('cancelled');
  });

  it('stops READING the moment the signal is set, instead of draining the file first', async () => {
    // This isolates the PER-CHUNK check. Both abort checks report `cancelled`,
    // so an outcome assertion cannot tell them apart — and the batch-boundary
    // check alone would read the whole file before noticing, because the grammar
    // yields no batch until one is full. What only the per-chunk check buys is
    // that the I/O stops, so that is what is asserted.
    const path = await seed('drain.csv', `a\n${'x\n'.repeat(2000)}`);
    const controller = new AbortController();
    controller.abort();
    const reads = await countReads(() =>
      refusalOf(() => rowsOf(read(path, {}, { signal: controller.signal, chunkBytes: 1 }))),
    );
    expect(reads).toBe(0);
  });

  it('stops BETWEEN BATCHES when the abort arrives after the file is already read', async () => {
    // And this isolates the batch-boundary check. With the whole file in one
    // chunk, batches 2..n are produced from the grammar's buffered position with
    // no further `read()` — so the per-chunk check can never fire, and only the
    // boundary check can stop the scan.
    const path = await seed('buffered.csv', `a\n${'x\n'.repeat(10)}`);
    const controller = new AbortController();
    const seen: number[] = [];
    await refusalOf(async () => {
      for await (const batch of readDelimitedDatasetBatches(
        read(path, {}, { signal: controller.signal, batchRows: 1, chunkBytes: 1024 * 1024 }),
      )) {
        seen.push(batch.length);
        controller.abort();
      }
    });
    expect(seen).toEqual([1]);
  });

  it('refuses a non-positive chunkBytes', async () => {
    const path = await seed('c.csv', 'a\n1\n');
    const err = await refusalOf(() => rowsOf(read(path, {}, { chunkBytes: 0 })));
    expect(err.message).toContain('chunkBytes must be a positive integer');
  });
});

describe('batching', () => {
  it('yields whole batches of batchRows, header excluded from the count', async () => {
    const path = await seed('b.csv', `a\n${Array.from({ length: 7 }, (_, i) => i).join('\n')}\n`);
    const sizes: number[] = [];
    for await (const batch of readDelimitedDatasetBatches(read(path, {}, { batchRows: 3 }))) {
      sizes.push(batch.length);
    }
    // 7 data rows at batchRows 3. The first parser batch holds the header plus
    // two data rows, so the header must be stripped from it and not counted.
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(7);
    expect(sizes.every((n) => n > 0)).toBe(true);
  });
});

describe('the file handle', () => {
  it('is closed when the consumer stops early — the describe path does exactly this', async () => {
    const path = await seed('early.csv', `a\n${'x\n'.repeat(50)}`);
    const spy = vi.mocked(open);
    spy.mockClear();

    // `describeDelimitedDatasetColumns` returns from inside `for await`, which
    // reaches the chunk generator's `finally` only through the consumer's
    // `.return()`. A leak here would be invisible until a long-running server
    // ran out of descriptors.
    await describeDelimitedDatasetColumns(read(path));

    const handles = await Promise.all(spy.mock.results.map((r) => r.value));
    expect(handles.length).toBeGreaterThan(0);
    for (const handle of handles) {
      // A second close on an already-closed handle resolves; on a still-open one
      // it is the close that actually releases it. So assert on the fd instead:
      // node sets it to -1 once closed.
      expect((handle as { fd: number }).fd).toBe(-1);
    }
  });

  it('is closed when the read refuses mid-file', async () => {
    const path = await seed('mid.csv', 'a,b\n1,2\n3,4,5\n');
    const spy = vi.mocked(open);
    spy.mockClear();
    await refusalOf(() => rowsOf(read(path)));
    const handles = await Promise.all(spy.mock.results.map((r) => r.value));
    expect(handles.length).toBeGreaterThan(0);
    for (const handle of handles) expect((handle as { fd: number }).fd).toBe(-1);
  });
});

describe('the seam the pump actually consumes', () => {
  it('feeds pumpCopyRows: a short row fails ITS OWN row and the copy continues', async () => {
    const path = await seed('p.csv', 'id,name\n1,ada\n2\n3,grace\n');
    const mapping: CopyPumpMappingEntry[] = [
      { source: 'id', sink: 'id', type: 'integer', nullable: false, onError: 'fail' },
      { source: 'name', sink: 'name', type: 'string', nullable: false, onError: 'fail' },
    ];
    const counters = newCopyCounters();
    const out: Record<string, unknown>[] = [];
    for await (const batch of pumpCopyRows(readDelimitedDatasetBatches(read(path)), {
      mapping,
      counters,
    })) {
      out.push(...batch);
    }
    expect(counters.rowsRead).toBe(3);
    expect(counters.rowsFailed).toBe(1);
    expect(out).toEqual([
      { id: 1n, name: 'ada' },
      { id: 3n, name: 'grace' },
    ]);
  });

  it('leaves `nullValue` to the coercion layer — the reader yields the raw string', async () => {
    const path = await seed('nv.csv', 'a\n\\N\n');
    const rows = await rowsOf(read(path, { nullValue: '\\N' }));
    // Pre-nulling here would make `bytesRead` under-count the value the reader
    // really materialised (§5), and could not do `dateFormat` at all.
    expect(rows).toEqual([{ a: '\\N' }]);
  });
});

/**
 * Run `body` and report how many `read()` syscalls the reader made, by wrapping
 * the handle the spied `open` hands back.
 */
async function countReads(body: () => Promise<unknown>): Promise<number> {
  const spy = vi.mocked(open);
  const actual = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'))
    .open;
  let reads = 0;
  spy.mockImplementationOnce(async (...args: Parameters<typeof open>) => {
    const handle = await actual(...args);
    const realRead = handle.read.bind(handle) as (...a: unknown[]) => Promise<unknown>;
    Object.assign(handle, {
      read: (...a: unknown[]) => {
        reads += 1;
        return realRead(...a);
      },
    });
    return handle;
  });
  try {
    await body();
  } finally {
    spy.mockReset();
    spy.mockImplementation(actual);
  }
  return reads;
}

/** UTF-16LE code units for an ASCII-safe string, as bytes. */
function utf16le(text: string): number[] {
  const bytes: number[] = [];
  for (const unit of text) {
    const code = unit.charCodeAt(0);
    bytes.push(code & 0xff, code >> 8);
  }
  return bytes;
}
