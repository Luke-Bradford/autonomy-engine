import { setTimeout as sleep } from 'node:timers/promises';
import {
  COPY_WRITE_MODES,
  datasetConfigSchema,
  formatZodIssues,
  postgresConnectionConfigSchema,
  tableDatasetConfigSchema,
  type CopyWriteMode,
  type DatasetKind,
} from '@autonomy-studio/shared';
import { DatasetIoError } from './dataset-io-error.js';
import { preCopyScriptRefusal, type PreCopyScript } from './pre-copy-script.js';
import { rewriteNamedParametersToPositional } from './postgres-named-parameters.js';
import { classifySinkFailure } from './error-kind.js';
import { yieldToEventLoop } from './scheduling.js';
import { quoteIdentifier } from './sql-identifier.js';
import {
  autoCreateLockKey,
  autoCreateTableSql,
  type AutoCreateColumn,
} from './auto-create-table.js';
import {
  refuseNullKey,
  refuseNullOnNonNullable,
  resolveSinkColumns,
  resolveUpsertKeys,
  type SinkColumn,
  type UpsertKeyTarget,
} from './sink-columns.js';
import type { SinkValue } from './sqlite-sink.js';
import {
  notAPostgresKind,
  openSession,
  qualifiedTable,
  readFailure,
  type PostgresClient,
  type PostgresClientFactory,
} from './postgres-session.js';

/**
 * #1196 M10 slice 3a (data-movement spec §4/§7/§8) — the postgres copy SINK.
 *
 * The second sink the product has, and the one that makes `copy` a real mesh:
 * any of the three source stores can now write into either of two sink stores.
 * Everything store-agnostic — the dispatch schema, the refusal ladder, the
 * counters, the failure mapping — is still `copy.ts`'s; this file is only what
 * writing into postgres is.
 *
 * It mirrors `writeSqliteDatasetRows`' contract deliberately, so an operator
 * reading a run log cannot tell which store refused them by the SHAPE of the
 * refusal. Where it diverges it is because postgres measurably differs, and each
 * such place says so.
 */

/** What one dataset write needs to know. Mirrors `SqliteDatasetWrite`, plus the
 * two things a NETWORKED store needs and a file store does not: a client factory
 * (so the whole path is assertable without a server) and the credential. */
export interface PostgresDatasetWrite {
  readonly createClient: PostgresClientFactory;
  /** The `postgres` connection's stored config — RE-PARSED here, never trusted. */
  readonly connectionConfig: Record<string, unknown>;
  /** The SINK connection's plaintext credential (`runActivity`'s `sinkSecret`). */
  readonly secret: string | null;
  readonly datasetKind: DatasetKind;
  readonly datasetConfig: Record<string, unknown>;
  /** The sink columns this copy writes, matched case-insensitively (§7). */
  readonly columns: readonly string[];
  /** Mapped sink names whose row sets `onError: 'null'` — the sink checks them
   * against the store's own NOT NULL columns (#1162). Required, so no path
   * can reach a store without the gate. */
  readonly nullOnError: readonly string[];
  readonly mode: CopyWriteMode;
  /** Upsert's Key columns (C3a); empty or absent means the table's primary key. */
  readonly keyColumns?: readonly string[];
  /** #1600 OR41 C3b — the Pre-copy script, run once inside the write
   * transaction before the first row. Absent or `null` runs none. */
  readonly preCopyScript?: PreCopyScript | null;
  /** #1600 OR41 C3c — Auto-create from mapping: the columns to create the
   * table with when it does not exist. Absent or `null` creates nothing. */
  readonly autoCreate?: readonly AutoCreateColumn[] | null;
  /** Honoured at BATCH BOUNDARIES (§10) — a run cancel rolls the copy back. */
  readonly signal?: AbortSignal;
  /** §5's progress channel: the RUNNING TOTAL after each chunk is inserted into
   * the OPEN transaction. **A tick is progress, not committed truth** — these
   * rows sit in an uncommitted transaction, so a later failure rolls every
   * ticked row back. `SqliteDatasetWrite.onBatch`'s wording, and its warning. */
  readonly onBatch?: (rowsWritten: number) => void;
}

/**
 * The bind-parameter ceiling of the extended query protocol, and the reason this
 * file chunks at all.
 *
 * MEASURED against `postgres:17`/`pg@8.23.0`: a single statement carrying 65535
 * parameters is accepted, and 65538 fails with
 * `08P01 bind message has 2 parameter formats but 0 parameters` — the count
 * wraps in a 16-bit field, so the wire message is GARBLED rather than refused.
 * That is the worst shape a limit can have: the error names neither the limit
 * nor the statement, and an operator reading it learns nothing.
 *
 * So the chunk is computed from the column count rather than left to the pump's
 * row batching, which knows nothing about how wide the mapping is. A 70-column
 * mapping tips over at 937 rows, well inside `COPY_BATCH_ROWS`.
 */
const MAX_BIND_PARAMETERS = 65535;

