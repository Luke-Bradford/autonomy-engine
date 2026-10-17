import pLimit from 'p-limit';
import {
  LOOKUP_ACTIVITY_TYPE,
  inlineQuerySqlIssue,
  type ConnectionKind,
  type DatasetPreviewResult,
  type DatasetTablesResult,
  type InlineDataset,
} from '@autonomy-studio/shared';
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

export interface PreviewInlineSourceArgs {
  readonly registry: ConnectorRegistry;
  readonly connection: { readonly kind: ConnectionKind; readonly config: Record<string, unknown> };
  /** Already decrypted by the caller; `null` for a store that holds none. */
  readonly secret: string | null;
  /** Every bind value already literal: the form asks for one in place of a `${}`. */
  readonly inline: InlineDataset;
  /** The caller went away: abort the read and answer nothing useful. */
  readonly signal?: AbortSignal;
  /** Overridable so a test can prove the backstop without waiting a minute. */
  readonly backstopMs?: number;
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
  return readThroughLookup(args, 'the preview', prefixOf);
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
export async function listConnectionTables(
  args: Omit<PreviewInlineSourceArgs, 'inline'>,
): Promise<DatasetTablesResult> {
  const kind = args.connection.kind;
  const sql = TABLE_CATALOG_SQL[kind];
  if (sql === undefined) {
    return { ok: false, error: `a '${kind}' connection has no tables to list` };
  }
  return readThroughLookup(
    { ...args, inline: { kind: 'query', config: { sql } } },
    'listing tables',
    tablesOf,
  );
}

/**
 * Read an inline source through the store adapter's `lookup` arm and answer the
 * caller with `toResult` of its outputs, or a refusal.
 *
 * CONCURRENCY is `runBounded`'s (#1720): the slot is held until the REAL read
 * settles, and the caller is answered on its own timer.
 */
async function readThroughLookup<R extends { ok: true }>(
  args: PreviewInlineSourceArgs,
  what: string,
  toResult: (outputs: Record<string, unknown>) => R,
): Promise<R | Refusal> {
  const { registry, connection, secret, inline, signal, backstopMs = PREVIEW_BACKSTOP_MS } = args;

  const sqlIssue = inlineQuerySqlIssue(inline.kind, inline.config);
  if (sqlIssue !== null) return { ok: false, error: sqlIssue };
  const resolved = resolveInlineSource(inline, connection.kind);
  if ('error' in resolved) return { ok: false, error: resolved.error };
  const adapter = registry.get(connection.kind);
  if (adapter === undefined) {
    return { ok: false, error: `no adapter for connection kind '${connection.kind}'` };
  }

  return runBounded<R | Refusal>({
    limit: previewLimit,
    backstopMs,
    signal,
    work: (abort) => readOutputs(args, adapter, resolved.dataset, abort, toResult),
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
  args: PreviewInlineSourceArgs,
  adapter: ConnectorAdapter,
  dataset: ResolvedDataset,
  signal: AbortSignal,
  toResult: (outputs: Record<string, unknown>) => R,
): Promise<R | Refusal> {
  const events = adapter.runActivity(
    {
      runId: PREVIEW_ID,
      nodeId: PREVIEW_ID,
      attemptId: PREVIEW_ID,
      activityType: LOOKUP_ACTIVITY_TYPE,
      input: {},
      connectionConfig: args.connection.config,
      datasets: { source: dataset },
      signal,
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
function prefixOf(outputs: Record<string, unknown>): DatasetPreviewResult & { ok: true } {
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
    return { ok: true, rows, truncated, note };
  }
  return { ok: true, rows, truncated };
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
