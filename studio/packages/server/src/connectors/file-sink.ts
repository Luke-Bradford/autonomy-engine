import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, open, rename, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import {
  delimitedDatasetConfigSchema,
  formatDelimitedRow,
  formatZodIssues,
  type CopyWriteMode,
  type DatasetKind,
  type DelimitedEncoding,
  type FileCompression,
} from '@autonomy-studio/shared';
import { O_NOFOLLOW, resolveWithinRoots } from './confine.js';
import { DatasetIoError } from './dataset-io-error.js';
import { classifyFsError } from './fs-connection.js';
import { closeQuietly, LINK_UNSUPPORTED, tmpPathFor } from './fs-write.js';
import type { PreCopyScript } from './pre-copy-script.js';
import { writableFs } from './session-log-file.js';
import type { SinkValue } from './sqlite-sink.js';

/**
 * #1405 OR14 — a FILE as a copy sink: the rows a copy moves, written into a
 * dataset's file on an `fs` connection.
 *
 * ATOMIC, as the database sinks' one transaction is (§4). The rows go into a
 * fresh temp file beside the target, which is synced and closed and only then
 * put in place, so a copy that fails part-way leaves the old file whole and no
 * temp behind. The reader's own error passes through unchanged, as it does
 * through the database sinks, so the copy reports it in its own words.
 *
 * WRITE BEHAVIOUR, for a file:
 * - **Overwrite** and **Truncate then insert** replace the file, by a rename.
 * - **Append** writes a NEW file and refuses one that is already there, by a
 *   hard link, which cannot replace a file that appeared after it looked. So a
 *   copy that runs again never destroys an earlier run's file: a path made per
 *   run with `${}` (the dataset's parameters) gives a file per run, and Append
 *   is the default, so a copy saved without a behaviour cannot overwrite.
 *   Adding rows to the end of an existing file is not offered: it cannot be
 *   made atomic without copying the whole file, and it would repeat the header.
 * - **Upsert** is refused: a file has no keys to match rows on.
 *
 * A Pre-copy script is refused (there is no SQL to run it in). Auto-create
 * needs nothing, as the file is always created; the folder must exist.
 * Nothing in a file can reject a row, so Skip incompatible rows never fires
 * here and every row the pump hands over is written.
 *
 * The sink connection must allow writes (`writableFs`, fail-closed), and the
 * path is confined to its folders by the one shared guard, re-validated here
 * rather than trusted (§8).
 */

/** What one file write needs — the subset of `SinkWriteRequest` a file uses. */
export interface FileSinkWrite {
  /** The `fs` SINK connection's stored config — re-parsed here, never trusted. */
  readonly connectionConfig: Record<string, unknown>;
  readonly datasetKind: DatasetKind;
  readonly datasetConfig: Record<string, unknown>;
  /** The mapping's sink names, in order: the file's columns. */
  readonly columns: readonly string[];
  readonly mode: CopyWriteMode;
  readonly preCopyScript: PreCopyScript | null;
  readonly verifyBeforeCommit: ((rowsWritten: number) => string | null) | null;
  readonly onBatch: (rowsWritten: number) => void;
  readonly signal?: AbortSignal;
}

/** How one file kind turns rows into text. */
interface FileFormat {
  readonly encoding: DelimitedEncoding;
  readonly compression: FileCompression;
  /** Text before the first row ('' for none). */
  readonly begin: string;
  /** One row's text. */
  readonly row: (row: Readonly<Record<string, SinkValue>>) => string;
}

/** A value as the text a delimited field holds; `null` stays null. */
function fieldText(value: SinkValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  return String(value);
}

function delimitedFormat(datasetConfig: Record<string, unknown>, columns: readonly string[]): FileFormat {
  const parsed = delimitedDatasetConfigSchema.safeParse(datasetConfig);
  if (!parsed.success) {
    throw new DatasetIoError(
      'permanent',
      `invalid delimited dataset config: ${formatZodIssues(parsed.error.issues)}`,
    );
  }
  const config = parsed.data;
  const opts = {
    delimiter: config.delimiter,
    quote: config.quote,
    ...(config.escape === undefined ? {} : { escape: config.escape }),
  };
  const nullText = config.nullValue;
  return {
    encoding: config.encoding,
    compression: config.compression,
    begin: config.header ? formatDelimitedRow(columns, opts) : '',
    row: (row) =>
      formatDelimitedRow(
        columns.map((column) => fieldText(row[column]) ?? nullText ?? null),
        opts,
      ),
  };
}

/** The writer for each file kind a copy can write into. */
function formatFor(write: FileSinkWrite): FileFormat {
  if (write.datasetKind === 'delimited') return delimitedFormat(write.datasetConfig, write.columns);
  throw new DatasetIoError(
    'permanent',
    `a copy writes rows into a 'delimited' file on a file connection; this sink dataset is '${write.datasetKind}'`,
  );
}

/**
 * windows-1252's bytes, by character: the decoder's own table read backwards,
 * so whatever the reader's `TextDecoder` reads a byte as is what the writer
 * writes for it.
 */
const WINDOWS_1252_BYTES: ReadonlyMap<string, number> = (() => {
  const decoder = new TextDecoder('windows-1252');
  const bytes = new Map<string, number>();
  for (let byte = 0; byte < 256; byte += 1) {
    bytes.set(decoder.decode(Uint8Array.of(byte)), byte);
  }
  return bytes;
})();