/**
 * #1600 OR41 C3a — the lock each Write behaviour takes before the §7 gate reads.
 * Every one conflicts with `ACCESS EXCLUSIVE`, so the table cannot change
 * between being described and being written. `truncate` takes `ACCESS
 * EXCLUSIVE` itself, up front, because TRUNCATE would otherwise upgrade a
 * weaker lock mid-transaction. `upsert` takes `SHARE ROW EXCLUSIVE`, which
 * conflicts with itself and with every writer's `ROW EXCLUSIVE`, so its
 * "is this key there?" and the write that follows cannot race another writer;
 * readers are not blocked.
 */
const LOCK_MODES: Readonly<Record<CopyWriteMode, string>> = {
  append: 'ROW EXCLUSIVE',
  overwrite: 'EXCLUSIVE',
  truncate: 'ACCESS EXCLUSIVE',
  upsert: 'SHARE ROW EXCLUSIVE',
};

/** Upsert's staging table: session-private, dropped at COMMIT or ROLLBACK. */
const UPSERT_STAGE_NAME = 'studio_copy_upsert';
const UPSERT_STAGE = `pg_temp.${quoteIdentifier(UPSERT_STAGE_NAME, 'table')}`;
/** The staging column that orders a key repeated in the source: the last wins. */
const UPSERT_ORDER_COLUMN = 'studio_copy_ord';

/** The relkinds an INSERT can target. `r` is an ordinary table and `p` a
 * partitioned one, which routes to its partitions; everything else — a view
 * (`v`), a materialized view (`m`), a foreign table (`f`), an index, a sequence
 * — is refused BY NAME rather than reported as a missing table. Measured, an
 * INSERT into a view raises `55000` from inside the transaction, which is
 * exactly the "after the DELETE already ran" failure §7 exists to move to the
 * boundary. */
const INSERTABLE_RELKINDS: ReadonlySet<string> = new Set(['r', 'p']);

const RELKIND_NAMES: Readonly<Record<string, string>> = {
  v: 'a view',
  m: 'a materialized view',
  f: 'a foreign table',
  i: 'an index',
  S: 'a sequence',
  c: 'a composite type',
  t: 'a TOAST table',
};

/** One column as the store describes it. */
interface SinkTableColumn {
  readonly name: string;
  readonly generated: boolean;
  readonly identityAlways: boolean;
  /** `pg_attribute.attnotnull` — see `fillsNulls` for when it is not the whole story. */
  readonly notNull: boolean;
}

interface DescribedSinkTable {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly SinkTableColumn[];
  /** The primary key's columns in key order, the default Upsert key (C3a).
   * Only its key attributes: `indkey` also holds a `PRIMARY KEY … INCLUDE`'s
   * payload columns, after the first `indnkeyatts`. */
  readonly primaryKey: readonly string[];
  /**
   * #1162 — true when something other than the column constraint can decide the
   * fate of a NULL, which makes `attnotnull` evidence of nothing. Measured
   * (postgres 17): a `BEFORE INSERT … FOR EACH ROW` trigger that fills the
   * column makes an explicit NULL insert SUCCEED on an `attnotnull` column. The
   * same holds, by construction, for a `DO INSTEAD` `INSERT` rule (the statement
   * is rewritten) and a FOREIGN-table partition (postgres does not enforce NOT NULL
   * on a foreign table). Checked on the relation AND every relation that
   * inherits from it, because a row routed into a partition fires THAT
   * partition's triggers. Deliberately broad — a plain-inheritance child is
   * never routed to, and including it only skips the gate, which is the
   * permitted direction. Two shapes are NOT counted, because the constraint
   * still certainly fires: a DISABLED trigger (`tgenabled = 'D'` never fires),
   * and a `DO ALSO` rule (the original INSERT still runs).
   */
  readonly fillsNulls: boolean;
}

/**
 * The sink table's ACTUAL columns, resolved THROUGH `to_regclass` on the very
 * string the write will name.
 *
 * This is the one place the postgres sink deliberately does NOT mirror sqlite,
 * and `information_schema` is what it rejects. `information_schema.columns`
 * requires an explicit `table_schema`, so it cannot answer for a dataset that
 * names a bare table and leaves the schema to the session's `search_path` — and
 * guessing `public` would describe one relation while the INSERT wrote to
 * another. MEASURED with `search_path = 's_b','public'` and a `dup` table in
 * each of two schemas: `to_regclass('"dup"')` resolves to `s_b.dup`, which is
 * precisely where an unqualified `INSERT INTO "dup"` lands.
 *
 * Because BOTH are built from one string, the describe and the write cannot
 * disagree about which relation they mean. That is a stronger property than the
 * sqlite path has, and it is free here.
 *
 * It is a BOUND parameter, never interpolated: measured,
 * `to_regclass('"public"."plain"; drop table public.plain')` returns NULL — a
 * name that does not parse is simply not a relation, and nothing executes.
 */
