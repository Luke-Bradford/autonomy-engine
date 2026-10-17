import { tableDatasetConfigSchema, formatZodIssues } from '@autonomy-studio/shared';
import { DatasetIoError } from './dataset-io-error.js';
import {
  openSession,
  qualifiedTable,
  readFailure,
  type PostgresClient,
  type PostgresClientFactory,
} from './postgres-session.js';
import type { TableColumn, TableMetadataIo } from './table-metadata.js';
import type { ResolvedDataset } from './types.js';

/**
 * #1600 OR41 C8c — postgres' half of Get metadata on a table.
 *
 * ONE catalog query answers existence and structure. `to_regclass` resolves the
 * name as a statement would (`search_path` for a bare name, which
 * `information_schema` cannot), and the `relkind` filter is List tables' set
 * (`datamove/preview.ts`), so an index, sequence or type of that name is not a
 * table that exists. A relation the connection's role cannot SELECT is refused
 * rather than described: List tables does not show it, and its columns are not
 * the role's to read.
 *
 * Both statements run in a `READ ONLY` transaction, because counting a VIEW
 * runs the view's query. The connection's statement timeout bounds each, the
 * count included, so a `count(*)` over a huge table is cancelled there and fails
 * `transient` (SQLSTATE 57014), as a slow read does.
 */
const DESCRIBE_TABLE_SQL = `
  select has_table_privilege(c.oid, 'SELECT') as readable,
         coalesce(
           json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod))
                    order by a.attnum)
             filter (where a.attnum is not null),
           '[]'::json) as columns
    from pg_class c
    left join pg_attribute a
      on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
   where c.oid = to_regclass($1)
     and c.relkind in ('r', 'p', 'v', 'm', 'f')
   group by c.oid`;

export interface PostgresTableMetadataDeps {
  readonly createClient: PostgresClientFactory;
  readonly connectionConfig: Record<string, unknown>;
  readonly secret: string | null;
}

function qualifiedOf(dataset: ResolvedDataset): string {
  const parsed = tableDatasetConfigSchema.safeParse(dataset.config);
  if (!parsed.success) {
    throw new DatasetIoError(
      'permanent',
      `invalid table dataset config: ${formatZodIssues(parsed.error.issues)}`,
    );
  }
  return qualifiedTable(parsed.data);
}

export function postgresTableMetadata(deps: PostgresTableMetadataDeps): TableMetadataIo {
  async function inReadOnly<T>(
    signal: AbortSignal,
    context: string,
    use: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    const client = await openSession(
      deps.createClient,
      deps.connectionConfig,
      deps.secret,
      'cannot reach the postgres server to read the table',
    );
    try {
      if (signal.aborted) throw new DatasetIoError('cancelled', 'Get metadata aborted');
      await client.query('BEGIN READ ONLY');
      const result = await use(client);
      await client.query('ROLLBACK');
      return result;
    } catch (err) {
      if (err instanceof DatasetIoError) throw err;
      throw readFailure(err, context, deps.secret);
    } finally {
      try {
        await client.end();
      } catch {
        // A close that fails must never replace the outcome being unwound.
      }
    }
  }

  return {
    kind: 'postgres',
    describeTable: async (dataset, signal) => {
      const qualified = qualifiedOf(dataset);
      return inReadOnly(signal, 'the table could not be described', async (client) => {
        const result = await client.query(DESCRIBE_TABLE_SQL, [qualified]);
        const row = result.rows[0] as { readable: boolean; columns: TableColumn[] } | undefined;
        if (row === undefined) return null;
        if (!row.readable) {
          throw new DatasetIoError(
            'permanent',
            `the connection's role cannot read the table '${qualified}'`,
          );
        }
        return row.columns.map(({ name, type }) => ({ name, type }));
      });
    },
    countRows: async (dataset, signal) => {
      const qualified = qualifiedOf(dataset);
      return inReadOnly(signal, "the table's rows could not be counted", async (client) => {
        const result = await client.query(`select count(*) as n from ${qualified}`);
        return (result.rows[0] as { n: unknown } | undefined)?.n;
      });
    },
  };
}
