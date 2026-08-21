import { mkdir, open, stat, symlink, writeFile } from 'node:fs/promises';

// Pass every export straight through to the real implementation — only `open`
// becomes a spy, so a test can prove the handle the reader took was CLOSED. The
// idiom (and the reason it is a pass-through rather than a fake) is `fs.test.ts`'s:
// this layer's whole subject is real filesystem behaviour, and a fake would test
// itself.
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
import { join } from 'node:path';
import { newCopyCounters, pumpCopyRows, type CopyPumpMappingEntry } from '@autonomy-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatasetIoError } from '../dataset-io-error.js';
import { cleanupTempRoots, tempRoot } from './temp-roots.js';
import {
  delimitedCoercionFor,
  describeDelimitedDatasetColumns,
  readDelimitedDatasetBatches,
  resolveDelimitedDatasetAddress,
  type DelimitedDatasetRead,
} from '../delimited-io.js';

/**
 * #996 M7 slice 2 (#1165) — the `delimited` reader.
 *
 * REAL FILES, not a mocked filesystem: the whole point of this layer is the
 * things a pure parser cannot be asked about — confinement, `O_NOFOLLOW`,
 * decoder boundaries, file handles being closed. Mocking `node:fs` here would
 * test the mock. The roots come from `temp-roots.ts` rather than a fourth inline
 * copy of the `realpath(mkdtemp(...))` idiom — the `realpath` is load-bearing
 * (macOS `os.tmpdir()` is itself a symlink), and it is exactly the drift
 * `sqlite-fixtures.ts`'s docblock predicted.
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
beforeEach(() => {
  root = tempRoot('delim-root-');
  outside = tempRoot('delim-out-');
});
afterEach(cleanupTempRoots);

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
    throw new Error(`expected a DatasetIoError, got ${String(err)}`, { cause: err });
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

  it('does not count a trailing delimiter as a column in a headerless file', async () => {
    const path = await seed('nt.csv', '1,ada,\n2,grace,\n');
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
      expect(err.message).toContain("names the header column 'a' more than once");
    }
  });

  it('accepts a header ending in a trailing delimiter — that is not a column', async () => {
    const path = await seed('td.csv', 'a,b,\n1,2,\n');
    expect(await describeDelimitedDatasetColumns(read(path))).toEqual(['a', 'b']);
    expect(await rowsOf(read(path))).toEqual([{ a: '1', b: '2' }]);
  });

  it('refuses a header that names no columns at all', async () => {
    const path = await seed('nn.csv', ',,\n1,2\n');
    const err = await refusalOf(() => rowsOf(read(path)));
    expect(err.message).toContain('names no columns');
  });

  it('refuses an unnamed header column, naming its position', async () => {
    const path = await seed('e.csv', 'a,,c\n1,2,3\n');
    const err = await refusalOf(() => rowsOf(read(path)));
    expect(err.kind).toBe('permanent');
    expect(err.message).toContain('has no name for header column 2');
  });

  it('preserves header whitespace verbatim rather than inventing a trimmed name', async () => {
    const path = await seed('w.csv', 'a, b\n1,2\n');
    expect(await describeDelimitedDatasetColumns(read(path))).toEqual(['a', ' b']);
  });
});

describe('every refusal names the file', () => {
  // A copy pipeline with several delimited sources produces these errors on a
  // run-detail page with no other context, so "which file?" has to be in the
  // sentence — `noRowsError` and the I/O wrapper already did it, the naming and
  // ragged-row refusals did not.
  it.each([
    ['a,b,a\n1,2,3\n', {}],
    ['a,,c\n1,2,3\n', {}],
    [',,\n1,2\n', {}],
    ['a,b\n1,2\n3,4,5\n', {}],
    ['', {}],
  ])('names the file in the refusal for %j', async (contents, config) => {
    const path = await seed('named.csv', contents);
    const err = await refusalOf(() => rowsOf(read(path, config)));
    expect(err.message).toContain(path);
  });
});

describe('the grammar options actually reach the grammar', () => {
  // The grammar's own suite proves the RULES; only this layer can prove the
  // WIRING. A `quote: config.delimiter` slip, or a dropped `escape` spread,
  // would leave every rule test green and silently misparse every
  // operator-configured file.
  it('honours a non-default delimiter and quote', async () => {
    const path = await seed('pipe.csv', "a|b\n'x|y'|2\n");
    expect(await rowsOf(read(path, { delimiter: '|', quote: "'" }))).toEqual([
      { a: 'x|y', b: '2' },
    ]);
  });

  it('honours a declared escape character', async () => {
    const path = await seed('esc.csv', 'a,b\n"x\\"y",2\n');
    expect(await rowsOf(read(path, { escape: '\\' }))).toEqual([{ a: 'x"y', b: '2' }]);
  });

  it('bounds accumulation — an unterminated field cannot swallow the file', async () => {
    // Proves `DELIMITED_MAX_FIELD_CHARS` reaches `parseDelimitedRows`, which is
    // the module's central safety claim: without the bound, a binary or a
    // never-closed quote accumulates the WHOLE file into one field while still
    // satisfying the streaming signature.
    //
    // Stated rather than hidden: `DELIMITED_MAX_ROW_CHARS` (8 MiB) rides the
    // same object literal and is NOT separately pinned — a fixture large enough
    // to trip it costs more than the assertion is worth. Deleting BOTH bounds
    // is caught here; deleting only the row bound is not.
    const path = await seed('huge.csv', `a\n"${'x'.repeat(1_048_577)}`);
    const err = await refusalOf(() => rowsOf(read(path)));
    expect(err.kind).toBe('permanent');
    expect((err.cause as { code?: string } | undefined)?.code).toBe('field_too_large');
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

  it('accepts an extra EMPTY field — a trailing delimiter discards no data', async () => {
    const path = await seed('te.csv', 'a,b\n1,2,\n3,4,,\n');
    expect(await rowsOf(read(path))).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('still binds a legitimately empty LAST column rather than trimming it away', async () => {
    // The excess is what gets examined, never the row's whole trailing run —
    // otherwise `1,,` would lose columns b and c and fail a good row.
    const path = await seed('lastempty.csv', 'a,b,c\n1,,\n');
    expect(await rowsOf(read(path))).toEqual([{ a: '1', b: '', c: '' }]);
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
    // Precise rather than a bare `not.toContain('line')`: a random temp-dir
    // suffix could contain those four letters, and the claim being made is
    // about a LINE NUMBER, not the word.
    expect(err.message).not.toMatch(/\bline \d/);
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

  it('says the columns cannot be COUNTED when a headerless file has no rows', async () => {
    const path = await seed('emptynh.csv', '');
    const err = await refusalOf(() => rowsOf(read(path, { header: false })));
    expect(err.message).toContain('columns cannot be counted');
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
    // #1175 — the WHOLE message, anchored: a Zod 4 blob would span lines.
    expect(err.message).toMatch(/^invalid fs connection config: [^\n]+$/);
  });

  it('refuses a malformed delimited dataset config', async () => {
    const path = await seed('c.csv', 'a\n1\n');
    // `header` is REQUIRED with no default, deliberately (#1163).
    const err = await refusalOf(() => rowsOf({ ...read(path), datasetConfig: { path } }));
    expect(err.kind).toBe('permanent');
    expect(err.message).toMatch(/^invalid delimited dataset config: [^\n]+$/);
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

  it('refuses before it even opens the file when the signal is already set', async () => {
    const path = await seed('preopen.csv', 'a\n1\n');
    const controller = new AbortController();
    controller.abort();
    const spy = vi.mocked(open);
    spy.mockClear();
    const err = await refusalOf(() => rowsOf(read(path, {}, { signal: controller.signal })));
    expect(err.kind).toBe('cancelled');
    // On OPEN, not on reads: the per-chunk check already stops the first
    // `read()`, so a read count cannot tell the two guards apart. `sqlite`'s
    // reader checks after confinement and before it opens the store, and an
    // already-cancelled read must not pay for an `open` + `stat` it will throw
    // away — cheap on a local disk, not on a wedged network mount.
    expect(spy).not.toHaveBeenCalled();

    // The describe half owes the same guarantee — it is the gate that runs
    // FIRST, so a cancel it ignores is one the copy pays for before the read
    // ever gets its say.
    spy.mockClear();
    const described = await refusalOf(() =>
      describeDelimitedDatasetColumns(read(path, {}, { signal: controller.signal })),
    );
    expect(described.kind).toBe('cancelled');
    expect(spy).not.toHaveBeenCalled();
  });

  it('stops READING mid-file the moment the signal is set, instead of draining first', async () => {
    // This isolates the PER-CHUNK check. Both abort checks report `cancelled`,
    // so an outcome assertion cannot tell them apart, and the pre-open check
    // cannot see an abort that arrives after the read began. The batch-boundary
    // check alone would drain the whole file before noticing, because the
    // grammar yields no batch until one is full. What only the per-chunk check
    // buys is that the I/O stops, so that is what is asserted.
    const path = await seed('drain.csv', `a\n${'x\n'.repeat(2000)}`);
    const controller = new AbortController();
    const reads = await countReads(
      () => refusalOf(() => rowsOf(read(path, {}, { signal: controller.signal, chunkBytes: 1 }))),
      (n) => {
        if (n === 1) controller.abort();
      },
    );
    // One byte per read over a ~4 KiB file: draining it is ~4000 reads.
    expect(reads).toBeLessThan(5);
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

  it('is closed when the read refuses while the file is STILL STREAMING', async () => {
    // The refusal must land with chunks left unread, or this only re-tests the
    // normal-EOF close: a fixture smaller than one chunk is fully drained (and
    // its `finally` already run) before the first batch is ever bound.
    const path = await seed('mid.csv', `a,b\n1,2\n3,4,5\n${'7,8\n'.repeat(500)}`);
    const spy = vi.mocked(open);
    spy.mockClear();
    const err = await refusalOf(() => rowsOf(read(path, {}, { batchRows: 2, chunkBytes: 8 })));
    expect(err.message).toContain('data row 2 carries 3 fields');
    const handles = await Promise.all(spy.mock.results.map((r) => r.value));
    expect(handles.length).toBeGreaterThan(0);
    for (const handle of handles) expect((handle as { fd: number }).fd).toBe(-1);
  });
});

describe('the seam the pump actually consumes', () => {
  it('feeds pumpCopyRows: a short row fails ITS OWN row and the copy continues', async () => {
    const path = await seed('p.csv', 'id,name\n1,ada\n2\n3,grace\n');
    const mapping: CopyPumpMappingEntry[] = [
      { source: 'id', sink: 'id', type: 'integer', onError: 'fail' },
      { source: 'name', sink: 'name', type: 'string', onError: 'fail' },
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
async function countReads(
  body: () => Promise<unknown>,
  onRead?: (n: number) => void,
): Promise<number> {
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
        onRead?.(reads);
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

/**
 * #1167 M7 slice 3 — §2.1's ADDRESS, the fact a dispatch records and the
 * self-copy gate compares.
 */