const DESCRIBE_SINK_SQL = `
  select n.nspname as schema,
         c.relname as name,
         c.relkind::text as relkind,
         coalesce((
           select json_agg(json_build_object(
                    'name', a.attname,
                    'generated', a.attgenerated <> '',
                    'identityAlways', a.attidentity = 'a',
                    'notNull', a.attnotnull)
                  order by a.attnum)
             from pg_attribute a
            where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
         ), '[]'::json) as columns,
         coalesce((
           select json_agg(a.attname order by k.ord)
             from pg_index i
             cross join lateral unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
             join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
            where i.indrelid = c.oid and i.indisprimary and k.ord <= i.indnkeyatts
         ), '[]'::json) as "primaryKey",
         exists (
           with recursive tree(relid) as (
             select c.oid
             union all
             select i.inhrelid from pg_inherits i join tree t on i.inhparent = t.relid
           )
           select 1
             from tree t
            where exists (select 1 from pg_trigger g
                           where g.tgrelid = t.relid and (g.tgtype & 7) = 7
                             and g.tgenabled <> 'D')
               or exists (select 1 from pg_rewrite r
                           where r.ev_class = t.relid and r.ev_type = '3' and r.is_instead)
               or exists (select 1 from pg_class f
                           where f.oid = t.relid and f.relkind = 'f')
         ) as "fillsNulls"
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where c.oid = to_regclass($1)`;

async function describeSinkTable(
  client: PostgresClient,
  qualified: string,
  spelled: string,
): Promise<DescribedSinkTable> {
  const result = await client.query(DESCRIBE_SINK_SQL, [qualified]);
  const row = result.rows[0] as
    | {
        schema: string;
        name: string;
        relkind: string;
        columns: SinkTableColumn[];
        primaryKey: string[];
        fillsNulls: boolean;
      }
    | undefined;
  if (row === undefined) {
    throw new DatasetIoError('permanent', `there is no table '${spelled}' in the store`);
  }
  if (!INSERTABLE_RELKINDS.has(row.relkind)) {
    const what = RELKIND_NAMES[row.relkind] ?? `a '${row.relkind}' relation`;
    throw new DatasetIoError(
      'permanent',
      `'${spelled}' is ${what}, not a table, so it cannot be written to`,
    );
  }
  return {
    schema: row.schema,
    name: row.name,
    columns: row.columns,
    primaryKey: row.primaryKey,
    fillsNulls: row.fillsNulls,
  };
}

/**
 * Refuse a mapping that names a column postgres will not accept a value for.
 *
 * A GENERATED column and a `GENERATED ALWAYS AS IDENTITY` column both exist, are
 * both visible, and both refuse an INSERT with `428C9` — measured. SQLite hid
 * generated columns from `pragma_table_info` entirely, so its sink could only
 * report one as "absent from the sink", which its own docblock calls "imprecise
 * but never wrong about the outcome". Postgres hands over the fact, so the
 * refusal names it. Same rung, better sentence.
 */
function refuseUnwritableColumns(
  resolved: readonly SinkColumn[],
  columns: readonly SinkTableColumn[],
): void {
  // Keyed by the store's OWN spelling, and read against columns the shared
  // resolver has ALREADY matched. That ordering is the fix for a real
  // over-refusal: a rung with its own fold index, given only the unwritable
  // columns, refused a mapping naming a legitimately writable `id` whenever the
  // table also held a generated `"ID"` — the fold collided and the name was
  // reported as generated. Postgres would have accepted that INSERT, so it
  // refused work that would have succeeded, which is the one direction §7 says
  // a gate must never fail in. Sharing ONE fold implementation is also what
  // stops the two rungs disagreeing about what "the same column" means.
  const unwritable = new Map<string, string>();
  for (const column of columns) {
    if (column.generated) unwritable.set(column.name, 'a generated column');
    else if (column.identityAlways) {
      unwritable.set(column.name, 'a GENERATED ALWAYS identity column');
    }
  }
  if (unwritable.size === 0) return;
  const said: string[] = [];
  for (const column of resolved) {
    const what = unwritable.get(column.actual);
    if (what !== undefined) said.push(`'${column.mapped}' is ${what}`);
  }
  if (said.length === 0) return;
  throw new DatasetIoError(
    'permanent',
    `${said.join('; ')} — postgres refuses any value for it, so it cannot be a copy target`,
  );
}

/** The `table` dataset config of a SINK, or a refusal. Mirrors
 * `sqlite-sink.ts`'s `sinkTargetFor`, including its two distinct sentences. */
function sinkTargetFor(
  datasetKind: DatasetKind,
  datasetConfig: Record<string, unknown>,
): { schema?: string; table: string } {
  if (datasetKind === 'query') {
    throw new DatasetIoError(
      'permanent',
      'a `query` dataset is a SELECT and has no insert target, so it cannot be a copy sink',
    );
  }
  if (datasetKind !== 'table') {
    throw new DatasetIoError('permanent', notAPostgresKind(datasetKind));
  }
  // Through the outer union first, exactly as the reader's `sourceStatementFor`
  // does (#1195's review round): a malformed config is a CLASSIFIED `permanent`
  // refusal carrying the formatted issues, never an uncaught `ZodError`.
  const outer = datasetConfigSchema('table').safeParse(datasetConfig);
  if (!outer.success) {
    throw new DatasetIoError(
      'permanent',
      `invalid table dataset config: ${formatZodIssues(outer.error.issues)}`,
    );
  }
  return tableDatasetConfigSchema.parse(outer.data);
}

