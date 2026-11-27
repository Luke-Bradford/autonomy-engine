import pLimit from 'p-limit';
import {
  GET_METADATA_ACTIVITY_TYPE,
  LOOKUP_ACTIVITY_TYPE,
  inferDatasetColumns,
  inlineQuerySqlIssue,
  previewCopyRows,
  type CoercionOptions,
  type ConnectionKind,
  type CopyPreviewResult,
  type CopyPumpMappingEntry,
  type DataType,
  type DatasetColumn,
  type DatasetPreviewResult,
  type DatasetSchemaResult,
  type DatasetTablesResult,
  type InlineDataset,
} from '@autonomy-studio/shared';
import { delimitedCoercionFor } from '../connectors/delimited-io.js';
import { excelCoercionFor } from '../connectors/excel-io.js';
import { logSafeRow } from '../connectors/lookup.js';
import { READABLE_RELKINDS_SQL } from '../connectors/postgres-session.js';
import type { ConnectorRegistry } from '../connectors/registry.js';
import { redactSecrets } from '../connectors/redact.js';
import type { ConnectorAdapter, ResolvedDataset } from '../connectors/types.js';
import {
  LOOKUP_BYTE_CAP,
  PREVIEW_BACKSTOP_MS,
  PREVIEW_CONCURRENCY,
  PREVIEW_ROW_CAP,
} from '../limits.js';
import { runBounded } from '../util/bounded-attempt.js';
import { resolveInlineSource } from './inline-source.js';

const previewLimit = pLimit(PREVIEW_CONCURRENCY);

/** The id a preview's synthetic activity context carries; it names no run. */
const PREVIEW_ID = 'preview';

/** The store a preview reads, already gated by the route. */
export interface PreviewStoreArgs {
  readonly registry: ConnectorRegistry;
  readonly connection: { readonly kind: ConnectionKind; readonly config: Record<string, unknown> };
  /** Already decrypted by the caller; `null` for a store that holds none. */
  readonly secret: string | null;
  /** The caller went away: abort the read and answer nothing useful. */
  readonly signal?: AbortSignal;
  /** Overridable so a test can prove the backstop without waiting a minute. */
  readonly backstopMs?: number;
}

export interface PreviewInlineSourceArgs extends PreviewStoreArgs {
  /** Every bind value already literal: the form asks for one in place of a `${}`. */
  readonly inline: InlineDataset;
}

/** #1401 OR10 — a saved dataset, read as stored (no per-dispatch overrides). */
export interface PreviewDatasetArgs extends PreviewStoreArgs {
  readonly dataset: ResolvedDataset;
}

/**
 * #1600 C1q-c — read the first rows of an inline Table or Query, as the Source
 * tab's Preview shows them. NEVER throws: the caller is an HTTP handler, and an
 * adapter fault must reach the operator as a sentence, not a 500.
 *
 * THE READ IS LOOKUP'S. It dispatches the store adapter's own `lookup` arm on a
 * synthetic context, so Preview inherits that read whole: the same reader the
 * run uses (sqlite opened read-only; postgres inside `BEGIN READ ONLY`, always
 * rolled back), its row and byte caps, and its JSON-safe row values. A preview
 * cannot show rows the run would read differently, because it is not a second
 * reader.
 *
 * The checks are the run's too: `resolveInlineSource` (store kind, secret marker,
 * config) and save's literal-SQL rule, so Preview never shows rows for a source
 * that cannot be saved or would be refused at dispatch.
 */
export async function previewInlineSource(
  args: PreviewInlineSourceArgs,
): Promise<DatasetPreviewResult> {
  const resolved = checkInline(args);
  if ('error' in resolved) return { ok: false, error: resolved.error };
  return previewSavedDataset({ ...args, dataset: resolved.dataset });
}

/**
 * #1401 OR10 — a saved dataset's first rows and the columns they show, for the
 * dataset page's Preview and the Copy panel's source and sink. The same Lookup
 * read as `previewInlineSource`, on any dataset kind the store's Lookup reads:
 * a delimited or Excel file (confined to the connection's `roots` by the fs
 * reader), a table or a query.
 */
export async function previewSavedDataset(args: PreviewDatasetArgs): Promise<DatasetPreviewResult> {
  return readRows(args, 'the preview', (shown, raw, coercion) => ({
    ...shown,
    columns: inferDatasetColumns(raw, coercion),
  }));
}

