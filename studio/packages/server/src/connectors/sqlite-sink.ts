import Database from 'better-sqlite3';
import {
  formatZodIssues,
  nocaseFold,
  type CoercedValue,
  type DatasetKind,
} from '@autonomy-studio/shared';
import { SQLITE_BUSY_TIMEOUT_MS } from '../limits.js';
import { DatasetIoError } from './dataset-io-error.js';
import { classifySinkFailure } from './error-kind.js';
import { yieldToEventLoop } from './scheduling.js';
import { quoteIdentifier } from './sql-identifier.js';
import {
  confineStorePath,
  parseTableTarget,
  quoteStoreIdentifier,
  sqliteConnectionConfigSchema,
  storeFailure,
  type SqliteValue,
} from './sqlite-store.js';

/**
 * #1196 M10 slice 3a — the sqlite SINK, moved out of `sqlite.ts` whole.
 *
 * Nothing here changed: this is §4's atomic sink exactly as M5 slice 2 built it.
 * It moved because slice 3a gives `copy` a SECOND sink, and the two writers have
 * to be reachable from one dispatcher every source adapter imports
 * (`copy-sink.ts`). Left in `sqlite.ts`, that dispatcher would import the
 * adapter that imports it. `sqlite-store.ts` holds the primitives this file and
 * the reader both need, so neither has to import the other.
 */

/**
 * One value a sink may bind.
 *
 * `CoercedValue` (slice 1) is the vocabulary the coercion matrix produces, and
 * taking it rather than `unknown` is what stops this file writing casts — "a
 * cast that claims a type its value is outside of is the failure no type error
 * catches" (`datamove/coerce.ts`). It is widened by exactly one member:
 * `Uint8Array`, because the M4 reader hands BLOBs back as `Buffer` (a
 * `Uint8Array`) and a BLOB→BLOB copy must not be silently unsupported. The
 * widening is written down here rather than left implicit at the call site.
 *
 * AMENDED by slice 3 (#1129), because that last sentence now overstates what
 * the product can do: `DataTypeSchema` has no binary member, so `coerceValue`
 * fails every `Uint8Array` against every declared target and no BLOB can reach
 * this sink THROUGH A COPY. The member stays — a direct caller may bind one, and
 * removing it would put the cast back — but the capability is filed as #1131
 * rather than implied by a type.
 */
export type SinkValue = CoercedValue | Uint8Array;

/** `append` adds to what is there; `overwrite` replaces the table's contents. */
export type SqliteWriteMode = 'append' | 'overwrite';

/** What one dataset write needs to know. */
export interface SqliteDatasetWrite {
  /** The `sqlite` connection's stored config — RE-PARSED here, never trusted. */
  readonly connectionConfig: Record<string, unknown>;
  readonly datasetKind: DatasetKind;
  readonly datasetConfig: Record<string, unknown>;
  /** The sink columns this copy writes, matched case-insensitively (§7). */
  readonly columns: readonly string[];
  readonly mode: SqliteWriteMode;
  /** Honoured at BATCH BOUNDARIES (§10) — a run cancel rolls the copy back. */
  readonly signal?: AbortSignal;
  /**
   * §5's progress channel: the RUNNING TOTAL after each batch is inserted into
   * the OPEN transaction. Per batch, never per row — one event per row is the
   * log-volume problem §5 forbids. It exists now rather than at slice 3 because
   * a `Promise<{rowsWritten}>` gives the pump nothing to tick from until the
   * write has already finished, and adding it later would change a shipped
   * signature.
   *
   * **A tick is progress, not committed truth**, and the pump must not present
   * it as the latter: these rows sit in an uncommitted transaction, so a later
   * failure rolls every ticked row back. An operator can legitimately see
   * "500 rows" moments before the copy reports that it wrote none.
   */
  readonly onBatch?: (rowsWritten: number) => void;
}

/** What a completed write reports. */
export interface SqliteWriteResult {
  readonly rowsWritten: number;
}