/**
 * Bind one value.
 *
 * MUCH shorter than sqlite's `bindValue`, and the difference is measured rather
 * than an omission. `pg` binds every `SinkValue` member as it stands: `bigint`
 * round-trips exactly into `int8` (measured, 2^53+1 survives), `boolean` binds
 * as a boolean and renders `'true'` into a text column, and a `Uint8Array`
 * round-trips through `bytea` byte for byte. SQLite needed a boolean arm only
 * because `better-sqlite3` THROWS on one.
 *
 * `undefined` is REFUSED rather than bound, and that rung is NOT inherited on
 * faith — measured, `pg` binds `undefined` as NULL and the insert succeeds,
 * which is the same silent "an absent fact manufactured as a benign one" #473
 * turned into data loss. Identical wording to sqlite's, because it is
 * identically wrong there.
 *
 * There is deliberately NO `Date` arm. `CoercedValue` has no `Date` member and
 * `coerceValue` renders every instant to ISO text before it becomes one
 * (`datamove/coerce.ts`), so a `Date` cannot reach this seam — a branch for it
 * would be code no input can execute. That is load-bearing rather than
 * incidental, and `postgres-sink.test.ts` pins WHY: binding a raw `Date` into a
 * naive `timestamp` stores the PROCESS-LOCAL wall clock (measured, one instant
 * stored `13:45` under `TZ=UTC` and `22:45` under `TZ=Asia/Tokyo`), where the
 * ISO string the coercion produces stores the same text under every zone. The
 * shared coercion is what makes this sink zone-honest; the pin is what stops a
 * later "optimisation" handing the `Date` straight through.
 */
function bindValue(value: SinkValue | undefined, column: string): SinkValue {
  if (value === undefined) {
    throw new DatasetIoError(
      'permanent',
      `no value was supplied for the sink column '${column}' (an absent value is refused, never written as NULL)`,
    );
  }
  return value;
}

/** An Upsert's prepared state: its keys, and the statements every chunk runs. */
interface PostgresUpsert {
  readonly keys: readonly SinkColumn[];
  readonly stageInsert: string;
  readonly update: string | null;
  readonly insert: string;
}

/**
 * #1600 OR41 C3a — set up an Upsert: resolve its keys, create the staging table
 * and build the statements each chunk runs (`upsertChunk`).
 *
 * The stage is `CREATE TEMP TABLE … AS SELECT <mapped columns> FROM <target>
 * WITH NO DATA`, so its columns have the target's types and a bound value
 * coerces exactly as a plain insert's does. It is session-private and
 * `ON COMMIT DROP`; a rollback drops it too. It needs the TEMP privilege on the
 * database and SELECT on the target, as the match below does.
 *
 * Why a stage, and not the alternatives:
 * - `INSERT … ON CONFLICT` needs a unique index matching the keys exactly, and
 *   Key columns need not have one.
 * - `MERGE` refuses a target with rules, which this sink otherwise writes to
 *   (`fillsNulls`), and needs postgres 15.
 * Both also fail when one statement meets a key twice, so the source still has
 * to be reduced to one row per key: `DISTINCT ON` over the stage, the last row
 * winning by `studio_copy_ord`. A later chunk sees an earlier chunk's writes, so
 * the last row wins across chunks too.
 */
async function stageUpsert(
  client: PostgresClient,
  writeTarget: string,
  columns: readonly SinkColumn[],
  table: UpsertKeyTarget,
): Promise<PostgresUpsert> {
  const keys = resolveUpsertKeys({ ...table, mapped: columns });
  if (columns.some((c) => c.actual === UPSERT_ORDER_COLUMN)) {
    throw new DatasetIoError(
      'permanent',
      `Upsert stages rows with a column named '${UPSERT_ORDER_COLUMN}', which this mapping also writes`,
    );
  }
  const q = (c: SinkColumn): string => quoteIdentifier(c.actual, 'column');
  const columnList = columns.map(q).join(', ');
  const order = quoteIdentifier(UPSERT_ORDER_COLUMN, 'column');
  await client.query(
    `CREATE TEMP TABLE ${quoteIdentifier(UPSERT_STAGE_NAME, 'table')} ON COMMIT DROP AS ` +
      `SELECT ${columnList}, 0::bigint AS ${order} FROM ${writeTarget} WITH NO DATA`,
  );
  const keyList = keys.map(q).join(', ');
  const latest =
    `(SELECT DISTINCT ON (${keyList}) * FROM ${UPSERT_STAGE} ` +
    `ORDER BY ${keyList}, ${order} DESC) AS d`;
  const match = keys.map((k) => `t.${q(k)} = d.${q(k)}`).join(' AND ');
  const nonKeys = columns.filter((c) => !keys.includes(c));
  return {
    keys,
    stageInsert: `INSERT INTO ${UPSERT_STAGE} (${columnList}, ${order}) VALUES `,
    // Every mapped column a key: an existing row has nothing to update.
    update:
      nonKeys.length === 0
        ? null
        : `UPDATE ${writeTarget} AS t SET ${nonKeys.map((c) => `${q(c)} = d.${q(c)}`).join(', ')} ` +
          `FROM ${latest} WHERE ${match}`,
    insert:
      `INSERT INTO ${writeTarget} (${columnList}) ` +
      `SELECT ${columns.map((c) => `d.${q(c)}`).join(', ')} FROM ${latest} ` +
      `WHERE NOT EXISTS (SELECT 1 FROM ${writeTarget} AS t WHERE ${match})`,
  };
}

