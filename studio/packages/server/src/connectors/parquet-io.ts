import { open, stat } from 'node:fs/promises';
import { brotliDecompressSync, gunzipSync, zstdDecompressSync } from 'node:zlib';
import {
  parquetMetadataAsync,
  parquetReadObjects,
  parquetSchema,
  toJson,
  type AsyncBuffer,
  type Compressors,
  type FileMetaData,
} from 'hyparquet';
import {
  formatZodIssues,
  parquetDatasetConfigSchema,
  type CoercionOptions,
  type DatasetAddress,
  type DatasetKind,
} from '@autonomy-studio/shared';
import { CONFINED_READ_FLAGS, resolveWithinRoots, resolveWithinRootsOrMissing } from './confine.js';
import { DatasetIoError } from './dataset-io-error.js';
import { classifyFsError, fsConnectionConfigSchema } from './fs-connection.js';
import { yieldToEventLoop } from './scheduling.js';
import { COPY_BATCH_ROWS } from '../limits.js';

/**
 * #1405 OR14 — the READER for a `parquet` dataset over an `fs` connection,
 * through `hyparquet` (pure JS, MIT).
 *
 * MEMORY: Parquet is read a ROW GROUP at a time, from positional reads of the
 * file (only the footer and the group's column chunks are fetched), and the
 * group's rows are then yielded in batches of `batchRows`. So what is held is
 * one row group, not the file. A file written as one huge row group is held
 * whole; that is the format's unit, and the residual is stated here.
 *
 * VALUES are the file's own types, which the pump then coerces: an INT64 is a
 * bigint, a DATE or TIMESTAMP a `Date`, a BYTE_ARRAY without a string type its
 * bytes. A nested value (a list, a map, a struct, a JSON column) is carried as
 * its JSON text, as the JSON reader carries one.
 *
 * COMPRESSION is the file's, per column chunk. Snappy is built in; gzip,
 * brotli and zstd are Node's own zlib. LZ4 and LZO are refused with the
 * library's message.
 *
 * The path is confined by the one shared guard and the file opened
 * `O_NOFOLLOW`, as the other file readers do (§8).
 */

export interface ParquetDatasetRead {
  /** The `fs` connection's stored config — RE-PARSED here, never trusted (§8). */
  readonly connectionConfig: Record<string, unknown>;
  readonly datasetKind: DatasetKind;
  readonly datasetConfig: Record<string, unknown>;
  /** Rows per yielded batch. Defaults to `COPY_BATCH_ROWS`. */
  readonly batchRows?: number;
  readonly signal?: AbortSignal;
}

/** The codecs Node can inflate, beside the Snappy `hyparquet` brings. */
const COMPRESSORS: Compressors = {
  GZIP: (input) => new Uint8Array(gunzipSync(input)),
  BROTLI: (input) => new Uint8Array(brotliDecompressSync(input)),
  ZSTD: (input) => new Uint8Array(zstdDecompressSync(input)),
};

