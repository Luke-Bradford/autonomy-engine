import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  DelimitedParseError,
  delimitedDatasetConfigSchema,
  parseDelimitedRows,
  type DatasetKind,
} from '@autonomy-studio/shared';
import { resolveWithinRoots } from './confine.js';
import { DatasetIoError } from './dataset-io-error.js';
import { classifyFsError, fsConnectionConfigSchema } from './fs-connection.js';
import { yieldToEventLoop } from './scheduling.js';
import {
  COPY_BATCH_ROWS,
  DELIMITED_MAX_FIELD_CHARS,
  DELIMITED_MAX_ROW_CHARS,
  FS_STREAM_CHUNK_BYTES,
} from '../limits.js';

/**
 * #996 M7 slice 2 (#1165) — the READER for a `delimited` (CSV) dataset over an
 * `fs` connection: the half of M7 that owns the filesystem.
 *
 * Slice 1 (#1163) built the row GRAMMAR as a pure state machine in
 * `shared/datamove/delimited.ts` — no filesystem, no decoding, no scheduling —
 * and its docblock hands this module a list of obligations by name. This is
 * that list discharged, and the shape is `readSqliteDatasetBatches` /
 * `describeSqliteDatasetColumns` (`sqlite.ts`) deliberately: the two stores
 * differ in how they get bytes and in nothing else the seam can see.
 *
 * ── WHAT THIS OWNS THAT THE GRAMMAR DOES NOT ────────────────────────────────
 *
 * **1. Decoding**, with `{ fatal: true }`. The default `TextDecoder` substitutes
 * U+FFFD for every undecodable byte, so a mis-declared encoding would write
 * replacement characters into the sink and report SUCCESS. Re-measured here on
 * node v25.9.0 rather than inherited: all four declared encodings are accepted;
 * `fatal` throws a `TypeError` on invalid utf-8 and on an odd trailing utf-16le
 * byte; a utf-8 BOM is stripped by the decoder itself EVEN WHEN SPLIT one byte
 * per chunk, so no manual strip is owed. The cover is uneven and saying so is
 * part of the contract: `windows-1252` maps every byte and can never throw, so
 * `fatal` binds mostly on utf-8 — it is the difference between a refusal and
 * silent corruption on the encoding operators actually use, not a guarantee.
 *
 * **2. Naming.** The grammar yields POSITIONAL rows and never names them,
 * because `describeSource` wants bare names and `readBatches` wants records,
 * and a parser that knew which could serve neither. So the header row is
 * consumed HERE (the grammar does not skip it — a reader that forgot would
 * silently drop a data row), and with `header: false` the columns are named
 * POSITIONALLY, never from the dataset's declared `columns`, which §7 is
 * explicit are "deliberately NOT the gate".
 *
 * **3. The ragged-row policy**, which slice 1 deferred here because this is the
 * first layer with a seam to express it in. See {@link bindRow}.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT OWN ─────────────────────────────────────
 *
 * **`nullValue` and `dateFormat` are NOT applied here.** They are
 * `CoercionOptions` (`datamove/coerce.ts`), applied by the pump BEFORE type
 * dispatch so the sentinel reaches a `string` target too, and `pump.ts`'s
 * `coercion` docblock names the reader as the thing that must "read them off
 * the source dataset and pass them here". Applying `nullValue` in the reader
 * would look equivalent and is not, in two ways: `dateFormat` cannot be done
 * here at all (the reader has no target type), splitting a pair §6.2/§6.4 keep
 * together; and `bytesRead` would silently UNDER-count, because `byteSizeOf(null)`
 * is 0 where the string it replaced was charged its UTF-8 length — so §5's
 * "every value the reader materialised" would become false for exactly the
 * fields the operator declared. This reader therefore yields RAW STRINGS.
 * Threading `coercion` from `source.config` into `pumpCopyRows` is M7 slice 3's
 * to do: `CopyIo` has no coercion channel today (`copy.ts` calls the pump with
 * `{ mapping, counters }` and nothing else).
 *
 * **The `fs` CONNECTION's `maxBytes` is NOT applied** (`catalog/connection-config.ts`;
 * the dataset config has no such key), and an operator who set it will
 * reasonably expect otherwise, so it is written down. It is `file_read`'s cap
 * on materialising a whole file in memory. This is `file_copy`'s shape — a
 * STREAM, memory-bounded regardless of file size, which is exactly why `doCopy`
 * deliberately carries no `maxBytes` cap either. Capping a streaming source by
 * file size would refuse the large-file copy that streaming exists to allow.
 * Accumulation is bounded instead, by `DELIMITED_MAX_FIELD_CHARS` /
 * `DELIMITED_MAX_ROW_CHARS`, which is the property that actually matters.
 *
 * ── SECURITY (§8) ──────────────────────────────────────────────────────────
 *
 * The path is confined through `resolveWithinRoots` — the ONE hardened
 * implementation, shared, never mirrored — and the file is then opened with
 * `O_NOFOLLOW`, which is what closes the lstat→open race the guard cannot close
 * on its own. Both configs are RE-VALIDATED here: `routes/connections.ts` runs
 * no per-kind validation on write and `connectionConfigAdvisory` is advisory by
 * its own docblock, so "a file-backed dataset must re-validate at dispatch and
 * must not assume the stored connection is well-formed".
 */

