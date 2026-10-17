import { DatasetIoError } from './dataset-io-error.js';
import {
  openSession,
  qualifiedTable,
  READABLE_RELKINDS_SQL,
  readFailure,
  type PostgresClientFactory,
} from './postgres-session.js';
import { tableRef, type TableColumn, type TableMetadataIo } from './table-metadata.js';

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
 * Both statements run in ONE session, in a `READ ONLY` transaction, because
 * counting a VIEW runs the view's query. The connection's statement timeout
 * bounds each, the count included, so a `count(*)` over a huge table is cut off
 * there and fails as a timed-out read does (#1741 has its classification).
 * Cancel is checked before connecting and before the count; a count already
 * running waits for that timeout.
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
     and c.relkind in ${READABLE_RELKINDS_SQL}
   group by c.oid`;

export interface PostgresTableMetadataDeps {
  readonly createClient: PostgresClientFactory;
  readonly connectionConfig: Record<string, unknown>;
  readonly secret: string | null;
}

export function postgresTableMetadata(deps: PostgresTableMetadataDeps): TableMetadataIo {
  return {
    kind: 'postgres',
    inspectTable: async (target, signal, withRowCount) => {
      const qualified = qualifiedTable(target);
      if (signal.aborted) throw new DatasetIoError('cancelled', 'Get metadata aborted');
      const client = await openSession(
        deps.createClient,
        deps.connectionConfig,
        deps.secret,
        'cannot reach the postgres server to read the table',
      );
      try {
        // Ended, not rolled back, on every path: `end()` below closes the
        // session, and a READ ONLY transaction has nothing to undo.
        await client.query('BEGIN READ ONLY');
        const described = await client.query(DESCRIBE_TABLE_SQL, [qualified]);
        const row = described.rows[0] as { readable: boolean; columns: TableColumn[] } | undefined;
        if (row === undefined) return null;
        if (!row.readable) {
          throw new DatasetIoError(
            'permanent',
            `the connection's role cannot read the table '${tableRef(target)}'`,
          );
        }
        if (signal.aborted) throw new DatasetIoError('cancelled', 'Get metadata aborted');
        const rowCount = withRowCount
          ? (
              (await client.query(`select count(*) as n from ${qualified}`)).rows[0] as
                { n: unknown } | undefined
            )?.n
          : undefined;
        return { columns: row.columns.map(({ name, type }) => ({ name, type })), rowCount };
      } catch (err) {
        if (err instanceof DatasetIoError) throw err;
        throw readFailure(err, 'the table could not be read', deps.secret);
      } finally {
        try {
          await client.end();
        } catch {
          // A close that fails must never replace the outcome being unwound.
        }
      }
    },
  };
}
