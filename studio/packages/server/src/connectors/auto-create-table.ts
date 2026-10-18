import { autoCreateCollisionIssue, type DataType } from '@autonomy-studio/shared';
import { DatasetIoError } from './dataset-io-error.js';
import { quoteIdentifier } from './sql-identifier.js';

/**
 * #1600 OR41 C3c — Copy's Table option *Auto-create from mapping* (catalogue
 * §4.1, ADF's `tableOption: autoCreate`): the DDL each database sink runs when
 * the sink table does not exist.
 *
 * The columns are the mapping's sink names and declared types, in mapping
 * order. Every column is nullable and there is no primary key: the mapping
 * declares neither, and inventing one would be a constraint nobody asked for.
 * Each sink runs the statement inside its write transaction, so a failed copy
 * undoes the create.
 */
export interface AutoCreateColumn {
  readonly name: string;
  readonly type: DataType;
}

/**
 * The column type each `DataType` is created as, per store. A `Record` over the
 * closed set, so a type added to `DataTypeSchema` does not compile until both
 * stores say what it becomes.
 *
 * SQLite's are its five affinity names, chosen to hold exactly what the
 * coercion matrix produces: a boolean binds as 1 or 0, and a date or a
 * timestamp is ISO text (`coerce.ts`), which sorts in time order as TEXT.
 * PostgreSQL's `timestamptz` because a coerced timestamp is a UTC instant
 * (`toISOString()`, with its `Z`); `bigint` holds every integer the matrix
 * produces, a `bigint` past 2^53 included.
 */
export const AUTO_CREATE_COLUMN_TYPES: Readonly<
  Record<'sqlite' | 'postgres', Readonly<Record<DataType, string>>>
> = {
  sqlite: {
    string: 'TEXT',
    integer: 'INTEGER',
    number: 'REAL',
    boolean: 'INTEGER',
    date: 'TEXT',
    timestamp: 'TEXT',
    binary: 'BLOB',
  },
  postgres: {
    string: 'text',
    integer: 'bigint',
    number: 'double precision',
    boolean: 'boolean',
    date: 'date',
    timestamp: 'timestamptz',
    binary: 'bytea',
  },
};

/**
 * PostgreSQL's identifier limit (`NAMEDATALEN - 1`). A longer name is silently
 * TRUNCATED by the server, so the column would be created under a name the
 * mapping does not use. Identifiers are ASCII (`SQL_IDENTIFIER_RE`), so bytes
 * and characters agree.
 */
export const POSTGRES_MAX_IDENTIFIER_BYTES = 63;

/** The `CREATE TABLE` for `qualified` (already quoted), or a `permanent` refusal. */
export function autoCreateTableSql(
  store: 'sqlite' | 'postgres',
  qualified: string,
  columns: readonly AutoCreateColumn[],
): string {
  if (columns.length === 0) {
    throw new DatasetIoError('permanent', 'Auto-create needs at least one mapped column');
  }
  const collision = autoCreateCollisionIssue(columns.map((c) => c.name));
  if (collision !== null) throw new DatasetIoError('permanent', collision);
  const types = AUTO_CREATE_COLUMN_TYPES[store];
  const defs = columns.map((c) => {
    if (store === 'postgres' && c.name.length > POSTGRES_MAX_IDENTIFIER_BYTES) {
      throw new DatasetIoError(
        'permanent',
        `Auto-create cannot create column '${c.name}': PostgreSQL names are at most ${POSTGRES_MAX_IDENTIFIER_BYTES} characters`,
      );
    }
    return `${quoteIdentifier(c.name, 'column')} ${types[c.type]}`;
  });
  // SQLite's `IF NOT EXISTS` is the whole existence check. PostgreSQL's sink
  // checks first instead (`postgres-sink.ts` says why), so its statement has none.
  return `CREATE TABLE ${store === 'sqlite' ? 'IF NOT EXISTS ' : ''}${qualified} (${defs.join(', ')})`;
}