/**
 * Upsert one chunk: stage it, update the rows its keys match, insert the rest.
 * Returns the store's own count of rows updated plus rows inserted (#1270), so
 * a non-unique key counts every row it updated. A key repeated within one chunk
 * counts once (only its last row is applied); one repeated in a later chunk
 * counts again there, as the update of the row the earlier chunk wrote.
 */
async function upsertChunk(
  client: PostgresClient,
  upsert: PostgresUpsert,
  tuples: readonly string[],
  values: readonly SinkValue[],
  spelled: string,
): Promise<number> {
  // TRUNCATE, not DELETE: the stage is this session's alone, and a DELETE per
  // chunk would leave every earlier chunk's dead rows in it until COMMIT.
  await client.query(`TRUNCATE ${UPSERT_STAGE}`);
  await client.query(`${upsert.stageInsert}${tuples.join(', ')}`, [...values]);
  let written = 0;
  for (const statement of upsert.update === null
    ? [upsert.insert]
    : [upsert.update, upsert.insert]) {
    const result = await client.query(statement);
    if (typeof result.rowCount !== 'number') {
      throw new DatasetIoError(
        'permanent',
        `the store did not report a row count for the Upsert into '${spelled}'`,
      );
    }
    written += result.rowCount;
  }
  return written;
}

/**
 * #1600 OR41 C3b — run a copy's Pre-copy script on the open write transaction:
 * the allow-list (`PRE_COPY_SCRIPT_STATEMENTS`), then `:name` rewritten to `$n`
 * as the reader does, over the extended protocol so the server runs one
 * statement only.
 */
async function runPostgresPreCopyScript(
  client: PostgresClient,
  script: PreCopyScript,
  secret: string | null,
): Promise<void> {
  const refusal = preCopyScriptRefusal(script, 'postgres');
  if (refusal !== null) throw new DatasetIoError('permanent', refusal);
  const statement = rewriteNamedParametersToPositional(script.sql, script.parameters);
  try {
    await client.query({ text: statement.sql, values: statement.values, queryMode: 'extended' });
  } catch (err) {
    throw readFailure(err, 'the Pre-copy script failed', secret, 'write');
  }
}

/** Whether `qualified` names a relation, resolved exactly as the LOCK and the
 * describe resolve it (`to_regclass`, by `search_path` when unqualified). */
const RELATION_EXISTS_SQL = 'select to_regclass($1) is not null as "exists"';

/** How often a copy waiting on another copy's Auto-create tries the lock again. */
const AUTO_CREATE_LOCK_POLL_MS = 100;

/**
 * #1600 OR41 C3c — Auto-create from mapping: create the sink table when it does
 * not exist, inside the copy's transaction, so a failed copy undoes it.
 *
 * NOT `CREATE TABLE IF NOT EXISTS`. For an unqualified name that checks only
 * the schema the table would be created in (the first in `search_path`), so
 * with `search_path = s_b, public` and an existing `public.t` it would create
 * `s_b.t`, and the copy would write into a new empty table instead of the one
 * the name resolved to. The check here is `to_regclass`, the same resolution
 * the LOCK and the describe use.
 *
 * Two copies auto-creating one table at once would both see it missing, and
 * the second CREATE would fail on the first's catalog row. So a missing table
 * is re-checked under a transaction-scoped advisory lock, held to COMMIT: the
 * second copy waits there, then finds the table. The key is the RESOLVED
 * `schema.table` (`autoCreateLockKey`; an unqualified name's schema is
 * `current_schema()`, where CREATE puts it), so `t` and `public.t` share one.
 * The wait polls `pg_try_advisory_xact_lock` rather than blocking, so a cancel
 * or the activity timeout ends it, where a blocking wait would hold until the
 * other copy commits. A table that already exists takes no lock, so copies into
 * it run as they would without Auto-create.
 */
