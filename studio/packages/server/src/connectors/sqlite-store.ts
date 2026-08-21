import { isAbsolute } from 'node:path';
import {
  formatZodIssues,
  sqliteConnectionConfigSchema as sharedSqliteConnectionConfigSchema,
  tableDatasetConfigSchema,
  type DatasetKind,
} from '@autonomy-studio/shared';
import { DatasetIoError } from './dataset-io-error.js';
import { doubleQuoted } from './sql-identifier.js';
import { resolveWithinRoots } from './confine.js';
import type { ConnectorErrorKind } from './types.js';

/**
 * #1196 M10 slice 3a — the sqlite STORE leaf: what it takes to name, reach and
 * classify a sqlite store, with nothing about reading from or writing to one.
 *
 * The symmetric half of `postgres-session.ts`, extracted for the same reason and
 * at the same moment. Slice 3a gives `copy` a second sink, so the two writers
 * must be reachable from ONE dispatcher (`copy-sink.ts`) that every source
 * adapter can import. If the sqlite writer stayed in `sqlite.ts`, that
 * dispatcher would import `sqlite.ts` while `sqlite.ts` imported the dispatcher
 * — the cycle. Moving the writer out is only possible if the primitives it
 * shares with the reader live somewhere neither has to import the other for.
 * That is this module, and it imports no adapter, no reader and no writer.
 *
 * Every export is a pure MOVE out of `sqlite.ts`, which re-exports them all so
 * no call site outside `connectors/` changes.
 */

/**
 * The server-side `sqlite` connection config: the SHARED schema plus the one
 * check that cannot live in a browser-safe package.
 *
 * Exactly the divergence `fs.ts` already documents and
 * `connection-config-ssot.test.ts` pins — `node:path`'s `isAbsolute` is
 * platform-aware, so the shared schema carries `roots`' shape and the server
 * refines it. It REFINES rather than re-declares, so the form and the adapter
 * can never describe different objects.
 *
 * EXPORTED as of #1167, because a sqlite SINK is no longer only reached from
 * this file. `fs.ts`'s copy arm gates the sink connection before handing it to
 * `writeSqliteDatasetRows`, and gating it with the SHARED schema would make that
 * rung strictly weaker than the identical rung on this adapter — a relative
 * root would pass `fs.ts`'s check and be refused one layer down, with a
 * different message for the same fault. The inner re-parse in
 * `writeSqliteDatasetRows` still catches it either way, but "the callee happens
 * to re-check" is defence in depth that this gate should not be leaning on
 * silently. One schema, both arms.
 */
export const sqliteConnectionConfigSchema = sharedSqliteConnectionConfigSchema.extend({
  roots: sharedSqliteConnectionConfigSchema.shape.roots.superRefine((roots, ctx) => {
    roots.forEach((root, index) => {
      if (isAbsolute(root)) return;
      ctx.addIssue({
        code: 'custom',
        message: 'every sqlite root must be an absolute path',
        // Indexed, so with several roots the message names WHICH one is wrong.
        path: [index],
      });
    });
  }),
});

/** A value SQLite can hand back for one column. */
export type SqliteValue = string | number | bigint | Uint8Array | null;
/** One row, keyed by column name as the store reports it. */
export type SqliteRow = Record<string, SqliteValue>;

/**
 * Re-exported so the three test suites and every existing importer keep their
 * `from './sqlite.js'` path: #1134 moved the class to its own module only to
 * break an import cycle (`copy.ts` needs it to unwrap a mapping failure, and
 * this module imports `copy.ts` to dispatch), not to re-home its public name.
 */
export { DatasetIoError };

/** SQLite result codes that mean "try again", not "this will never work". */
const TRANSIENT_SQLITE_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_PROTOCOL']);