/** The text in the dataset's encoding. UTF-16 files start with a byte-order mark. */
function encode(text: string, encoding: DelimitedEncoding): Buffer {
  switch (encoding) {
    case 'utf-8':
      return Buffer.from(text, 'utf8');
    case 'utf-16le':
      return Buffer.from(text, 'utf16le');
    case 'utf-16be':
      return Buffer.from(text, 'utf16le').swap16();
    case 'windows-1252': {
      const out = Buffer.allocUnsafe(text.length);
      let at = 0;
      for (const ch of text) {
        const byte = WINDOWS_1252_BYTES.get(ch);
        if (byte === undefined) {
          const code = (ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
          throw new DatasetIoError(
            'permanent',
            `a value holds the character U+${code}, which windows-1252 cannot write; set the dataset's Encoding to UTF-8`,
          );
        }
        out[at] = byte;
        at += 1;
      }
      return out.subarray(0, at);
    }
  }
}

const BYTE_ORDER_MARK = '﻿';

/**
 * Write `batches` into the dataset's file, atomically. Resolves with the rows
 * written; throws a `DatasetIoError` carrying a real failure kind otherwise.
 */
export async function writeFileDatasetRows(
  write: FileSinkWrite,
  batches: AsyncIterable<readonly Record<string, SinkValue>[]>,
): Promise<{ readonly rowsWritten: number }> {
  const format = formatFor(write);
  const sink = writableFs(write.connectionConfig, 'sink');
  if (!sink.ok) throw new DatasetIoError('permanent', sink.error);
  if (write.mode === 'upsert') {
    throw new DatasetIoError(
      'permanent',
      'Upsert matches rows on key columns, and a file has none; use Overwrite, or Append to write a new file',
    );
  }
  if (write.preCopyScript !== null) {
    throw new DatasetIoError(
      'permanent',
      'a Pre-copy script runs SQL in the sink store, and a file sink has none to run it in',
    );
  }
  if (write.columns.length === 0) {
    throw new DatasetIoError('permanent', 'a copy sink needs at least one mapped column');
  }
  const { signal } = write;
  if (signal?.aborted) throw new DatasetIoError('cancelled', 'dataset write aborted');

  const requested = String(write.datasetConfig['path']);
  let target: Awaited<ReturnType<typeof resolveWithinRoots>>;
  try {
    target = await resolveWithinRoots(sink.config.roots, requested, 'fs');
  } catch (err) {
    throw failure(err, signal, `cannot resolve the sink file '${requested}'`);
  }
  if (!target.ok) throw new DatasetIoError('permanent', target.error);
  const finalPath = target.path;
  const tmpPath = tmpPathFor(finalPath, randomUUID());

  let rowsWritten = 0;
  async function* bytes(): AsyncGenerator<Buffer, void, undefined> {
    const utf16 = format.encoding === 'utf-16le' || format.encoding === 'utf-16be';
    const head = (utf16 ? BYTE_ORDER_MARK : '') + format.begin;
    if (head !== '') yield encode(head, format.encoding);
    for await (const batch of batches) {
      if (signal?.aborted) throw new DatasetIoError('cancelled', 'dataset write aborted');
      let text = '';
      for (const row of batch) text += format.row(row);
      if (text !== '') yield encode(text, format.encoding);
      rowsWritten += batch.length;
      write.onBatch(rowsWritten);
    }
  }

  let fh: Awaited<ReturnType<typeof open>> | undefined;
  let placed = false;
  try {
    fh = await open(
      tmpPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
      0o644,
    );
    // `flush` syncs the temp before it closes, so the bytes are on disk before
    // the rename makes them the file (`atomicReplace`'s order).
    const out = fh.createWriteStream({ flush: true });
    fh = undefined; // the stream closes it now, on success or failure
    if (format.compression === 'gzip') await pipeline(bytes(), createGzip(), out);
    else await pipeline(bytes(), out);

    const unverified = write.verifyBeforeCommit?.(rowsWritten) ?? null;
    if (unverified !== null) throw new DatasetIoError('permanent', unverified);
    if (signal?.aborted) throw new DatasetIoError('cancelled', 'dataset write aborted');

    if (write.mode === 'append') {
      try {
        await link(tmpPath, finalPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') {
          throw new DatasetIoError(
            'permanent',
            `'${requested}' already exists, and Append writes a new file rather than replace one; give the path a per-run name with \${} in the dataset's parameters, or set Write behaviour to Overwrite`,
          );
        }
        if (code !== undefined && LINK_UNSUPPORTED.has(code)) {
          throw new DatasetIoError(
            'permanent',
            `the file system at '${requested}' does not support hard links, which Append needs to write without replacing; set Write behaviour to Overwrite`,
          );
        }
        throw err;
      }
    } else {
      await rename(tmpPath, finalPath);
      placed = true;
    }
    return { rowsWritten };
  } catch (err) {
    throw failure(err, signal, `the sink file '${requested}' could not be written`);
  } finally {
    await closeQuietly(fh);
    // A link leaves the temp as the file's second name; a failure leaves it as
    // an orphan. Either way it goes.
    if (!placed) {
      try {
        await unlink(tmpPath);
      } catch {
        // Never created, or already gone.
      }
    }
  }
}

/** An already-classified error passes through; anything else is classified by its errno. */
function failure(err: unknown, signal: AbortSignal | undefined, context: string): DatasetIoError {
  if (err instanceof DatasetIoError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new DatasetIoError(classifyFsError(err, signal), `${context}: ${message}`, { cause: err });
}