/**
 * Bind one value, converting only where better-sqlite3 cannot take the value as
 * it stands.
 *
 * The boolean arm is load-bearing and measured, not defensive: on 12.11.1,
 * `run(true)` THROWS — "SQLite3 can only bind numbers, strings, bigints,
 * buffers, and null" — while `CoercedValue` includes `boolean`, so EVERY
 * `boolean`-typed mapping column would fail at bind time without it. 1/0 is
 * SQLite's own boolean representation.
 *
 * `undefined` is REFUSED rather than bound. Measured: better-sqlite3 accepts it
 * and stores NULL, which would turn a mapping row whose value never arrived into
 * a silent null in the operator's data — the shape of failure this codebase
 * refuses elsewhere as "an absent fact must never be manufactured".
 */
function bindValue(value: SinkValue | undefined, column: string): SqliteValue {
  if (value === undefined) {
    throw new DatasetIoError(
      'permanent',
      `no value was supplied for the sink column '${column}' (an absent value is refused, never written as NULL)`,
    );
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

/**
 * The sink table's ACTUAL column spellings, or why it cannot be a sink.
 *
 * Two measured reasons this is not "`pragma_table_info` returned rows":
 *  - a **VIEW** reports its columns through `pragma_table_info` exactly as a
 *    table does, so an emptiness check passes for one — and the real refusal
 *    ("cannot modify v because it is a view") then fires INSIDE the transaction,
 *    in `overwrite` mode after `DELETE FROM v` was already attempted. §7 requires
 *    the gate before the first row moves, so the type comes from `sqlite_master`;
 *  - a GENERATED column is absent from `table_info` (it is in `table_xinfo` with
 *    `hidden=2`) and refuses an INSERT with "cannot INSERT into generated
 *    column". Mapping one is therefore reported as "absent from the sink", which
 *    is imprecise but never wrong about the outcome. Named here so M6 does not
 *    rediscover it.
 *
 * Returns a discriminated result rather than an empty array, so "no such table",
 * "it is a view" and "here are the columns" are three answers and not one
 * overloaded one.
 */
function describeSinkTable(
  db: Database.Database,
  schemaName: string,
  table: string,
): { ok: true; name: string; columns: string[] } | { ok: false; reason: string } {
  const qualifiedSchema = quoteIdentifier(schemaName, 'schema');
  // `COLLATE NOCASE`, for the same reason `resolveSinkColumns` lower-cases:
  // SQLite resolves identifiers case-insensitively, so `SELECT * FROM "SINK"`
  // finds a table created as `sink` — but `sqlite_master.name` compares with
  // BINARY collation, so an exact match would refuse a dataset SQLite would
  // happily have executed. Getting this right for columns and wrong for the
  // table would have been one bug in two spellings. At most one row can come
  // back: SQLite refuses to create `SINK` alongside `sink`.
  const found = db
    .prepare(
      `SELECT name, type FROM ${qualifiedSchema}.sqlite_master WHERE name = ? COLLATE NOCASE`,
    )
    .get(table) as { name: string; type?: unknown } | undefined;
  if (found === undefined) {
    return { ok: false, reason: `there is no table '${table}' in the store` };
  }
  if (found.type !== 'table') {
    return {
      ok: false,
      reason: `'${table}' is a ${String(found.type)}, not a table, so it cannot be written to`,
    };
  }
  // The store's own spelling from here on, so the statement reads like the schema.
  const columns = db
    .prepare('SELECT name FROM pragma_table_info(?, ?)')
    .all(found.name, schemaName) as { name: string }[];
  return { ok: true, name: found.name, columns: columns.map((c) => c.name) };
}

/**
 * Resolve each mapped column onto the store's own spelling of it, CASE-INSENSITIVELY.
 *
 * SQLite matches column names without regard to case — measured: `INSERT INTO
 * "t" ("ID")` succeeds against a column declared `id` — and §6.3's auto-map is
 * itself "case-insensitive, trimmed", so the authoring surface generates exactly
 * this input. §7's refusal is for a column that is ABSENT, and a case variant is
 * not absent; an exact-string match would `permanent`-refuse a mapping SQLite
 * would have executed.
 *
 * BOTH spellings are kept, and that is not tidiness. The store's spelling goes
 * into the statement, so the SQL reads the way the schema does; the MAPPED
 * spelling is what the incoming rows are keyed by, because the pump keys a row
 * by the mapping's `sink` name and has never seen the store. Collapsing the two
 * makes a case-differing mapping bind `undefined` for every row.
 *
 * Two mapped columns collapsing onto one actual column is REFUSED: it is silent
 * last-wins into the operator's table, the same defect `CopyMappingSchema`'s
 * duplicate-sink rule exists for, and one that rule cannot see because the two
 * names differ as strings.
 */
interface SinkColumn {
  /** The key the incoming rows use — the mapping's `sink` name. */
  readonly mapped: string;
  /** The store's own spelling, which is what the statement names. */
  readonly actual: string;
}

function resolveSinkColumns(mapped: readonly string[], actual: readonly string[]): SinkColumn[] {
  /* `nocaseFold`, NOT `toLowerCase()` — #1151. SQLite's NOCASE collation folds
     ASCII `A-Z` only, so `\u212A` (KELVIN SIGN) and `k` are different identifiers
     to the store, while `toLowerCase()` folds one onto the other. Using the JS
     fold here made this resolver claim a column SQLite would never have matched,
     and left the sink and the source-side drift gate — which already shares this
     function — able to disagree about whether two names are the same column. */
  const byFold = new Map<string, string>();
  for (const name of actual) byFold.set(nocaseFold(name), name);

  const resolved: SinkColumn[] = [];
  const claimed = new Map<string, string>();
  const missing: string[] = [];
  const collisions: string[] = [];
  for (const name of mapped) {
    const match = byFold.get(nocaseFold(name));
    if (match === undefined) {
      missing.push(name);
      continue;
    }
    const earlier = claimed.get(match);
    if (earlier !== undefined) {
      collisions.push(`'${earlier}' and '${name}' both resolve to the sink column '${match}'`);
      continue;
    }
    claimed.set(match, name);
    resolved.push({ mapped: name, actual: match });
  }
  // BOTH problems, in ONE refusal. Throwing on the first collision mid-pass
  // reports only whichever defect the array order happened to reach first, so a
  // mapping with two faults takes two runs to diagnose.
  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(`the sink has no column named ${missing.map((m) => `'${m}'`).join(', ')}`);
  }
  if (collisions.length > 0) {
    problems.push(`${collisions.join('; ')} (each sink column may be written by one mapping row)`);
  }
  if (problems.length > 0) throw new DatasetIoError('permanent', problems.join('. '));
  return resolved;
}

/** The `table` dataset config of a SINK, or a refusal. */
function sinkTargetFor(
  datasetKind: DatasetKind,
  datasetConfig: Record<string, unknown>,
): { schema: string; table: string } {
  if (datasetKind === 'query') {
    throw new DatasetIoError(
      'permanent',
      'a `query` dataset is a SELECT and has no insert target, so it cannot be a copy sink',
    );
  }
  if (datasetKind !== 'table') {
    throw new DatasetIoError(
      'permanent',
      `no sink writer exists for the '${datasetKind}' dataset kind yet`,
    );
  }
  // A SQLite "schema" is an ATTACHed database, and this connector attaches
  // nothing — so an unqualified dataset means `main`. A different name reaches
  // `pragma_table_info`, which refuses it with "unknown database". Shared with
  // the address resolver so the gate and the writer cannot disagree about which
  // table a dataset names.
  return parseTableTarget(datasetConfig);
}

/**
 * Write batches of mapped rows into a `table` dataset on a `sqlite` store —
 * §4's atomic sink, and the consumer that finally makes `config.writable` mean
 * something.
 *
 * **ONE transaction, committed once (§4.1).** `BEGIN IMMEDIATE` … inserts …
 * `COMMIT`, with a `ROLLBACK` on every failure path including cancel. That is
 * the SQL equivalent of what `fs.ts`'s `atomicReplace` does for file sinks
 * (temp file + `rename`), and it is what makes a copy safely retryable: §4's
 * measured trap is that `retryEligible` consults only `kind === 'transient'` and
 * never `idempotent`, so a copy that dies at row 500,000 IS retried from row 0.
 * That retry is only safe because this transaction guarantees the first attempt
 * left nothing behind. Consequently the sink reports
 * `partialWritePossible: false`, and §4.2's downgrade does not apply — except in
 * the one case where the rollback itself failed, which is the only state this
 * code cannot prove clean.
 *
 * A staging table was the alternative §4 also allows. It is not used: it means
 * creating a real named object in the operator's database (collision surface, a
 * leaked table if the process dies, and DDL inside a confinement model that has
 * so far executed only SELECT), and it is not even expressible for `append`.
 *
 * **The operational consequence, stated rather than discovered.** The copy holds
 * the store's write lock for its whole duration, so two copies into one store
 * serialise and the loser gets `SQLITE_BUSY` → `transient` → a retry from row 0.
 * `BEGIN IMMEDIATE` front-loads that contention so it is reported before any
 * work is done; it does NOT make the copy immune to a busy `COMMIT`, which is
 * measurable in rollback-journal mode (the default for an operator's database —
 * this sink deliberately does not mutate their `journal_mode`, which would be a
 * persistent side effect on someone else's file).
 *
 * **`overwrite` deletes inside the transaction**, so a failure restores the rows
 * it was replacing and a zero-row source legitimately empties the table. Note
 * that better-sqlite3 enables `foreign_keys` by default, so a `DELETE` from a
 * parent table CASCADEs per the operator's own schema; that is their declared
 * intent and is left alone, but it is not visible in `rowsWritten`.
 *
 * `db.transaction()` is deliberately NOT used: it is synchronous-only, so it
 * cannot span the `await` this function needs between batches (§9's yield).
 * Measured: an explicit `begin`/`commit` pair does span one, and `inTransaction`
 * is still true across it.
 */
export async function writeSqliteDatasetRows(
  write: SqliteDatasetWrite,
  batches: AsyncIterable<readonly Record<string, SinkValue>[]>,
): Promise<SqliteWriteResult> {
  if (write.columns.length === 0) {
    throw new DatasetIoError('permanent', 'a copy sink needs at least one mapped column');
  }

  // §8: the stored connection is not assumed well-formed — `routes/connections.ts`
  // runs no per-kind validation on write, so any shape is storable.
  const cfg = sqliteConnectionConfigSchema.safeParse(write.connectionConfig);
  if (!cfg.success) {
    throw new DatasetIoError(
      'permanent',
      `invalid sqlite connection config: ${formatZodIssues(cfg.error.issues)}`,
    );
  }

  // THE `writable` GATE. Fail-closed, as the config field's own docstring
  // promises: absent means "nobody declared this store writable", which
  // withholds a permission rather than granting one. `writable` is also in
  // `CONNECTION_NON_OVERRIDABLE_CONFIG_KEYS`, so no dispatch-time parameter can
  // turn a read-only store into a sink.
  if (cfg.data.writable !== true) {
    throw new DatasetIoError(
      'permanent',
      'this sqlite connection is not marked `writable`, so it cannot be a copy sink',
    );
  }

  const target = sinkTargetFor(write.datasetKind, write.datasetConfig);
  const dbPath = await confineStorePath(cfg.data.roots, cfg.data.path);

  if (write.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset write aborted');

  let db: Database.Database;
  try {
    db = new Database(dbPath, { fileMustExist: true, timeout: SQLITE_BUSY_TIMEOUT_MS });
  } catch (err) {
    throw storeFailure(err, `cannot open the sqlite database at '${cfg.data.path}'`);
  }

  try {
    let rowsWritten = 0;
    try {
      // The lock comes BEFORE the pre-flight so the §7 gate cannot be read
      // through a snapshot another writer then changes: a concurrent
      // `ALTER TABLE` between describing the sink and the first insert would be
      // a live TOCTOU on exactly the check that exists to prevent it.
      db.exec('begin immediate');

      const described = describeSinkTable(db, target.schema, target.table);
      if (!described.ok) throw new DatasetIoError('permanent', described.reason);
      const columns = resolveSinkColumns(write.columns, described.columns);

      const qualified =
        target.schema === 'main'
          ? quoteIdentifier(described.name, 'table')
          : `${quoteIdentifier(target.schema, 'schema')}.${quoteIdentifier(described.name, 'table')}`;

      if (write.mode !== 'append' && write.mode !== 'overwrite') {
        // `mode` is typed, so this is unreachable from in-repo callers — but an
        // unrecognised value silently behaving like `append` is the wrong
        // failure mode for the field that decides whether the operator's
        // existing rows survive.
        throw new DatasetIoError('permanent', `unknown copy write mode '${String(write.mode)}'`);
      }
      if (write.mode === 'overwrite') {
        // Inside the transaction, so a later failure restores these rows.
        //
        // ONE unbatched statement, and its bound is worth stating: SQLite's
        // truncate optimisation makes this cheap on a plain table (measured,
        // 2,000,000 rows in 27ms), but better-sqlite3 enables `foreign_keys` by
        // default and that optimisation is disabled once the sink is an FK
        // parent (measured, ~198ms per 1,000,000 rows, scaling with row count
        // rather than with batch size). That is a synchronous block, so on a
        // large enough FK-parent table it becomes the §9 event-loop stall the
        // rest of this file is careful about. Batching it wants a rowid cursor,
        // which is wrong for a WITHOUT ROWID table — so it is filed rather than
        // bodged: #1126.
        db.prepare(`DELETE FROM ${qualified}`).run();
      }

      const insert = db.prepare(
        `INSERT INTO ${qualified} (${columns.map((c) => quoteStoreIdentifier(c.actual)).join(', ')})` +
          ` VALUES (${columns.map(() => '?').join(', ')})`,
      );

      let first = true;
      for await (const batch of batches) {
        // Cancellation and the yield are BOTH at the batch boundary (§9, §10).
        if (!first) await yieldToEventLoop();
        if (write.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset write aborted');
        first = false;

        for (const row of batch) {
          insert.run(columns.map((column) => bindValue(row[column.mapped], column.mapped)));
          rowsWritten += 1;
        }
        write.onBatch?.(rowsWritten);
      }

      if (write.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset write aborted');
      db.exec('commit');
    } catch (err) {
      const failure = storeFailure(err, `the copy into '${target.table}' failed`);
      // Only NOW can the honest answer to "did anything land?" be given. A
      // blanket swallowed rollback would report `partialWritePossible: false`
      // unconditionally — fail-open in the one place §4.2 exists.
      let unwound = true;
      if (db.inTransaction) {
        try {
          db.exec('rollback');
        } catch {
          unwound = false;
        }
      }
      if (unwound) throw failure;
      // §4.2 is APPLIED here, not merely reported. Carrying `transient` out
      // alongside `partialWritePossible: true` would be the fail-open this whole
      // section exists to prevent: `retryEligible` reads only `kind`, so a
      // `SQLITE_BUSY` whose rollback also failed would be retried from row 0
      // into a table that may already hold some of these rows. The fact and the
      // verdict travel together, and the caller does not have to remember to
      // combine them.
      throw new DatasetIoError(
        classifySinkFailure({ kind: failure.kind, partialWritePossible: true }),
        `${failure.message} — and the rollback FAILED, so rows may have landed in '${target.table}'`,
        { cause: err, partialWritePossible: true },
      );
    }
    return { rowsWritten };
  } finally {
    try {
      // Measured: `close()` with an open transaction rolls it back, so this is
      // also the backstop for a throw that escaped the handler above.
      db.close();
    } catch {
      // Never let a close failure replace the outcome the caller is unwinding with.
    }
  }
}
