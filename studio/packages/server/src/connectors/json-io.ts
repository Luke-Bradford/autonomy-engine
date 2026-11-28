import { stat } from 'node:fs/promises';
import {
  formatZodIssues,
  jsonDatasetConfigSchema,
  jsonlDatasetConfigSchema,
  JsonRecordsError,
  parseJsonRecords,
  type CoercionOptions,
  type DatasetAddress,
  type DatasetKind,
} from '@autonomy-studio/shared';
import { resolveWithinRoots, resolveWithinRootsOrMissing } from './confine.js';
import { DatasetIoError } from './dataset-io-error.js';
import { decodedChunks } from './delimited-io.js';
import { classifyFsError, fsConnectionConfigSchema } from './fs-connection.js';
import { yieldToEventLoop } from './scheduling.js';
import { COPY_BATCH_ROWS, FS_STREAM_CHUNK_BYTES, JSON_MAX_RECORD_CHARS } from '../limits.js';

/**
 * #1405 OR14 — the READER for a `json` or `jsonl` dataset over an `fs`
 * connection. `delimited-io.ts`'s shape, and it shares that reader's byte
 * stream (`decodedChunks`: `O_NOFOLLOW`, a fatal decoder, gzip, the per-chunk
 * abort), so the two kinds cannot open or decode a file differently.
 *
 * The record grammar is `shared`'s `parseJsonRecords`. What this owns:
 *
 * **Naming.** A record is an OBJECT and its keys are the columns, taken from
 * the FIRST record, so the drift gate and the scan agree on them. A key a later
 * record leaves out binds as absent, which fails only a row whose mapping wants
 * that column (`delimited-io.ts`'s short-row rule). A key the first record
 * lacks is REFUSED, as a CSV row with extra fields is: dropping it would lose
 * data that nothing reports.
 *
 * **Values.** A string, number, boolean or null is passed as it is, so the pump
 * coerces a real JSON number rather than its text. A nested object or array is
 * passed as its JSON text, which a `string` or `json` mapping can carry on.
 *
 * Every file is UTF-8 (RFC 8259 §8.1); a dataset declares no encoding.
 */

/** What one `json`/`jsonl` dataset read needs to know. */
export interface JsonDatasetRead {
  /** The `fs` connection's stored config — RE-PARSED here, never trusted (§8). */
  readonly connectionConfig: Record<string, unknown>;
  readonly datasetKind: DatasetKind;
  readonly datasetConfig: Record<string, unknown>;
  /** Records per yielded batch. Defaults to `COPY_BATCH_ROWS`. */
  readonly batchRows?: number;
  /** Bytes per `read()`. Defaults to `FS_STREAM_CHUNK_BYTES`. */
  readonly chunkBytes?: number;
  readonly signal?: AbortSignal;
}

type JsonConfig = ReturnType<typeof jsonDatasetConfigSchema.parse>;

function readFailure(
  err: unknown,
  signal: AbortSignal | undefined,
  context: string,
): DatasetIoError {
  if (err instanceof DatasetIoError) return err;
  if (err instanceof JsonRecordsError) {
    // A malformed document is a fact a retry cannot change.
    return new DatasetIoError('permanent', `${context}: ${err.message}`, { cause: err });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new DatasetIoError(classifyFsError(err, signal), `${context}: ${message}`, { cause: err });
}

/** Validate both configs and confine the path, before a byte is read. */
async function prepareRead(
  read: JsonDatasetRead,
  options: { readonly missingFolderOk?: boolean } = {},
): Promise<{ readonly path: string; readonly config: JsonConfig; readonly lines: boolean }> {
  if (read.datasetKind !== 'json' && read.datasetKind !== 'jsonl') {
    throw new DatasetIoError(
      'permanent',
      `the JSON reader reads 'json' and 'jsonl' datasets; this one is '${read.datasetKind}'`,
    );
  }
  const cfg = fsConnectionConfigSchema.safeParse(read.connectionConfig);
  if (!cfg.success) {
    throw new DatasetIoError(
      'permanent',
      `invalid fs connection config: ${formatZodIssues(cfg.error.issues)}`,
    );
  }
  const lines = read.datasetKind === 'jsonl';
  const schema = lines ? jsonlDatasetConfigSchema : jsonDatasetConfigSchema;
  const config = schema.safeParse(read.datasetConfig);
  if (!config.success) {
    throw new DatasetIoError(
      'permanent',
      `invalid ${read.datasetKind} dataset config: ${formatZodIssues(config.error.issues)}`,
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
    // `resolveWithinRoots` throws a raw errno for its caller to classify.
    throw readFailure(err, read.signal, `cannot resolve the JSON file '${config.data.path}'`);
  }
  if (!confined.ok) throw new DatasetIoError('permanent', confined.error);
  return { path: confined.path, config: config.data, lines };
}

function chunkBytesFor(read: JsonDatasetRead): number {
  const chunkBytes = read.chunkBytes ?? FS_STREAM_CHUNK_BYTES;
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1) {
    throw new DatasetIoError(
      'permanent',
      `chunkBytes must be a positive integer, got ${chunkBytes}`,
    );
  }
  return chunkBytes;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The columns, from the first record. */
function namesFrom(first: unknown, path: string): readonly string[] {
  if (!isObject(first)) {
    throw new DatasetIoError(
      'permanent',
      `'${path}' record 1 is not a JSON object, so it names no columns`,
    );
  }
  const names = Object.keys(first);
  if (names.length === 0) {
    throw new DatasetIoError(
      'permanent',
      `'${path}' record 1 is an empty object, so it names no columns`,
    );
  }
  return names;
}

/** A JSON value as the pump takes it: nested values as their JSON text. */
function cellOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : value;
}

/** One record bound to the columns. Every name is set on every row (`bindRow`'s contract). */
function bindRecord(
  names: readonly string[],
  known: ReadonlySet<string>,
  record: unknown,
  ordinal: number,
  path: string,
): Record<string, unknown> {
  if (!isObject(record)) {
    throw new DatasetIoError('permanent', `'${path}' record ${ordinal} is not a JSON object`);
  }
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      throw new DatasetIoError(
        'permanent',
        `'${path}' record ${ordinal} has the key '${key}', which the first record does not — ` +
          'the columns are the first record’s keys, so it has no column to be written to',
      );
    }
  }
  const row: Record<string, unknown> = {};
  for (const name of names)
    row[name] = Object.hasOwn(record, name) ? cellOf(record[name]) : undefined;
  return row;
}

