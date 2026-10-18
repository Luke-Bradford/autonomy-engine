import { createHash } from 'node:crypto';
import { autoCreateCollisionIssue, type DataType } from '@autonomy-studio/shared';
import { DatasetIoError } from './dataset-io-error.js';
import { quoteIdentifier } from './sql-identifier.js';
import { quoteStoreIdentifier } from './sqlite-store.js';

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

/** What one store needs to create a table. */
interface AutoCreateStore {
  /**
   * The column type each `DataType` is created as. A `Record` over the closed
   * set, so a type added to `DataTypeSchema` does not compile until every store
   * says what it becomes.
   */
  readonly types: Readonly<Record<DataType, string>>;
  /** The longest name the store keeps as written, or `null` for no limit. */
  readonly maxName: number | null;
  /** How a column name is quoted: the same quoter the store's sink writes with,
   * so a name the sink can write into an existing table can also be created. */
  readonly quoteColumn: (name: string) => string;
  /** Whether the statement carries `IF NOT EXISTS`. */
  readonly ifNotExists: boolean;
}

/**
 * - **SQLite**: its affinity names, chosen to hold exactly what the coercion
 *   matrix produces. A boolean binds as 1 or 0, and a date or a timestamp is ISO
 *   text (`coerce.ts`), which sorts in time order as TEXT. `IF NOT EXISTS` is the
 *   whole existence check, under the sink's `begin immediate`.
 * - **PostgreSQL**: `timestamptz` because a coerced timestamp is a UTC instant
 *   (`toISOString()`, with its `Z`); `bigint` holds every integer the matrix
 *   produces, a `bigint` past 2^53 included. A name is at most 63 characters
 *   (`NAMEDATALEN - 1`): the server silently TRUNCATES a longer one, so a column
 *   would be created under a name the mapping does not use. Names are ASCII
 *   (`SQL_IDENTIFIER_RE`), so characters and bytes agree. No `IF NOT EXISTS`:
 *   the sink checks first (`postgres-sink.ts` says why).
 */
export const AUTO_CREATE_STORES: Readonly<Record<'sqlite' | 'postgres', AutoCreateStore>> = {
  sqlite: {
    types: {
      string: 'TEXT',
      integer: 'INTEGER',
      number: 'REAL',
      boolean: 'INTEGER',
      date: 'TEXT',
      timestamp: 'TEXT',
      binary: 'BLOB',
    },
    maxName: null,
    quoteColumn: quoteStoreIdentifier,
    ifNotExists: true,
  },
  postgres: {
    types: {
      string: 'text',
      integer: 'bigint',
      number: 'double precision',
      boolean: 'boolean',
      date: 'date',
      timestamp: 'timestamptz',
      binary: 'bytea',
    },
    maxName: 63,
    quoteColumn: (name) => quoteIdentifier(name, 'column'),
    ifNotExists: false,
  },
};

/**
 * The `CREATE TABLE` for `table.qualified` (already quoted), or a `permanent`
 * refusal. `table.names` are its raw schema and table names, held to the
 * store's name limit with the columns.
 */
export function autoCreateTableSql(
  store: 'sqlite' | 'postgres',
  table: { readonly qualified: string; readonly names: readonly string[] },
  columns: readonly AutoCreateColumn[],
): string {
  if (columns.length === 0) {
    throw new DatasetIoError('permanent', 'Auto-create needs at least one mapped column');
  }
  // The dispatch schema already refused this; re-checked for a direct caller.
  const collision = autoCreateCollisionIssue(columns.map((c) => c.name));
  if (collision !== null) throw new DatasetIoError('permanent', collision);
  const spec = AUTO_CREATE_STORES[store];
  const max = spec.maxName;
  if (max !== null) {
    const long = [...table.names, ...columns.map((c) => c.name)].find((n) => n.length > max);
    if (long !== undefined) {
      throw new DatasetIoError(
        'permanent',
        `Auto-create cannot create '${long}': a ${store === 'postgres' ? 'PostgreSQL' : store} name is at most ${max} characters`,
      );
    }
  }
  const defs = columns.map((c) => `${spec.quoteColumn(c.name)} ${spec.types[c.type]}`);
  return `CREATE TABLE ${spec.ifNotExists ? 'IF NOT EXISTS ' : ''}${table.qualified} (${defs.join(', ')})`;
}

/**
 * The PostgreSQL advisory-lock key Auto-create serialises one table's creation
 * on: the first 8 bytes of a SHA-256 over a fixed prefix and `schema.table`, as
 * a signed 64-bit integer (`pg_try_advisory_xact_lock(bigint)`). `schema` is the
 * RESOLVED creation schema, so two copies spelling one table differently (`t`
 * and `public.t`) take one lock. Computed here rather than with the server's
 * `hashtext`, which is internal and undocumented. Names hold no `.`
 * (`SQL_IDENTIFIER_RE`), so `schema.table` is unambiguous.
 */
export function autoCreateLockKey(schema: string, table: string): string {
  const digest = createHash('sha256')
    .update(`autonomy-studio:copy-auto-create:${schema}.${table}`)
    .digest();
  return digest.readBigInt64BE(0).toString();
}