/**
 * Whether a SQLite result code means "busy right now" rather than "this will
 * never work" — the fail-safe classification rule, named and exported so the
 * claim `readFailure` rests on can be asserted directly.
 *
 * The prefix reduction is the part worth pinning. better-sqlite3 reports
 * EXTENDED result codes (`SQLITE_<PRIMARY>_<EXTENDED>`), so a real lock
 * contention arrives as `SQLITE_BUSY_SNAPSHOT`, not `SQLITE_BUSY`; taking the
 * first two segments is what makes the set match it. It also has to NOT
 * over-match: `SQLITE_IOERR_READ` reduces to `SQLITE_IOERR`, which is absent
 * from the set and therefore stays permanent — a disk read error is not
 * something to retry into.
 */
export function isTransientSqliteCode(code: string): boolean {
  return TRANSIENT_SQLITE_CODES.has(code.split('_').slice(0, 2).join('_'));
}

/** Map a thrown store error onto a `DatasetIoError` (fail-safe: unrecognised → permanent).
 *
 * `partialWritePossible` defaults to false and is passed explicitly by the SINK,
 * the only caller that can leave rows behind. A read never can. */
export function storeFailure(
  err: unknown,
  context: string,
  partialWritePossible = false,
): DatasetIoError {
  if (err instanceof DatasetIoError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | undefined)?.code;
  const kind: ConnectorErrorKind =
    typeof code === 'string' && isTransientSqliteCode(code) ? 'transient' : 'permanent';
  return new DatasetIoError(kind, `${context}: ${message}`, { cause: err, partialWritePossible });
}

/**
 * Quote an identifier the STORE told us about — no shape refusal (#1127).
 *
 * The difference from `quoteIdentifier` (now `sql-identifier.ts`, lifted there
 * by #1190 when postgres needed it too) is a difference in PROVENANCE, not
 * in strictness for its own sake. §8's rule — "a name that only a quoting rule
 * makes safe is refused, not accommodated" — is about a name that reaches SQL
 * from operator-authored text, which cannot be bound as a parameter and so has
 * to be constrained rather than escaped. A column name read back out of
 * `pragma_table_info` is not that: it is the schema's own content, from a
 * database file `confineStorePath` has already confined, and the operator
 * created it by executing DDL against their own store. Doubling an embedded `"`
 * is genuinely sufficient there, and refusing it instead made an ordinary table
 * with a column called `first name` — or any CSV header with a space in it —
 * impossible to copy into, against the any-to-any intent of #993.
 *
 * WHAT KEEPS THIS SAFE, stated because "we relaxed the identifier check" is the
 * kind of sentence that deserves an argument under it. A mapping's `sink` name
 * is operator-authored, and it never reaches SQL as written: `resolveSinkColumns`
 * looks it up against the store's own columns and emits `actual`, the store's
 * spelling, or refuses the mapping. So an authored name can only ever select
 * from the set of names the store already has — it cannot introduce one. That
 * holds even for a mapping supplied dynamically through a whole-value `${}`,
 * which is why the save-time gate can leave that shape alone.
 *
 * TABLE and SCHEMA names keep `quoteIdentifier` and its refusal. Those DO come
 * from a dataset's `config`, which §8 requires be literal and identifier-shaped
 * at save time (`catalog/dataset-config.ts`'s `SQL_IDENTIFIER_RE`), so the two
 * cases have genuinely different threat models and the split is the point.
 *
 * ONE RESIDUAL, in the spirit of the module docblock's two: a column name
 * containing a NUL is the one shape doubling cannot make safe, because
 * `better-sqlite3` hands `prepare()` a C string and SQLite parses only as far as
 * the NUL — the statement is truncated mid-identifier. That fails CLOSED
 * (`prepare` throws, `storeFailure` classifies it, the transaction rolls back,
 * no partial write), so it is a poor error message rather than a hole, and it
 * needs a column no ordinary DDL through this tooling can create. Recorded so
 * the "doubling is genuinely sufficient" claim above is read with its one
 * exception rather than as unqualified.
 */
