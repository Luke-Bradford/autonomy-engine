import {
  datasetConfigSchema,
  formatZodIssues,
  postgresConnectionConfigSchema,
  tableDatasetConfigSchema,
  type DatasetKind,
} from '@autonomy-studio/shared';
import { DatasetIoError } from './dataset-io-error.js';
import { classifySinkFailure } from './error-kind.js';
import { yieldToEventLoop } from './scheduling.js';
import { quoteIdentifier } from './sql-identifier.js';
import { resolveSinkColumns, type SinkColumn } from './sink-columns.js';
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
  readonly mode: 'append' | 'overwrite';
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
}

interface DescribedSinkTable {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly SinkTableColumn[];
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
                    'identityAlways', a.attidentity = 'a')
                  order by a.attnum)
             from pg_attribute a
            where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
         ), '[]'::json) as columns
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
    { schema: string; name: string; relkind: string; columns: SinkTableColumn[] } | undefined;
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
  return { schema: row.schema, name: row.name, columns: row.columns };
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
 * mode.** Both modes take a lock that conflicts with `ACCESS EXCLUSIVE`, so a
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
  const lockMode = write.mode === 'overwrite' ? 'EXCLUSIVE' : 'ROW EXCLUSIVE';

  if (write.mode !== 'append' && write.mode !== 'overwrite') {
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

      try {
        await client.query(`LOCK TABLE ${qualified} IN ${lockMode} MODE`);
      } catch (err) {
        // `42P01` is postgres saying the relation does not exist. Reported in
        // this module's own words, so a missing sink table reads identically
        // whichever store it was — the sqlite sink says the same sentence.
        if ((err as { code?: unknown } | null)?.code === '42P01') {
          throw new DatasetIoError('permanent', `there is no table '${spelled}' in the store`);
        }
        throw err;
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

      // The store's own spelling from here on, so the statement reads like the
      // schema — `describeSinkTable` resolved which relation this is, so the
      // write names it by resolved schema rather than re-running `search_path`.
      const writeTarget = qualifiedTable({ schema: described.schema, table: described.name });

      if (write.mode === 'overwrite') {
        await client.query(`DELETE FROM ${writeTarget}`);
      }

      const columnList = columns.map((c) => quoteIdentifier(c.actual, 'column')).join(', ');
      const rowsPerStatement = Math.max(1, Math.floor(MAX_BIND_PARAMETERS / columns.length));

      let first = true;
      let pending: SinkValue[] = [];
      let pendingRows = 0;

      const flush = async (): Promise<void> => {
        if (pendingRows === 0) return;
        const tuples: string[] = [];
        let n = 1;
        for (let i = 0; i < pendingRows; i += 1) {
          tuples.push(`(${columns.map(() => `$${n++}`).join(', ')})`);
        }
        await client.query(
          `INSERT INTO ${writeTarget} (${columnList}) VALUES ${tuples.join(', ')}`,
          pending,
        );
        rowsWritten += pendingRows;
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
          for (const column of columns) pending.push(bindValue(row[column.mapped], column.mapped));
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
          : readFailure(err, `the copy into '${spelled}' failed`, write.secret);
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
