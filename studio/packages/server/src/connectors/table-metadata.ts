import {
  emptyGetMetadataFields,
  formatZodIssues,
  getMetadataConfigSchema,
  tableDatasetConfigSchema,
  getMetadataKindIssue,
  type GetMetadataField,
} from '@autonomy-studio/shared';
import { failed } from './activity-events.js';
import { DatasetIoError } from './dataset-io-error.js';
import type { ActivityContext, ActivityEvent } from './types.js';

/**
 * #1600 OR41 C8c — Get metadata on a database TABLE (catalogue §4.3), the
 * store-agnostic half. The sqlite and postgres adapters each supply a
 * {@link TableMetadataIo}; everything a node can get wrong is refused here, once.
 *
 * The table is the source dataset (a saved `table` dataset or an inline Table),
 * never a path: one way to name a table (C1q). Every unticked field is `null`,
 * the fixed contract C8a set for a path.
 *
 * Deliberate differences from ADF, recorded in the catalogue spec:
 * - Structure's `type` is the store's own type name (postgres `format_type`,
 *   sqlite's declared type, `''` when the column declares none), not ADF's
 *   interim types.
 * - Row count is a studio addition.
 * - The `path` output holds the table reference as the dataset writes it.
 */
export interface TableColumn {
  readonly name: string;
  readonly type: string;
}

/** What one store says about a table: its columns, and its row count when asked. */
export interface TableFacts {
  readonly columns: readonly TableColumn[];
  /** `count(*)` as the store returns it; `undefined` when not asked for. */
  readonly rowCount: unknown;
}

export interface TableMetadataIo {
  readonly kind: 'sqlite' | 'postgres';
  /**
   * The table's facts from ONE session, so the columns and the count describe
   * the same table, or `null` when there is no such table or view. Each store
   * checks for cancel before it reads anything.
   */
  inspectTable(
    table: TableTarget,
    signal: AbortSignal,
    withRowCount: boolean,
  ): Promise<TableFacts | null>;
}

/** The dataset's table, validated: `schema` absent means the store's default. */
export interface TableTarget {
  readonly schema?: string;
  readonly table: string;
}

/** A store's count as a `number`, refused above what a `number` holds exactly. */
export function rowCountOf(value: unknown): number {
  const n =
    typeof value === 'bigint'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? BigInt(value)
        : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
          ? BigInt(value)
          : undefined;
  if (n === undefined) {
    throw new DatasetIoError('permanent', 'the store returned a row count that is not a count');
  }
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DatasetIoError(
      'permanent',
      `the table holds ${n} rows, more than Row count can report exactly`,
    );
  }
  return Number(n);
}

/** The table as the dataset writes it: `schema.table`, or the bare name. */
export function tableRef({ schema, table }: TableTarget): string {
  return schema === undefined ? table : `${schema}.${table}`;
}

export async function* runTableMetadata(
  ctx: ActivityContext,
  io: TableMetadataIo,
): AsyncGenerator<ActivityEvent> {
  const input = getMetadataConfigSchema.safeParse(ctx.input);
  if (!input.success) {
    yield failed(
      'permanent',
      `invalid get_metadata activity config: ${formatZodIssues(input.error.issues)}`,
    );
    return;
  }
  const issue = getMetadataKindIssue(input.data, io.kind);
  if (issue !== undefined) {
    yield failed('permanent', issue);
    return;
  }
  const dataset = ctx.datasets?.source;
  // The catalog requires a dataset on a database (`optionalOn` is `fs` only),
  // so the executor refuses a node without one first. Re-stated, as Lookup does.
  if (dataset === undefined) {
    yield failed('permanent', 'Get metadata on a database reads a table — choose one on Source');
    return;
  }
  if (dataset.kind !== 'table') {
    yield failed('permanent', `Get metadata reads a table, not a ${dataset.kind} dataset`);
    return;
  }

  const target = tableDatasetConfigSchema.safeParse(dataset.config);
  if (!target.success) {
    yield failed(
      'permanent',
      `invalid table dataset config: ${formatZodIssues(target.error.issues)}`,
    );
    return;
  }
  const ticked = new Set<GetMetadataField>(input.data.fieldList);
  const fields = emptyGetMetadataFields();
  const path = tableRef(target.data);
  try {
    const facts = await io.inspectTable(target.data, ctx.signal, ticked.has('rowCount'));
    if (facts === null) {
      if (!ticked.has('exists')) {
        yield failed('permanent', `there is no table '${path}'`);
        return;
      }
      yield { type: 'succeeded', outputs: { path, ...fields, exists: false } };
      return;
    }
    if (ticked.has('exists')) fields.exists = true;
    if (ticked.has('structure')) {
      fields.structure = facts.columns.map(({ name, type }) => ({ name, type }));
    }
    if (ticked.has('columnCount')) fields.columnCount = facts.columns.length;
    if (ticked.has('rowCount')) fields.rowCount = rowCountOf(facts.rowCount);
  } catch (err) {
    // The store's own verdict passes through, as Lookup's does: a busy store is
    // `transient`, a missing file `permanent`.
    yield err instanceof DatasetIoError
      ? failed(err.kind, err.message)
      : failed('permanent', err instanceof Error ? err.message : String(err));
    return;
  }
  yield { type: 'succeeded', outputs: { path, ...fields } };
}