describe('where a delimited dataset physically is', () => {
  const resolve = (path: string, config: Record<string, unknown> = {}, roots = [root]) =>
    resolveDelimitedDatasetAddress({
      connectionConfig: { roots },
      dataset: { kind: 'delimited', config: { path, header: true, ...config } },
    });

  it('reports the CONFINED path as both the store and the object', async () => {
    const path = await seed('a.csv', 'id\n1\n');
    // Both halves, deliberately: for a flat file the store and the object are
    // the same physical thing, and a `null` object would make a CSV copied onto
    // itself unrefusable (`sameDatasetAddress`: "a null object never matches,
    // not even another null").
    await expect(resolve(path)).resolves.toEqual({
      kind: 'fs',
      store: path,
      storeIdentity: expect.stringMatching(/^\d+:\d+$/),
      object: path,
    });
  });

  it('gives a CASE-ALIAS pair ONE identity, which is why the field exists', async () => {
    // The measured reason `store` alone is not an identity. `resolveWithinRoots`
    // joins the final component AS SPELLED, so on a case-insensitive volume
    // (APFS, the operator's Mac) these are two paths and one inode. On a
    // case-SENSITIVE one they are genuinely two files — so the assertion is
    // "the identity tracks the filesystem", not "the identities are equal".
    const path = await seed('Data.csv', 'id\n1\n');
    const aliased = join(root, 'data.csv');
    const [spelled, alias] = await Promise.all([resolve(path), resolve(aliased)]);

    expect(spelled.store).not.toBe(alias.store);
    // The oracle is the FILESYSTEM, asked directly, not a guess about which one
    // this suite is running on. `stat` throws on a case-sensitive volume, where
    // `data.csv` genuinely does not exist — and there the two addresses SHOULD
    // differ, which is the same rule reaching the opposite answer.
    const sameFile = await stat(aliased)
      .then(async (b) => (await stat(path)).ino === b.ino)
      .catch(() => false);
    expect(alias.storeIdentity === spelled.storeIdentity).toBe(sameFile);
    // Whichever volume this is, the identity is what decided it — the PATHS
    // differ either way, so a path-only comparison could not have.
    expect(spelled.storeIdentity).toMatch(/^\d+:\d+$/);
  });

  it('records an unidentifiable store as null rather than refusing', async () => {
    // A missing file is not a dispatch-time refusal: the READ is what refuses
    // it, with a message about the store. Minting a `permanent` here would
    // report an address problem for a store problem.
    const address = await resolve(join(root, 'not-here.csv'));
    expect(address).toMatchObject({ store: join(root, 'not-here.csv'), storeIdentity: null });
  });

  it('refuses a path outside the connection roots', async () => {
    const path = join(outside, 'escape.csv');
    await writeFile(path, 'id\n1\n');
    await expect(resolve(path)).rejects.toBeInstanceOf(DatasetIoError);
    await expect(resolve(path)).rejects.toMatchObject({ kind: 'permanent' });
  });

  it('refuses a symlinked target, like every other path this connection takes', async () => {
    const target = join(outside, 'target.csv');
    await writeFile(target, 'id\n1\n');
    const link = join(root, 'link.csv');
    await symlink(target, link);
    await expect(resolve(link)).rejects.toMatchObject({ kind: 'permanent' });
  });

  it('refuses a kind this store does not read, BY NAME', async () => {
    await expect(
      resolveDelimitedDatasetAddress({
        connectionConfig: { roots: [root] },
        dataset: { kind: 'excel', config: { path: join(root, 'book.xlsx') } },
      }),
    ).rejects.toMatchObject({
      kind: 'permanent',
      message: "the fs store reads 'delimited' datasets; this one is 'excel'",
    });
  });
});