function noRecordsError(path: string): DatasetIoError {
  return new DatasetIoError(
    'permanent',
    `'${path}' holds no records, so it has no keys to name its columns`,
  );
}

async function* records(
  read: JsonDatasetRead,
  path: string,
  config: JsonConfig,
  lines: boolean,
  batchRows: number,
): AsyncGenerator<unknown[], void, undefined> {
  yield* parseJsonRecords(
    decodedChunks(path, 'utf-8', config.compression, chunkBytesFor(read), read.signal),
    { layout: lines ? 'lines' : 'array', batchRows, maxRecordChars: JSON_MAX_RECORD_CHARS },
  );
}

/** Stream a `json`/`jsonl` dataset in bounded batches, yielding to the event loop between them (§9). */
export async function* readJsonDatasetBatches(
  read: JsonDatasetRead,
): AsyncGenerator<Record<string, unknown>[], void, undefined> {
  const { path, config, lines } = await prepareRead(read);
  if (read.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset read aborted');

  let names: readonly string[] | undefined;
  let known: ReadonlySet<string> = new Set();
  let ordinal = 0;
  let first = true;
  try {
    for await (const batch of records(
      read,
      path,
      config,
      lines,
      read.batchRows ?? COPY_BATCH_ROWS,
    )) {
      if (batch.length === 0) continue;
      if (names === undefined) {
        names = namesFrom(batch[0], path);
        known = new Set(names);
      }
      if (!first) await yieldToEventLoop();
      if (read.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset read aborted');
      first = false;
      const bound = names;
      yield batch.map((record) => {
        ordinal += 1;
        return bindRecord(bound, known, record, ordinal, path);
      });
    }
  } catch (err) {
    throw readFailure(err, read.signal, `the JSON source '${path}' could not be read`);
  }
  if (names === undefined) throw noRecordsError(path);
}

/** §7 — the columns, for the drift gate: the first record's keys. Reads one record. */
export async function describeJsonDatasetColumns(
  read: JsonDatasetRead,
): Promise<readonly string[]> {
  const { path, config, lines } = await prepareRead(read);
  if (read.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset describe aborted');
  try {
    for await (const batch of records(read, path, config, lines, 1)) {
      if (batch.length > 0) return namesFrom(batch[0], path);
    }
  } catch (err) {
    throw readFailure(err, read.signal, `the JSON source '${path}' could not be described`);
  }
  throw noRecordsError(path);
}

/**
 * Where the dataset PHYSICALLY is (§2.1): the confined path, as store and
 * object, with `dev:ino` as the store's identity. `resolveDelimitedDatasetAddress`'s
 * shape and reasoning.
 */
export async function resolveJsonDatasetAddress(args: {
  readonly connectionConfig: Record<string, unknown>;
  readonly dataset: { readonly kind: DatasetKind; readonly config: Record<string, unknown> };
}): Promise<DatasetAddress> {
  const { path } = await prepareRead(
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

/**
 * §6.4's format facts for the pump. `dateFormat` only: JSON has a real null,
 * so there is no null marker to declare. Both kinds carry the same keys.
 */
export function jsonCoercionFor(datasetConfig: Record<string, unknown>): CoercionOptions {
  const parsed = jsonDatasetConfigSchema.safeParse(datasetConfig);
  if (!parsed.success) {
    throw new DatasetIoError(
      'permanent',
      `invalid JSON dataset config: ${formatZodIssues(parsed.error.issues)}`,
    );
  }
  const { dateFormat } = parsed.data;
  return dateFormat === undefined ? {} : { dateFormat };
}