/** What one `delimited` dataset read needs to know. */
export interface DelimitedDatasetRead {
  /** The `fs` connection's stored config — RE-PARSED here, never trusted (§8). */
  readonly connectionConfig: Record<string, unknown>;
  readonly datasetKind: DatasetKind;
  readonly datasetConfig: Record<string, unknown>;
  /** Rows per yielded batch, and per event-loop yield. Defaults to `COPY_BATCH_ROWS`. */
  readonly batchRows?: number;
  /**
   * Bytes per `read()` syscall. Defaults to `FS_STREAM_CHUNK_BYTES`.
   *
   * A real tuning knob on `batchRows`' precedent, and the one thing a test can
   * turn that the grammar's own suite cannot reach: `shared` already re-runs its
   * whole corpus at ONE CHARACTER per chunk, but those are already-decoded
   * chunks. Only this boundary can put a multi-byte character or a BOM across a
   * DECODER boundary, which is a different failure with a different owner.
   */
  readonly chunkBytes?: number;
  /** Honoured per read chunk AND at batch boundaries (§9/§10). */
  readonly signal?: AbortSignal;
}

/** The parsed `delimited` dataset config — §2.6's eight keys, defaults applied. */
type DelimitedConfig = ReturnType<typeof delimitedDatasetConfigSchema.parse>;

/**
 * Map any throw to a `DatasetIoError` carrying a real failure `kind`, passing an
 * already-classified one through untouched.
 *
 * `sqlite.ts`'s `storeFailure` with an errno mapper in place of a SQLite-code
 * one. The polarity is the same and it is the load-bearing part: a store that
 * could not be REACHED is `transient` and must never be reported as drift, and
 * anything unrecognised is `permanent`, never blind-retried.
 */