/**
 * #1401 OR10 — the columns Import schema fills a dataset's form with. A `table`
 * answers from the store's own column list (Get metadata's Structure read), so
 * an empty table still has columns. Every other kind infers them from the
 * preview's rows (`inferDatasetColumns`). Writes nothing.
 *
 * A table's columns are all `nullable`: the store's Structure read names a type
 * and not a constraint, and the declared schema is an authoring aid the sink's
 * own NOT NULL check does not trust (`sink-columns.ts`).
 */
export async function datasetSchema(args: PreviewDatasetArgs): Promise<DatasetSchemaResult> {
  const { dataset, connection } = args;
  if (dataset.kind === 'table') {
    return readThroughStore(
      args,
      { activityType: GET_METADATA_ACTIVITY_TYPE, input: { fieldList: ['structure'] } },
      'reading the columns',
      (outputs) => {
        const structure = Array.isArray(outputs['structure']) ? outputs['structure'] : [];
        const columns = structure.flatMap((column: unknown): DatasetColumn[] => {
          if (typeof column !== 'object' || column === null) return [];
          const { name, type } = column as Record<string, unknown>;
          if (typeof name !== 'string' || name === '') return [];
          const typeName = typeof type === 'string' ? type : '';
          return [{ name, type: storeDataType(connection.kind, typeName), nullable: true }];
        });
        return { ok: true, columns, from: 'table' };
      },
    );
  }
  return readRows(args, 'reading the columns', (shown, raw, coercion) =>
    shown.rows.length === 0
      ? {
          ok: false,
          error: shown.truncated
            ? 'the first row alone is over the preview limit, so no columns could be read'
            : 'the source has no rows, so there are no columns to read',
        }
      : { ok: true, columns: inferDatasetColumns(raw, coercion), from: 'sample' },
  );
}

/**
 * #1401 OR10 — the Copy node's preview: the source's first rows mapped and
 * coerced as the copy would hand them to the sink (`previewCopyRows`), each
 * failing cell named. It coerces the reader's own values, as the copy does, and
 * makes them JSON-safe only after.
 */
export async function previewCopy(
  args: PreviewStoreArgs & {
    /** A saved dataset as stored, or an inline Table or Query with literal values. */
    readonly source: { readonly dataset: ResolvedDataset } | { readonly inline: InlineDataset };
    readonly mapping: readonly CopyPumpMappingEntry[];
  },
): Promise<CopyPreviewResult> {
  const { source, mapping } = args;
  const resolved = 'dataset' in source ? source : checkInline({ ...args, inline: source.inline });
  if ('error' in resolved) return { ok: false, error: resolved.error };
  return readRows(
    { ...args, dataset: resolved.dataset },
    'the copy preview',
    (shown, raw, coercion) => {
      const mapped = previewCopyRows(raw, mapping, coercion);
      if (!mapped.ok) return mapped;
      return {
        ok: true,
        rows: mapped.rows.map((row, index) => ({
          values: logSafeRow(row.values, index, undefined),
          failures: row.failures,
        })),
        truncated: shown.truncated,
        ...(shown.note === undefined ? {} : { note: shown.note }),
      };
    },
  );
}

/**
 * #1401 OR10 — a store's own type name as the `DataType` a copy would declare
 * for it: postgres's `format_type`, sqlite's declared type read by its affinity
 * rules. A name it does not know is a `string`, the one type every value the
 * readers produce except bytes can be read as.
 */
export function storeDataType(kind: ConnectionKind, typeName: string): DataType {
  const t = typeName.trim().toLowerCase();
  if (kind === 'postgres') {
    if (/^(smallint|integer|bigint)$/.test(t)) return 'integer';
    if (/^(numeric|decimal|real|double precision)/.test(t)) return 'number';
    if (t === 'boolean') return 'boolean';
    if (t === 'date') return 'date';
    if (t.startsWith('timestamp')) return 'timestamp';
    if (t === 'bytea') return 'binary';
    return 'string';
  }
  if (t.includes('int')) return 'integer';
  if (/char|clob|text/.test(t)) return 'string';
  if (t.includes('blob')) return 'binary';
  if (/real|floa|doub|numeric|decimal/.test(t)) return 'number';
  if (t.includes('bool')) return 'boolean';
  if (t.includes('timestamp') || t.includes('datetime')) return 'timestamp';
  if (t.includes('date')) return 'date';
  return 'string';
}