async function autoCreatePostgresTable(
  client: PostgresClient,
  target: { readonly schema?: string; readonly table: string },
  qualified: string,
  columns: readonly AutoCreateColumn[],
  signal: AbortSignal | undefined,
): Promise<void> {
  // Built first, so a refusal (a case collision, a name over 63 characters)
  // runs no statement.
  const ddl = autoCreateTableSql(
    'postgres',
    {
      qualified,
      names: target.schema === undefined ? [target.table] : [target.schema, target.table],
    },
    columns,
  );
  const exists = async (): Promise<boolean> =>
    (
      (await client.query(RELATION_EXISTS_SQL, [qualified])).rows[0] as
        { exists?: unknown } | undefined
    )?.exists === true;
  if (await exists()) return;
  // `null` when no `search_path` schema exists; the CREATE then fails with the
  // server's own words, so the key only has to be stable.
  const schema =
    target.schema ??
    String(
      (
        (await client.query('select current_schema() as "schema"')).rows[0] as
          { schema?: unknown } | undefined
      )?.schema ?? '',
    );
  const key = autoCreateLockKey(schema, target.table);
  for (;;) {
    const locked = (
      (await client.query('select pg_try_advisory_xact_lock($1::bigint) as "locked"', [key]))
        .rows[0] as { locked?: unknown } | undefined
    )?.locked;
    if (locked === true) break;
    if (signal?.aborted) throw new DatasetIoError('cancelled', 'dataset write aborted');
    await sleep(AUTO_CREATE_LOCK_POLL_MS);
  }
  if (await exists()) return;
  await client.query(ddl);
}

/**
 * Write batches of mapped rows into a `table` dataset on a `postgres` store.
 *
 * **ONE transaction, committed once (§4.1)** — `BEGIN` … inserts … `COMMIT`,
 * with a `ROLLBACK` on every failure path including cancel, so the sink reports
 * `partialWritePossible: false` and §4's retry-from-row-0 is safe. Postgres is
 * strictly better placed to promise this than sqlite: if the SESSION dies
 * mid-copy the server unwinds the transaction itself, so there is no
 * equivalent of the "the rollback itself failed" state — but the branch is kept
 * anyway, because a `ROLLBACK` that raises is a state this code cannot prove
 * clean, and inventing the proof is the fail-open direction §4.2 forbids.
 *
 * **The LOCK comes before the §7 gate reads, and its STRENGTH depends on the
 * mode** (`LOCK_MODES` holds all four; this paragraph explains the first two).
 * Every mode takes a lock that conflicts with `ACCESS EXCLUSIVE`, so a
 * concurrent `ALTER TABLE` cannot change the table between being described and
 * being written — the TOCTOU sqlite closes with `begin immediate`. But
 * `overwrite` takes `EXCLUSIVE` rather than `ROW EXCLUSIVE`, and that asymmetry
 * is deliberate. `ROW EXCLUSIVE` is the lock an ordinary INSERT already holds,
 * so it does not exclude a second copy; two concurrent `overwrite` copies into
 * one table would each DELETE, then each INSERT, and the table would end up
 * holding the UNION of both — neither operator's copy, and no error. §9's
 * `COPY_CONCURRENCY` makes that reachable. `EXCLUSIVE` serialises them, which is
 * the guarantee sqlite gets for free from its single writer. `append` keeps the
 * weaker lock: two appends interleaving is exactly what append means, and
 * taking `EXCLUSIVE` there would block the operator's own application writes for
 * the duration of a long copy for no correctness gain.
 *
 * **`overwrite` deletes inside the transaction**, so a failure restores the rows
 * it was replacing and a zero-row source legitimately empties the table.
 * `DELETE` rather than `TRUNCATE`, for two reasons beyond matching sqlite:
 * `TRUNCATE` needs `ACCESS EXCLUSIVE` (it would block readers as well as
 * writers), and it REFUSES outright on a table another table references by
 * foreign key unless given `CASCADE` — where `DELETE` honours the operator's own
 * `ON DELETE` rules, which is their declared intent. The cost is that a large
 * overwrite is a row-by-row delete; that bound is #1126's, already filed against
 * the sqlite sink for the same reason.
 *
 * **`truncate` and `upsert` (C3a) are the operator's explicit choices.**
 * Truncate then insert is the TRUNCATE the paragraph above avoids for
 * Overwrite, with all of its costs, named in the field's help: it needs the
 * TRUNCATE privilege, fires no delete triggers, refuses a referenced table and
 * holds `ACCESS EXCLUSIVE` until the copy commits. Upsert is `stageUpsert`'s.
 * `LOCK_MODES` holds each behaviour's lock and why.
 */