function readFailure(
  err: unknown,
  signal: AbortSignal | undefined,
  context: string,
): DatasetIoError {
  if (err instanceof DatasetIoError) return err;
  if (err instanceof DelimitedParseError) {
    // Every grammar refusal is `permanent` by slice 1's own statement: a
    // malformed document is a fact a retry cannot change. The `code` is carried
    // in `cause` rather than flattened into prose so a later consumer can branch
    // on it without matching on a message.
    return new DatasetIoError('permanent', `${context}: ${err.message}`, { cause: err });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new DatasetIoError(classifyFsError(err, signal), `${context}: ${message}`, { cause: err });
}

/**
 * Validate both configs and confine the path — everything that can be decided
 * before a byte is read.
 *
 * The kind guard is `datasetKind === 'delimited'` and NOT
 * `datasetKindIsImplemented`, which is the asymmetry with `sqlite.ts` and is
 * deliberate rather than an omission: `delimited` does not join
 * `IMPLEMENTED_DATASET_KINDS` until slice 3 wires the copy arm, so that guard
 * here would refuse the only kind this reader exists to read. What the guard is
 * FOR is unchanged — an `excel` dataset also lives on an `fs` connection, and
 * this refuses it by name rather than by trying to parse its config as a CSV's.
 */
async function prepareRead(read: DelimitedDatasetRead): Promise<{
  readonly path: string;
  readonly config: DelimitedConfig;
}> {
  if (read.datasetKind !== 'delimited') {
    throw new DatasetIoError(
      'permanent',
      `the fs store reads 'delimited' datasets; this one is '${read.datasetKind}'`,
    );
  }
  const cfg = fsConnectionConfigSchema.safeParse(read.connectionConfig);
  if (!cfg.success) {
    throw new DatasetIoError('permanent', `invalid fs connection config: ${cfg.error.message}`);
  }
  const config = delimitedDatasetConfigSchema.safeParse(read.datasetConfig);
  if (!config.success) {
    throw new DatasetIoError(
      'permanent',
      `invalid delimited dataset config: ${config.error.message}`,
    );
  }

  let confined: Awaited<ReturnType<typeof resolveWithinRoots>>;
  try {
    confined = await resolveWithinRoots(cfg.data.roots, config.data.path, 'fs');
  } catch (err) {
    // `resolveWithinRoots` leaves `realpath` on the target's PARENT unguarded on
    // purpose, so a missing or unreadable directory arrives as a raw errno. Its
    // docblock says every caller owes this wrapper, and names the one that
    // shipped without it (#1119) as the reason the note exists.
    throw readFailure(err, read.signal, `cannot resolve the delimited file '${config.data.path}'`);
  }
  if (!confined.ok) throw new DatasetIoError('permanent', confined.error);
  return { path: confined.path, config: config.data };
}

/**
 * The file as a stream of DECODED text, opened `O_NOFOLLOW` and closed on every
 * exit — including the early `return` that {@link describeDelimitedDatasetColumns}
 * makes after one row, which reaches this generator's `finally` through the
 * consumer's `.return()`.
 *
 * The abort check is PER CHUNK and not only per batch, which matters more than
 * it looks: the grammar yields nothing until a batch is full, so a file of
 * fewer than `batchRows` rows — or of a few very large ones — would otherwise be
 * read to EOF with no cancellation check at all. `file_copy` checks per chunk
 * for the same reason, and slice 1 authorises exactly this split: "the reader
 * can abort at its chunk source and between batches".
 */
async function* decodedChunks(
  path: string,
  encoding: string,
  chunkBytes: number,
  signal: AbortSignal | undefined,
): AsyncGenerator<string, void, undefined> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const st = await fh.stat();
    if (!st.isFile()) {
      // `open` succeeds on a directory, and the read that follows either throws
      // a bare `EISDIR` or reports zero bytes — which would then be indistinguishable
      // from an empty file and reported as "declares no columns". `file_read`
      // refuses this explicitly and so does this.
      throw new DatasetIoError('permanent', `'${path}' is not a regular file`);
    }

    const decoder = new TextDecoder(encoding, { fatal: true });
    const buffer = Buffer.allocUnsafe(chunkBytes);
    for (;;) {
      if (signal?.aborted) throw new DatasetIoError('cancelled', 'dataset read aborted');
      const { bytesRead } = await fh.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      // `decode` is synchronous, so reusing one buffer across reads is safe.
      yield decodeOrFail(decoder, encoding, buffer.subarray(0, bytesRead));
    }
    // The flush is not a formality: under `fatal` it is what refuses a file
    // ending mid-multi-byte-sequence, which no `{ stream: true }` call reports.
    yield decodeOrFail(decoder, encoding, undefined);
  } finally {
    try {
      await fh?.close();
    } catch {
      // A close failure must never replace the outcome the caller is unwinding
      // with — including the abort path this generator exists to make correct.
    }
  }
}

/** Decode one chunk, turning `fatal`'s bare `TypeError` into a message that names the encoding. */
function decodeOrFail(
  decoder: TextDecoder,
  encoding: string,
  chunk: Uint8Array | undefined,
): string {
  try {
    return chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true });
  } catch (err) {
    throw new DatasetIoError(
      'permanent',
      `the file is not valid ${encoding} — it may be a different encoding, or not text at all`,
      { cause: err },
    );
  }
}