/**
 * The SQL that lists a store's tables and views, per store an inline Table can
 * live in. Only a test holds it to `DATASET_CONNECTION_KINDS.table` (that map is
 * not typed narrowly enough for the compiler to), so a store added there fails
 * the test until it says how its tables are listed.
 *
 * sqlite: the main database's `sqlite_master`, as `sqlite-sink.ts` reads it,
 * without sqlite's own `sqlite_`-prefixed tables (the reader never ATTACHes, so
 * main is the only database). An FTS or R-tree index's shadow tables are listed;
 * they are tables sqlite will read.
 *
 * postgres: `pg_class`, as `postgres-sink.ts` reads it rather than
 * `information_schema`, which omits materialized views and lists a relation the
 * role holds any privilege on. Here: tables, partitioned tables (not their
 * partitions), views, materialized views and foreign tables the role can
 * SELECT in a schema it can use, outside the `pg_` and `information_schema` schemas.
 */
export const TABLE_CATALOG_SQL: Partial<Record<ConnectionKind, string>> = {
  sqlite:
    "SELECT NULL AS schema, name FROM sqlite_master WHERE type IN ('table', 'view') " +
    "AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
  postgres:
    'SELECT n.nspname AS schema, c.relname AS name FROM pg_class c ' +
    'JOIN pg_namespace n ON n.oid = c.relnamespace ' +
    `WHERE c.relkind IN ${READABLE_RELKINDS_SQL} AND NOT c.relispartition ` +
    "AND has_table_privilege(c.oid, 'SELECT') AND has_schema_privilege(n.oid, 'USAGE') " +
    "AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_' ORDER BY 1, 2",
};

/**
 * #1600 C1q-c — the tables and views a connection's store lists, for the Source
 * tab's Table `[▾ from the connection]`. NEVER throws, as `previewInlineSource`.
 *
 * It is the same read, not a second one: the catalogue query goes through the
 * store adapter's own Lookup arm as an inline Query, so it inherits the
 * read-only reader, the row and byte caps, the backstop and Preview's pool (a
 * listing takes one of its slots).
 */
export async function listConnectionTables(args: PreviewStoreArgs): Promise<DatasetTablesResult> {
  const kind = args.connection.kind;
  const sql = TABLE_CATALOG_SQL[kind];
  if (sql === undefined) {
    return { ok: false, error: `a '${kind}' connection has no tables to list` };
  }
  const resolved = checkInline({ ...args, inline: { kind: 'query', config: { sql } } });
  if ('error' in resolved) return { ok: false, error: resolved.error };
  return readThroughStore(
    { ...args, dataset: resolved.dataset },
    { activityType: LOOKUP_ACTIVITY_TYPE, input: {} },
    'listing tables',
    tablesOf,
  );
}

/** An inline source's checks: save's literal-SQL rule, then the run's own. */
function checkInline(
  args: PreviewInlineSourceArgs,
): { error: string } | { dataset: ResolvedDataset } {
  const { inline, connection } = args;
  const sqlIssue = inlineQuerySqlIssue(inline.kind, inline.config);
  if (sqlIssue !== null) return { error: sqlIssue };
  return resolveInlineSource(inline, connection.kind);
}

/**
 * The format facts the copy reads the dataset with (`nullValue`, `dateFormat`),
 * as the store's own `sourceCoercion` derives them. A database kind has none.
 */
function coercionOf(dataset: ResolvedDataset): CoercionOptions {
  if (dataset.kind === 'delimited') return delimitedCoercionFor(dataset.config);
  if (dataset.kind === 'excel') return excelCoercionFor(dataset.config);
  return {};
}

/**
 * Read a dataset's first rows through the store's Lookup arm, and answer with
 * `toResult` of what the preview shows, the reader's own values for those rows
 * (`onLookupRow`, before they are made JSON-safe) and the dataset's coercion.
 */