function failure(err: unknown, signal: AbortSignal | undefined, context: string): DatasetIoError {
  if (err instanceof DatasetIoError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new DatasetIoError(classifyFsError(err, signal), `${context}: ${message}`, { cause: err });
}

async function prepareRead(
  read: ParquetDatasetRead,
  options: { readonly missingFolderOk?: boolean } = {},
): Promise<string> {
  if (read.datasetKind !== 'parquet') {
    throw new DatasetIoError(
      'permanent',
      `the Parquet reader reads 'parquet' datasets; this one is '${read.datasetKind}'`,
    );
  }
  const cfg = fsConnectionConfigSchema.safeParse(read.connectionConfig);
  if (!cfg.success) {
    throw new DatasetIoError(
      'permanent',
      `invalid fs connection config: ${formatZodIssues(cfg.error.issues)}`,
    );
  }
  const config = parquetDatasetConfigSchema.safeParse(read.datasetConfig);
  if (!config.success) {
    throw new DatasetIoError(
      'permanent',
      `invalid parquet dataset config: ${formatZodIssues(config.error.issues)}`,
    );
  }
  let confined: Awaited<ReturnType<typeof resolveWithinRoots>>;
  try {
    confined = await (options.missingFolderOk ? resolveWithinRootsOrMissing : resolveWithinRoots)(
      cfg.data.roots,
      config.data.path,
      'fs',
    );
  } catch (err) {
    throw failure(err, read.signal, `cannot resolve the Parquet file '${config.data.path}'`);
  }
  if (!confined.ok) throw new DatasetIoError('permanent', confined.error);
  return confined.path;
}

/** An open Parquet file: its bytes by position, its footer, and its close. */
interface OpenParquet {
  readonly file: AsyncBuffer;
  readonly metadata: FileMetaData;
  readonly close: () => Promise<void>;
}

/** Open the file `O_NOFOLLOW` and read its footer. The caller closes it. */
async function openParquet(path: string, signal: AbortSignal | undefined): Promise<OpenParquet> {
  const fh = await open(path, CONFINED_READ_FLAGS);
  const close = async (): Promise<void> => {
    try {
      await fh.close();
    } catch {
      // Never let a close failure replace the outcome being unwound.
    }
  };
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new DatasetIoError('permanent', `'${path}' is not a regular file`);
    const file: AsyncBuffer = {
      byteLength: st.size,
      slice: async (start, end = st.size) => {
        if (signal?.aborted) throw new DatasetIoError('cancelled', 'dataset read aborted');
        const bytes = new Uint8Array(Math.max(0, end - start));
        let at = 0;
        while (at < bytes.length) {
          const { bytesRead } = await fh.read(bytes, at, bytes.length - at, start + at);
          if (bytesRead === 0) break;
          at += bytesRead;
        }
        return bytes.buffer.slice(0, at);
      },
    };
    let metadata: FileMetaData;
    try {
      metadata = await parquetMetadataAsync(file);
    } catch (err) {
      if (err instanceof DatasetIoError || (err as { code?: unknown }).code !== undefined)
        throw err;
      throw new DatasetIoError(
        'permanent',
        `'${path}' is not a Parquet file (${err instanceof Error ? err.message : String(err)})`,
        { cause: err },
      );
    }
    return { file, metadata, close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** The top-level column names, from the file's schema. */
function columnsOf(metadata: FileMetaData): readonly string[] {
  return parquetSchema(metadata).children.map((child) => child.element.name);
}

/** A value as the pump takes it: a nested value as its JSON text. */
function cellOf(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date || value instanceof Uint8Array) return value;
  return JSON.stringify(toJson(value));
}

/** Stream a `parquet` dataset a row group at a time, in batches, yielding to the event loop between them (§9). */
export async function* readParquetDatasetBatches(
  read: ParquetDatasetRead,
): AsyncGenerator<Record<string, unknown>[], void, undefined> {
  const path = await prepareRead(read);
  const batchRows = read.batchRows ?? COPY_BATCH_ROWS;
  if (!Number.isInteger(batchRows) || batchRows < 1) {
    throw new DatasetIoError('permanent', `batchRows must be a positive integer, got ${batchRows}`);
  }
  if (read.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset read aborted');

  let opened: OpenParquet | undefined;
  try {
    opened = await openParquet(path, read.signal);
    const { file, metadata } = opened;
    const columns = columnsOf(metadata);
    let rowStart = 0;
    let first = true;
    for (const group of metadata.row_groups) {
      const rowCount = Number(group.num_rows);
      if (rowCount === 0) continue;
      const rows = await parquetReadObjects({
        file,
        metadata,
        columns: [...columns],
        rowStart,
        rowEnd: rowStart + rowCount,
        compressors: COMPRESSORS,
        // A BYTE_ARRAY column with no string type is bytes, not text.
        utf8: false,
      });
      rowStart += rowCount;
      for (let at = 0; at < rows.length; at += batchRows) {
        if (!first) await yieldToEventLoop();
        if (read.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset read aborted');
        first = false;
        yield rows.slice(at, at + batchRows).map((row) => {
          const bound: Record<string, unknown> = {};
          for (const column of columns) bound[column] = cellOf(row[column]);
          return bound;
        });
      }
    }
  } catch (err) {
    throw failure(err, read.signal, `the Parquet source '${path}' could not be read`);
  } finally {
    await opened?.close();
  }
}

/** §7 — the columns, for the drift gate, from the footer alone: no row is read. */
export async function describeParquetDatasetColumns(
  read: ParquetDatasetRead,
): Promise<readonly string[]> {
  const path = await prepareRead(read);
  if (read.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset describe aborted');
  let opened: OpenParquet | undefined;
  try {
    opened = await openParquet(path, read.signal);
    return columnsOf(opened.metadata);
  } catch (err) {
    throw failure(err, read.signal, `the Parquet source '${path}' could not be described`);
  } finally {
    await opened?.close();
  }
}

/** Where the dataset PHYSICALLY is (§2.1): `resolveDelimitedDatasetAddress`'s shape. */
export async function resolveParquetDatasetAddress(args: {
  readonly connectionConfig: Record<string, unknown>;
  readonly dataset: { readonly kind: DatasetKind; readonly config: Record<string, unknown> };
}): Promise<DatasetAddress> {
  const path = await prepareRead(
    {
      connectionConfig: args.connectionConfig,
      datasetKind: args.dataset.kind,
      datasetConfig: args.dataset.config,
    },
    { missingFolderOk: true },
  );
  let storeIdentity: string | null = null;
  try {
    const stats = await stat(path);
    storeIdentity = `${stats.dev}:${stats.ino}`;
  } catch {
    // Unidentifiable: recorded as such, never a refusal.
  }
  return { kind: 'fs', store: path, storeIdentity, object: path };
}

/** §6.4 — nothing to declare: Parquet has typed dates and a real null. */
export function parquetCoercionFor(): CoercionOptions {
  return {};
}