/**
 * The column names, from the header row.
 *
 * TWO REFUSALS, and the first is the opposite of what the `sqlite` source does
 * with the same shape, which is worth stating because it reads as an
 * inconsistency and is not. `describeSqliteDatasetColumns` COLLAPSES a duplicate
 * (`SELECT i, i` reports `['i','i']` while the row carries `i` once, so
 * collapsing loses nothing). A CSV row carries BOTH values, so folding
 * `a,b,a` to `['a','b']` would silently drop a column of real data — and there
 * is no dispatch-time gate to delegate to, because `indexSourceColumns`
 * (`datamove/schema-drift.ts`) collapses exact duplicates before
 * `checkSourceDrift` ever sees them. This reader is the only place it can be
 * caught, so it is caught in BOTH entry points rather than only in the one that
 * happens to run first.
 *
 * AN INTERIOR EMPTY NAME IS REFUSED — `a,,c` has a column with data and no way
 * for a mapping to name it. The alternative, falling back to `column<N>` for
 * just that one, was rejected because a synthesised name for a column the file
 * DOES have is a name that changes the moment the header is fixed: a mapping
 * authored against `column2` would silently stop matching, which is the failure
 * class this backlog keeps paying for. (`header: false` is different in kind,
 * not degree: there NO column is named, so positional naming is total and
 * stable rather than a patch over one hole.)
 *
 * A TRAILING run of empty cells is NOT refused — it is not a column at all. See
 * {@link trimTrailingEmpty}.
 */