async function readRows<R extends { ok: boolean }>(
  args: PreviewDatasetArgs,
  what: string,
  toResult: (
    shown: Extract<DatasetPreviewResult, { ok: true }>,
    raw: Readonly<Record<string, unknown>>[],
    coercion: CoercionOptions,
  ) => R | Refusal,
): Promise<R | Refusal> {
  let coercion: CoercionOptions;
  try {
    coercion = coercionOf(args.dataset);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const raw: Readonly<Record<string, unknown>>[] = [];
  return readThroughStore(
    args,
    {
      activityType: LOOKUP_ACTIVITY_TYPE,
      input: {},
      onLookupRow: (row) => {
        if (raw.length < PREVIEW_ROW_CAP) raw.push(row);
      },
    },
    what,
    (outputs) => {
      const shown = prefixOf(outputs);
      return toResult(shown, raw.slice(0, shown.rows.length), coercion);
    },
  );
}

/** Which arm of the store adapter a preview dispatches, and with what. */
interface PreviewDispatch {
  readonly activityType: string;
  readonly input: Record<string, unknown>;
  readonly onLookupRow?: (row: Readonly<Record<string, unknown>>) => void;
}

/**
 * Read a dataset through one of the store adapter's read-only arms (Lookup, or
 * Get metadata for a table's columns) and answer the caller with `toResult` of
 * its outputs, or a refusal.
 *
 * CONCURRENCY is `runBounded`'s (#1720): the slot is held until the REAL read
 * settles, and the caller is answered on its own timer.
 */
async function readThroughStore<R extends { ok: boolean }>(
  args: PreviewDatasetArgs,
  dispatch: PreviewDispatch,
  what: string,
  toResult: (outputs: Record<string, unknown>) => R | Refusal,
): Promise<R | Refusal> {
  const { registry, connection, secret, signal, backstopMs = PREVIEW_BACKSTOP_MS } = args;
  const adapter = registry.get(connection.kind);
  if (adapter === undefined) {
    return { ok: false, error: `no adapter for connection kind '${connection.kind}'` };
  }

  return runBounded<R | Refusal>({
    limit: previewLimit,
    backstopMs,
    signal,
    work: (abort) => readOutputs(args, adapter, dispatch, abort, toResult),
    onStop: (stop) => ({
      ok: false,
      error:
        stop === 'cancelled'
          ? `${what} was cancelled`
          : `${what} did not finish within ${Math.round(backstopMs / 1000)}s and was stopped`,
    }),
    // An adapter's stream threw rather than yielding `failed`. Its message is
    // the least trusted string here, so it is redacted like a failure's.
    onThrow: (err) => ({
      ok: false,
      error: redactSecrets(err instanceof Error ? err.message : String(err), [secret]),
    }),
  });
}

type Refusal = { ok: false; error: string };

async function readOutputs<R>(
  args: PreviewDatasetArgs,
  adapter: ConnectorAdapter,
  dispatch: PreviewDispatch,
  signal: AbortSignal,
  toResult: (outputs: Record<string, unknown>) => R,
): Promise<R | Refusal> {
  const events = adapter.runActivity(
    {
      runId: PREVIEW_ID,
      nodeId: PREVIEW_ID,
      attemptId: PREVIEW_ID,
      activityType: dispatch.activityType,
      input: dispatch.input,
      connectionConfig: args.connection.config,
      datasets: { source: args.dataset },
      signal,
      ...(dispatch.onLookupRow === undefined ? {} : { onLookupRow: dispatch.onLookupRow }),
    },
    args.secret,
  );
  for await (const event of events) {
    if (event.type === 'failed') {
      return { ok: false, error: redactSecrets(event.error, [args.secret]) };
    }
    if (event.type === 'succeeded') return toResult(event.outputs);
  }
  return { ok: false, error: 'the store ended the read without an answer' };
}

/** Lookup's `{ rows, truncated }` as the preview's first `PREVIEW_ROW_CAP` rows. */
function prefixOf(
  outputs: Record<string, unknown>,
): Omit<Extract<DatasetPreviewResult, { ok: true }>, 'columns'> & { columns: [] } {
  const all = Array.isArray(outputs['rows']) ? (outputs['rows'] as Record<string, unknown>[]) : [];
  const rows = all.slice(0, PREVIEW_ROW_CAP);
  const capped = outputs['truncated'] === true;
  const truncated = capped || all.length > rows.length;
  // Lookup stopped on its byte cap before the preview's row cap: say so, or a
  // short or empty table reads as a short or empty source.
  if (capped && rows.length < PREVIEW_ROW_CAP) {
    const limit = `${LOOKUP_BYTE_CAP / (1024 * 1024)} MiB`;
    const note =
      rows.length === 0
        ? `The first row alone is larger than the ${limit} preview limit, so no rows are shown. Select fewer or narrower columns.`
        : `Only the first ${rows.length} rows fit in the ${limit} preview limit.`;
    return { ok: true, rows, truncated, note, columns: [] };
  }
  return { ok: true, rows, truncated, columns: [] };
}

/** Lookup's rows as `{ schema, name }`; a row without a string name is not offered. */
function tablesOf(outputs: Record<string, unknown>): DatasetTablesResult & { ok: true } {
  const rows = Array.isArray(outputs['rows']) ? (outputs['rows'] as Record<string, unknown>[]) : [];
  const tables = rows.flatMap((row) => {
    const { schema, name } = row;
    if (typeof name !== 'string' || name === '') return [];
    return [{ schema: typeof schema === 'string' ? schema : null, name }];
  });
  return { ok: true, tables, truncated: outputs['truncated'] === true };
}
