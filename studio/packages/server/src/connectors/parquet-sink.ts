import { ByteWriter, ParquetWriter, type ColumnSource, type SchemaElement } from 'hyparquet-writer';
import type { DataType } from '@autonomy-studio/shared';
import { DatasetIoError } from './dataset-io-error.js';
import type { FileSinkWrite } from './file-sink.js';
import type { SinkValue } from './sqlite-sink.js';
import { PARQUET_ROW_GROUP_ROWS } from '../limits.js';

/**
 * #1405 OR14 — a copy's rows as a Parquet file, through `hyparquet-writer`
 * (pure JS, MIT). `file-sink.ts` owns the file: the temp, the sync, the rename.
 * This turns rows into the file's bytes.
 *
 * TYPES. Each column is written with the type its mapping DECLARES, so a copy
 * from a CSV, whose values are all text, still writes a typed file:
 *
 * | Mapping type | Parquet physical | Logical          |
 * |--------------|------------------|------------------|
 * | string       | BYTE_ARRAY       | STRING           |
 * | integer      | INT64            | INTEGER(64, signed) |
 * | number       | DOUBLE           | —                |
 * | boolean      | BOOLEAN          | —                |
 * | date         | INT32            | DATE             |
 * | timestamp    | INT64            | TIMESTAMP(UTC, micros) |
 * | binary       | BYTE_ARRAY       | —                |
 *
 * Every column is OPTIONAL, as the pump may hand any column a null. The values
 * arrive already coerced to the mapping's type (`datamove/coerce.ts`): a date
 * as `yyyy-MM-dd` text and a timestamp as ISO-8601 UTC text, which this turns
 * into days and microseconds since the epoch.
 *
 * MEMORY. Rows are gathered into a row group of `PARQUET_ROW_GROUP_ROWS`, then
 * encoded and handed on; the writer's buffer is emptied after each group. So
 * what is held is one row group, never the file. Column chunks are compressed
 * with Snappy, the format's usual codec.
 */

/** Each mapping type's Parquet column. */
function schemaElement(name: string, type: DataType): SchemaElement {
  const optional = { name, repetition_type: 'OPTIONAL' } as const;
  switch (type) {
    case 'string':
      return {
        ...optional,
        type: 'BYTE_ARRAY',
        converted_type: 'UTF8',
        logical_type: { type: 'STRING' },
      };
    case 'integer':
      return {
        ...optional,
        type: 'INT64',
        converted_type: 'INT_64',
        logical_type: { type: 'INTEGER', bitWidth: 64, isSigned: true },
      };
    case 'number':
      return { ...optional, type: 'DOUBLE' };
    case 'boolean':
      return { ...optional, type: 'BOOLEAN' };
    case 'date':
      return { ...optional, type: 'INT32', converted_type: 'DATE', logical_type: { type: 'DATE' } };
    case 'timestamp':
      return {
        ...optional,
        type: 'INT64',
        converted_type: 'TIMESTAMP_MICROS',
        logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: true, unit: 'MICROS' },
      };
    case 'binary':
      return { ...optional, type: 'BYTE_ARRAY' };
  }
}

const DAY_MS = 86_400_000;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** Milliseconds since the epoch of coerced date or timestamp text, or a refusal naming the column. */
function epochMs(value: string, column: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new DatasetIoError(
      'permanent',
      `column '${column}' holds a value that is not a date or time`,
    );
  }
  return ms;
}

/** A coerced value as the Parquet column of `type` stores it. */
function parquetValue(value: SinkValue | undefined, type: DataType, column: string): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'string':
      return value instanceof Uint8Array ? Buffer.from(value).toString('base64') : String(value);
    case 'integer': {
      const n = typeof value === 'bigint' ? value : BigInt(Number(value));
      if (n < INT64_MIN || n > INT64_MAX) {
        throw new DatasetIoError(
          'permanent',
          `column '${column}' holds an integer too large for Parquet's 64-bit integer; map it as number or string`,
        );
      }
      return n;
    }
    case 'number':
      return Number(value);
    case 'boolean':
      return Boolean(value);
    case 'date':
      return Math.floor(epochMs(String(value), column) / DAY_MS);
    case 'timestamp':
      return BigInt(epochMs(String(value), column)) * 1000n;
    case 'binary':
      return value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
  }
}

/**
 * A `ByteWriter` that gives its bytes up after each row group instead of
 * holding the whole file, so the caller can stream them to disk.
 */
class DrainingWriter extends ByteWriter {
  private readonly drained: Buffer[] = [];

  flush(): void {
    if (this.index > 0) this.drained.push(Buffer.from(this.buffer.slice(0, this.index)));
    this.index = 0;
  }

  override finish(): void {
    this.flush();
  }

  /** The bytes written since the last call. */
  take(): Buffer[] {
    return this.drained.splice(0);
  }
}

/** The Parquet encoder for `file-sink.ts`. */
export function parquetEncoder(write: FileSinkWrite) {
  const { columns, columnTypes } = write;
  if (columnTypes.length !== columns.length) {
    throw new DatasetIoError(
      'permanent',
      'a Parquet sink needs a declared type for every mapped column',
    );
  }
  return async function* (
    batches: AsyncIterable<readonly Record<string, SinkValue>[]>,
    onRows: (rowsWritten: number) => void,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<Buffer, void, undefined> {
    const writer = new DrainingWriter();
    const parquet = new ParquetWriter({
      writer,
      schema: [
        { name: 'root', num_children: columns.length },
        ...columns.map((name, i) => schemaElement(name, columnTypes[i]!)),
      ],
      codec: 'SNAPPY',
      createdBy: 'autonomy-studio',
    });
    let group: unknown[][] = columns.map(() => []);
    let grouped = 0;
    let rows = 0;
    const writeGroup = async (): Promise<void> => {
      if (grouped === 0) return;
      const columnData: ColumnSource[] = columns.map((name, i) => ({ name, data: group[i]! }));
      await parquet.write({ columnData, rowGroupSize: grouped });
      group = columns.map(() => []);
      grouped = 0;
    };

    for await (const batch of batches) {
      if (signal?.aborted) throw new DatasetIoError('cancelled', 'dataset write aborted');
      for (const row of batch) {
        for (let i = 0; i < columns.length; i += 1) {
          group[i]!.push(parquetValue(row[columns[i]!], columnTypes[i]!, columns[i]!));
        }
        grouped += 1;
        rows += 1;
        if (grouped >= PARQUET_ROW_GROUP_ROWS) {
          await writeGroup();
          yield* writer.take();
        }
      }
      onRows(rows);
    }
    await writeGroup();
    await parquet.finish();
    yield* writer.take();
  };
}