export async function writePostgresDatasetRows(
  write: PostgresDatasetWrite,
  batches: AsyncIterable<readonly Record<string, SinkValue>[]>,
): Promise<{ readonly rowsWritten: number }> {
  if (write.columns.length === 0) {
    throw new DatasetIoError('permanent', 'a copy sink needs at least one mapped column');
  }

  // §8: the stored connection is not assumed well-formed — `routes/connections.ts`
  // runs no per-kind validation on write, so any shape is storable. `openSession`
  // parses it again for its own purposes; this parse exists for the gate below,
  // which must run before anything is opened.
  const cfg = postgresConnectionConfigSchema.safeParse(write.connectionConfig);
  if (!cfg.success) {
    throw new DatasetIoError(
      'permanent',
      `invalid postgres connection config: ${formatZodIssues(cfg.error.issues)}`,
    );
  }

  // THE `writable` GATE. Fail-closed, as the config field's own docstring
  // promises: absent means "nobody declared this store writable", which withholds
  // a permission rather than granting one. `writable` is in
  // `CONNECTION_NON_OVERRIDABLE_CONFIG_KEYS`, so no dispatch-time parameter can
  // turn a read-only store into a sink.
  if (cfg.data.writable !== true) {
    throw new DatasetIoError(
      'permanent',
      'this postgres connection is not marked `writable`, so it cannot be a copy sink',
    );
  }

  const target = sinkTargetFor(write.datasetKind, write.datasetConfig);
  const qualified = qualifiedTable(target);
  const spelled = target.schema === undefined ? target.table : `${target.schema}.${target.table}`;

  if (!(COPY_WRITE_MODES as readonly string[]).includes(write.mode)) {
    // `mode` is typed, so this is unreachable from in-repo callers — but an
    // unrecognised value silently behaving like `append` is the wrong failure
    // mode for the field that decides whether the operator's existing rows
    // survive. `sqlite-sink.ts` states the same reason.
    throw new DatasetIoError('permanent', `unknown copy write mode '${String(write.mode)}'`);
  }

  if (write.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset write aborted');

  const client = await openSession(
    write.createClient,
    write.connectionConfig,
    write.secret,
    'cannot reach the postgres server to write the sink',
  );

  try {
    let rowsWritten = 0;
    let inTransaction = false;
    try {
      await client.query('BEGIN');
      inTransaction = true;

      // #1600 OR41 C3c — BEFORE the write behaviour's LOCK, which needs the
      // table, and so before the Pre-copy script, which may alter it. This is
      // what lets a PostgreSQL sink table be created at all: a script cannot,
      // because the LOCK comes first.
      if (write.autoCreate != null) {
        await autoCreatePostgresTable(client, target, qualified, write.autoCreate, write.signal);
        if (write.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset write aborted');
      }

      try {
        await client.query(`LOCK TABLE ${qualified} IN ${LOCK_MODES[write.mode]} MODE`);
      } catch (err) {
        // `42P01` is postgres saying the relation does not exist. Reported in
        // this module's own words, so a missing sink table reads identically
        // whichever store it was — the sqlite sink says the same sentence.
        if ((err as { code?: unknown } | null)?.code === '42P01') {
          throw new DatasetIoError('permanent', `there is no table '${spelled}' in the store`);
        }
        throw err;
      }

      // #1600 OR41 C3b — AFTER the write behaviour's lock, so the copy holds it
      // before the script runs. A script that needs a STRONGER lock on the sink
      // (ALTER, DROP or TRUNCATE in Append, Overwrite or Upsert) upgrades it
      // inside this transaction, so two such copies at once can deadlock: postgres
      // ends one with `40P01`, which is transient and retried. BEFORE the
      // describe, so a script that alters the table is described as it now is.
      // Inside the transaction, so a failed copy undoes it.
      if (write.preCopyScript != null) {
        await runPostgresPreCopyScript(client, write.preCopyScript, write.secret);
        if (write.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset write aborted');
      }

      const described = await describeSinkTable(client, qualified, spelled);
      // Resolved against EVERY actual column, not just the writable ones. A
      // mapping naming a generated column must be told THAT — "the sink has no
      // column named 'gen'" would send an operator looking for a column that is
      // right there.
      const columns = resolveSinkColumns(
        write.columns,
        described.columns.map((c) => c.name),
      );
      refuseUnwritableColumns(columns, described.columns);
      // #1162 — the store's own NOT NULL, before the overwrite's DELETE and the
      // first row: the rule the dispatch rung runs against the dataset's
      // declaration, now against the real schema. `(tgtype & 7) = 7` above is
      // ROW | BEFORE | INSERT.
      const nullRefusal = refuseNullOnNonNullable(write.nullOnError, {
        kind: 'store',
        resolved: columns,
        notNullActual: described.fillsNulls
          ? new Set()
          : new Set(described.columns.filter((c) => c.notNull).map((c) => c.name)),
      });
      if (nullRefusal !== null) throw new DatasetIoError('permanent', nullRefusal);

      // The store's own spelling from here on, so the statement reads like the
      // schema — `describeSinkTable` resolved which relation this is, so the
      // write names it by resolved schema rather than re-running `search_path`.
      const writeTarget = qualifiedTable({ schema: described.schema, table: described.name });

      if (write.mode === 'overwrite') {
        await client.query(`DELETE FROM ${writeTarget}`);
      } else if (write.mode === 'truncate') {
        try {
          await client.query(`TRUNCATE ${writeTarget}`);
        } catch (err) {
          // `0A000` is how postgres refuses to TRUNCATE a table a foreign key
          // references (and a foreign table whose wrapper cannot). Its own
          // message names which; the hint is what to do about it.
          if ((err as { code?: unknown } | null)?.code === '0A000') {
            throw readFailure(
              err,
              `Truncate then insert could not empty '${spelled}' (Overwrite deletes the rows instead)`,
              write.secret,
              'write',
            );
          }
          throw err;
        }
      }

      const columnList = columns.map((c) => quoteIdentifier(c.actual, 'column')).join(', ');
      const upsert =
        write.mode === 'upsert'
          ? await stageUpsert(client, writeTarget, columns, {
              keyColumns: write.keyColumns ?? [],
              tableColumns: described.columns.map((c) => c.name),
              primaryKey: described.primaryKey,
              table: spelled,
            })
          : null;
      // Upsert binds one more value per row: its order in the source.
      const width = columns.length + (upsert === null ? 0 : 1);
      const rowsPerStatement = Math.max(1, Math.floor(MAX_BIND_PARAMETERS / width));

      let first = true;
      let pending: SinkValue[] = [];
      let pendingRows = 0;
      let rowNumber = 0;

      const flush = async (): Promise<void> => {
        if (pendingRows === 0) return;
        const tuples: string[] = [];
        let n = 1;
        for (let i = 0; i < pendingRows; i += 1) {
          tuples.push(`(${Array.from({ length: width }, () => `$${n++}`).join(', ')})`);
        }
        if (upsert !== null) {
          rowsWritten += await upsertChunk(client, upsert, tuples, pending, spelled);
          pending = [];
          pendingRows = 0;
          write.onBatch?.(rowsWritten);
          return;
        }
        const inserted = await client.query(
          `INSERT INTO ${writeTarget} (${columnList}) VALUES ${tuples.join(', ')}`,
          pending,
        );
        // #1270 — the store's own count of what LANDED, not the tuples sent. A
        // BEFORE trigger returning NULL skips its row; a `DO INSTEAD` rule
        // reports its own last INSERT's count (zero for `DO INSTEAD NOTHING`,
        // postgres §41.6) — so under a redirecting rule this counts the rows
        // placed in the rule's target. No count at all is refused rather than
        // guessed: the guess is exactly the overstatement this replaced, and
        // throwing here, inside the transaction, rolls the copy back.
        if (typeof inserted.rowCount !== 'number') {
          throw new DatasetIoError(
            'permanent',
            `the store did not report a row count for the INSERT into '${spelled}'`,
          );
        }
        rowsWritten += inserted.rowCount;
        pending = [];
        pendingRows = 0;
        write.onBatch?.(rowsWritten);
      };

      for await (const batch of batches) {
        // Cancellation and the yield are BOTH at the batch boundary (§9, §10).
        if (!first) await yieldToEventLoop();
        if (write.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset write aborted');
        first = false;

        for (const row of batch) {
          rowNumber += 1;
          if (upsert !== null) refuseNullKey(row, upsert.keys, rowNumber);
          for (const column of columns) pending.push(bindValue(row[column.mapped], column.mapped));
          if (upsert !== null) pending.push(rowNumber);
          pendingRows += 1;
          // Chunked on the PARAMETER ceiling, not on the pump's batch size —
          // see `MAX_BIND_PARAMETERS` for what exceeding it actually does.
          if (pendingRows >= rowsPerStatement) await flush();
        }
        await flush();
      }
      await flush();

      if (write.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset write aborted');
      await client.query('COMMIT');
      inTransaction = false;
    } catch (err) {
      const failure =
        err instanceof DatasetIoError
          ? err
          : readFailure(err, `the copy into '${spelled}' failed`, write.secret, 'write');
      // Only NOW can the honest answer to "did anything land?" be given. A
      // blanket swallowed rollback would report `partialWritePossible: false`
      // unconditionally — fail-open in the one place §4.2 exists.
      let unwound = true;
      if (inTransaction) {
        try {
          await client.query('ROLLBACK');
        } catch {
          unwound = false;
        }
      }
      if (unwound) throw failure;
      // §4.2 APPLIED, not merely reported: `retryEligible` reads only `kind`, so
      // a transient failure whose rollback also failed would be retried from row
      // 0 into a table that may already hold some of these rows. The fact and
      // the verdict travel together.
      throw new DatasetIoError(
        classifySinkFailure({ kind: failure.kind, partialWritePossible: true }),
        `${failure.message} - and the rollback FAILED, so rows may have landed in '${spelled}'`,
        { cause: err, partialWritePossible: true },
      );
    }
    return { rowsWritten };
  } finally {
    try {
      // Measured on the reader's path: ending a client with an open transaction
      // discards it server-side, so this is also the backstop for a throw that
      // escaped the handler above.
      await client.end();
    } catch {
      // Never let a close failure replace the outcome the caller is unwinding with.
    }
  }
}