function headerNames(rawCells: readonly string[]): string[] {
  const cells = trimTrailingEmpty(rawCells);
  if (cells.length === 0) {
    throw new DatasetIoError('permanent', 'the header names no columns');
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < cells.length; index += 1) {
    const name = cells[index]!;
    if (name === '') {
      throw new DatasetIoError(
        'permanent',
        `the header has no name for column ${index + 1} — every column a mapping can name must be named`,
      );
    }
    if (seen.has(name)) {
      throw new DatasetIoError(
        'permanent',
        `the header names '${name}' more than once, so a row cannot carry both columns`,
      );
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * Drop a trailing run of EMPTY cells.
 *
 * A trailing delimiter (`a,b,`) is a spreadsheet-export artifact, not a third
 * column: it names nothing and carries nothing. Applied to the HEADER here and,
 * in the excess-only form {@link bindRow} needs, to every data row — ONE rule,
 * so a file whose header ends with a delimiter and whose rows do too is not
 * accepted on one line and refused on the next.
 *
 * It is a TRAILING run and never an interior cell: `a,,c` keeps its hole, which
 * is what lets {@link headerNames} still refuse an unnamed column that has data.
 */
function trimTrailingEmpty(cells: readonly string[]): readonly string[] {
  let end = cells.length;
  while (end > 0 && cells[end - 1] === '') end -= 1;
  return end === cells.length ? cells : cells.slice(0, end);
}

/**
 * Positional names for a headerless file: `column1`…`columnN`, 1-indexed
 * because that is how an operator counts columns in a spreadsheet.
 *
 * The width comes from the FIRST row, and slice 1 already owes the statement
 * this makes true: a headerless source is the one case where §7's "without
 * reading a row" cannot hold, because learning the width needs a row. It is
 * stated rather than quietly excepted.
 */
function positionalNames(width: number): string[] {
  return Array.from({ length: width }, (_, index) => `column${index + 1}`);
}

/**
 * Bind one positional row to the column names — the RAGGED-ROW policy, and the
 * asymmetry is the whole decision.
 *
 * Every name is assigned on every row, so the key set is UNIFORM. That is a
 * contract with the pump, not tidiness: `planColumns` resolves the plan ONCE
 * from the first row's `Object.keys` (`datamove/pump.ts`), so a row that simply
 * omitted its missing keys could change the plan depending on which row arrived
 * first.
 *
 * A SHORT row binds its missing names to `undefined`, which lands on
 * `coerce.ts`'s `absent_value` — a PER-ROW failure counted in `rowsFailed`, or a
 * `null` where the mapping declared `onError: 'null'`. That is #1155's lesson
 * applied: one unusable row must not destroy the whole copy. And it only fires
 * for a column the mapping actually WANTS; a short row missing only unmapped
 * columns copies without comment, which is correct — nothing was going to read
 * them.
 *
 * A row with an extra field THAT CARRIES SOMETHING is refused, and the copy with
 * it. The reader has no per-row error channel — `readBatches` yields rows and
 * the sink's `writeRows` owns the transaction — so the honest options are
 * refuse, or silently discard fields the file contains. Discarding is
 * unrecoverable data loss that nothing would report. The cost is bounded and
 * worth naming: the sink is ONE transaction reporting
 * `partialWritePossible: false`, so a refusal mid-scan costs a wasted read and a
 * provably clean store, never a partial write.
 *
 * An extra EMPTY field is not refused, and the distinction is the whole reason
 * this is not a length check. `1,2,` against a two-column header is a trailing
 * delimiter — the most common spreadsheet-export artifact there is, and it
 * appears on EVERY row of such a file, so refusing it would reject the whole
 * document rather than cost a one-time authoring fix. The refusal exists to stop
 * DATA being discarded, and an empty field is not data; dropping it discards
 * nothing. `1,2,3` is still refused, on the same rule.
 *
 * The message names a DATA ROW ORDINAL, not a line number. The grammar's own
 * line counter never crosses the seam, and it would not be the same number
 * anyway — blank lines are skipped, so the two diverge on exactly the files
 * where an operator most needs the number to be right.
 */
function bindRow(
  names: readonly string[],
  cells: readonly string[],
  ordinal: number,
): Record<string, unknown> {
  if (cells.length > names.length) {
    // ONLY the excess is examined. Trimming the row's whole trailing run of
    // empties instead would eat a legitimately empty LAST column — `1,,`
    // against three columns would bind two of them `undefined` and fail rows
    // that are perfectly good.
    const extra = cells.slice(names.length);
    if (extra.some((cell) => cell !== '')) {
      throw new DatasetIoError(
        'permanent',
        `data row ${ordinal} carries ${cells.length} fields but the source has ${names.length} columns — ` +
          'the extra fields have no column to be written to',
      );
    }
  }
  const row: Record<string, unknown> = {};
  for (let index = 0; index < names.length; index += 1) {
    // A short row leaves `undefined` here ON PURPOSE, and the key still exists.
    row[names[index]!] = cells[index];
  }
  return row;
}

/**
 * The grammar's options, built ONCE from the dataset config so the read and the
 * describe cannot parse the same file by different rules — a describe that
 * disagreed with the scan about a delimiter would gate on columns the copy then
 * never sees.
 *
 * `batchRows` is deliberately NOT defaulted here: slice 1 refuses a default in
 * the grammar because `COPY_BATCH_ROWS` lives in the server's `limits.ts` and a
 * second copy of it could drift. The callers pass it, for the same reason.
 * Validating it is the grammar's job too — it throws `invalid_batch_rows`, which
 * `readFailure` maps to `permanent`.
 */
function parseOptionsFor(
  config: DelimitedConfig,
  batchRows: number,
): Parameters<typeof parseDelimitedRows>[1] {
  return {
    delimiter: config.delimiter,
    quote: config.quote,
    ...(config.escape === undefined ? {} : { escape: config.escape }),
    batchRows,
    maxFieldChars: DELIMITED_MAX_FIELD_CHARS,
    maxRowChars: DELIMITED_MAX_ROW_CHARS,
  };
}

/** The column names for a file's first row, under either header mode. */
function namesFrom(header: boolean, firstRow: readonly string[]): readonly string[] {
  return header ? headerNames(firstRow) : positionalNames(trimTrailingEmpty(firstRow).length);
}

function chunkBytesFor(read: DelimitedDatasetRead): number {
  const chunkBytes = read.chunkBytes ?? FS_STREAM_CHUNK_BYTES;
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1) {
    throw new DatasetIoError(
      'permanent',
      `chunkBytes must be a positive integer, got ${chunkBytes}`,
    );
  }
  return chunkBytes;
}

/** The refusal for a source that yields no rows at all, shared by both entry points. */
function noRowsError(path: string, header: boolean): DatasetIoError {
  return new DatasetIoError(
    'permanent',
    header
      ? `'${path}' contains no rows, so it has no header row to name its columns`
      : `'${path}' contains no rows, so its columns cannot be counted`,
  );
}

/**
 * Stream a `delimited` dataset out of an `fs` store in bounded batches
 * to the event loop between them (§9's batch-yield).
 *
 * A file with a header row and NO data rows succeeds over zero rows — that is
 * the well-formed empty source, and it is distinct from a file with no rows at
 * all, which cannot say what its columns are and is refused.
 */
export async function* readDelimitedDatasetBatches(
  read: DelimitedDatasetRead,
): AsyncGenerator<Record<string, unknown>[], void, undefined> {
  const { path, config } = await prepareRead(read);
  const chunkBytes = chunkBytesFor(read);
  // Before the handle, matching `readSqliteDatasetBatches`, which checks after
  // confinement and before it opens the store. An already-cancelled read should
  // not pay for an `open` + `stat` — cheap locally, not cheap on a wedged mount.
  if (read.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset read aborted');

  let names: readonly string[] | undefined;
  let ordinal = 0;
  let first = true;
  try {
    for await (const rawBatch of parseDelimitedRows(
      decodedChunks(path, config.encoding, chunkBytes, read.signal),
      parseOptionsFor(config, read.batchRows ?? COPY_BATCH_ROWS),
    )) {
      if (rawBatch.length === 0) continue;
      let cellRows: readonly string[][] = rawBatch;
      if (names === undefined) {
        names = namesFrom(config.header, rawBatch[0]!);
        if (config.header) cellRows = rawBatch.slice(1);
      }
      if (cellRows.length === 0) continue;

      // Cancellation and the yield are BOTH at the batch boundary (§9, §10) —
      // the abort unconditionally, the yield only between batches, so a copy
      // does not pay a macrotask before it has produced anything.
      if (!first) await yieldToEventLoop();
      if (read.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset read aborted');
      first = false;

      const bound = names;
      yield cellRows.map((cells) => {
        ordinal += 1;
        return bindRow(bound, cells, ordinal);
      });
    }
  } catch (err) {
    throw readFailure(err, read.signal, `the delimited source '${path}' could not be read`);
  }
  if (names === undefined) throw noRowsError(path, config.header);
}

/**
 * #1148 M6 (§7) — the source's ACTUAL column names, for the drift gate that runs
 * BEFORE the first row moves.
 *
 * §7's as-built block names this implementation by anticipation: "`Statement.columns()`
 * for `sqlite`; M7's `delimited` implements it from the CSV header row". Slice 1
 * specified the mechanism too, and it is why there is no separate header entry
 * point to keep in step: take the FIRST ROW of the first batch at `batchRows: 1`
 * and return. The same `namesFrom` derives them here and in the read, so the
 * duplicate- and empty-name refusals fire identically at the gate and at the
 * scan — which matters, because a describe that collapsed and a read that
 * refused would fail LATE instead of at the gate that exists to be early.
 *
 * THE ONE HONEST EXCEPTION to "without reading a row": with `header: false` the
 * width can only be learnt from a row, so one is read. Nothing is copied from
 * it, but the file IS touched, and pretending otherwise would be the kind of
 * quiet exception that makes a gate's guarantee untrue exactly where it matters.
 */
export async function describeDelimitedDatasetColumns(
  read: DelimitedDatasetRead,
): Promise<readonly string[]> {
  const { path, config } = await prepareRead(read);
  const chunkBytes = chunkBytesFor(read);
  if (read.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset describe aborted');
  try {
    for await (const rawBatch of parseDelimitedRows(
      decodedChunks(path, config.encoding, chunkBytes, read.signal),
      parseOptionsFor(config, 1),
    )) {
      if (rawBatch.length === 0) continue;
      return namesFrom(config.header, rawBatch[0]!);
    }
  } catch (err) {
    throw readFailure(err, read.signal, `the delimited source '${path}' could not be described`);
  }
  throw noRowsError(path, config.header);
}