/**
 * #1167 — the §6.4 projection `CopyIo.sourceCoercion` travels through.
 */
describe('the coercion options a delimited dataset declares', () => {
  it('returns only the DECLARED keys, so an absent one stays absent', async () => {
    // Not `{ nullValue: undefined }`: `coerceValue` tests
    // `opts.nullValue !== undefined`, and `exactOptionalPropertyTypes` is what
    // keeps the two spellings distinguishable at the type level.
    expect(delimitedCoercionFor({ path: '/a.csv', header: true })).toEqual({});
    expect(Object.keys(delimitedCoercionFor({ path: '/a.csv', header: true }))).toEqual([]);
  });

  it('carries an EMPTY-STRING nullValue, which is a real declaration', async () => {
    // The one value a truthiness check would silently drop. #1163 gave
    // `nullValue` no `.min(1)` precisely so "an empty field means NULL" is
    // expressible.
    expect(delimitedCoercionFor({ path: '/a.csv', header: true, nullValue: '' })).toEqual({
      nullValue: '',
    });
  });

  it('carries both keys when both are declared', async () => {
    expect(
      delimitedCoercionFor({
        path: '/a.csv',
        header: true,
        nullValue: '\\N',
        dateFormat: 'dd/MM/yyyy',
      }),
    ).toEqual({ nullValue: '\\N', dateFormat: 'dd/MM/yyyy' });
  });

  it('THROWS on a config it cannot parse rather than degrading to no options', async () => {
    // The fail-open alternative is the whole reason this is not `?? {}`: an
    // unparseable config would otherwise run the copy with the operator's
    // declared sentinel doing nothing.
    expect(() => delimitedCoercionFor({ header: true })).toThrow(DatasetIoError);
    expect(() => delimitedCoercionFor({ header: true })).toThrow(
      /invalid delimited dataset config/,
    );
  });
});