export function quoteStoreIdentifier(value: string): string {
  return doubleQuoted(value);
}

/**
 * Resolve the store's path through the shared confinement guard, CLASSIFYING the
 * guard's own throws.
 *
 * `resolveWithinRoots` deliberately does not fold a genuine filesystem error
 * into its `{ ok: false }` result — it lets `realpath` throw so the CALLER
 * decides what kind of failure it is, which is exactly what `fs.ts` does in its
 * `resolveOrFail`. Without this wrapper an `ENOENT` on the target's parent
 * directory (or an `EACCES` on a root) escapes as a raw Node error carrying no
 * failure `kind`, which breaks the one contract `DatasetIoError` exists to
 * uphold: that M5's `copy` adapter can map `.kind` straight onto `node.failed`.
 */
export async function confineStorePath(
  roots: readonly string[],
  requested: string,
): Promise<string> {
  let confined: Awaited<ReturnType<typeof resolveWithinRoots>>;
  try {
    confined = await resolveWithinRoots(roots, requested, 'sqlite');
  } catch (err) {
    throw storeFailure(err, `cannot resolve the sqlite database path '${requested}'`);
  }
  if (!confined.ok) throw new DatasetIoError('permanent', confined.error);
  return confined.path;
}

/**
 * The dataset kinds THIS STORE reads, named literally.
 *
 * Not `datasetKindIsImplemented`, which is what both guards below used to ask
 * and which stopped being the right question at M7 slice 3 (#1167).
 * `IMPLEMENTED_DATASET_KINDS` answers "does a reader exist ANYWHERE", and from
 * that slice on it spans two stores — so a `delimited` dataset would have passed
 * here and then been handed to `parseTableTarget`, which reports "invalid table
 * dataset config": a true statement about the wrong thing, sending an operator
 * to fix a config that is correct for the store it actually lives in.
 *
 * ONE guard and ONE message, deliberately, rather than a not-implemented arm
 * stacked on a not-mine arm. Layered, one of the two is unreachable for every
 * kind (`excel` is neither implemented nor a sqlite kind), and the pair would
 * only ever say which of two true things a given ordering happened to reach
 * first. `delimited-io.ts`'s `prepareRead` is the same shape from the other
 * store, which is what keeps the two symmetric.
 *
 * The MISMATCH this refuses is a dispatch the executor should already have
 * refused — `DATASET_CONNECTION_MISMATCH` fires when the dataset's store is not
 * the one the node bound — so this is defence in depth on a diagnostics path,
 * not the gate. It stays because a guard that reports the wrong fault is worse
 * than one that never runs.
 */
export const SQLITE_DATASET_KINDS: readonly DatasetKind[] = ['table', 'query'];

/** The refusal for a dataset kind that does not live in a sqlite store. */
export function notASqliteKind(kind: DatasetKind): string {
  return `the sqlite store reads ${SQLITE_DATASET_KINDS.map((k) => `'${k}'`).join(' and ')} datasets; this one is '${kind}'`;
}

/**
 * The `table` dataset config both the SINK writer and the address resolver
 * need, with SQLite's default database applied.
 *
 * A SQLite "schema" is an ATTACHed database and this connector attaches
 * nothing, so an unqualified dataset means `main`. Shared rather than
 * duplicated because the address gate and the writer MUST agree on what "the
 * same table" is: two spellings of one default would let the gate compare
 * `users` against `main.users` and find them different, which is precisely the
 * silent pass this slice exists to remove.
 */
export function parseTableTarget(datasetConfig: Record<string, unknown>): {
  schema: string;
  table: string;
} {
  const parsed = tableDatasetConfigSchema.safeParse(datasetConfig);
  if (!parsed.success) {
    throw new DatasetIoError(
      'permanent',
      `invalid table dataset config: ${formatZodIssues(parsed.error.issues)}`,
    );
  }
  return { schema: parsed.data.schema ?? 'main', table: parsed.data.table };
}
