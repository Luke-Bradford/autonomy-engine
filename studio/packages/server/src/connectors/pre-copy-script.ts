import {
  sqlBindNames,
  sqlLeadingKeyword,
  type SqlDialect,
  type SqlParameterValue,
} from '@autonomy-studio/shared';

/**
 * #1600 OR41 C3b — a copy's Pre-copy script (ADF's `preCopyScript`), as the sink
 * runs it: one authored statement, run once inside the copy's write transaction
 * before the first row, with its `:name`s bound from `parameters`.
 *
 * `sql` is literal by construction: save refuses a `${` in it and the reducer
 * hands it over unsubstituted (`prepInput`), so only the bind values were ever
 * evaluated.
 */
export interface PreCopyScript {
  readonly sql: string;
  readonly parameters: Readonly<Record<string, SqlParameterValue>>;
}

/**
 * The statements a Pre-copy script may begin with, per store. An ALLOW-list on
 * the leading keyword (`sqlLeadingKeyword`), and the two lists exist for
 * different reasons.
 *
 * **sqlite: this list is the file-confinement boundary.** The sink opens a file
 * `confineStorePath` has placed inside the connection's roots, and before C3b it
 * ran no authored SQL at all (`sqlite.ts`'s header). Authored SQL could step
 * outside: MEASURED on better-sqlite3 12, `ATTACH DATABASE '<path>'` runs inside
 * `begin immediate` and opens any existing database file the process can reach
 * (the sink opens with `fileMustExist`, whose flags an attach inherits, so it
 * cannot create one), and the sink's dataset may name the attached schema.
 * `VACUUM INTO '<path>'` writes a file (SQLite refuses it inside a transaction,
 * which is not a rule to lean on). So neither is listed, nor is `PRAGMA`.
 * Nothing in the list reaches a file: better-sqlite3 compiles in no file-backed
 * virtual table, and `load_extension` is not authorized (sqlite.ts). better-
 * sqlite3's `prepare` refuses more than one statement, so the word checked is
 * the statement run, and `sqlLeadingKeyword` answers null for a leading `;`.
 * `SELECT` is left out because nothing it can do belongs in a pre-copy script.
 *
 * **postgres: this list keeps the script inside the transaction; it is not a
 * privilege boundary.** The connection's credential is the authority there, as
 * it is for every statement the sink runs, and the session is a fresh client
 * that ends with the copy, so a `SET` would leak nowhere. What the list refuses
 * is transaction control (`BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`), which
 * would split the script from the copy it belongs to. The extended protocol
 * (`queryMode: 'extended'`) makes the server refuse a second statement, so a
 * `delete …; commit` cannot follow an allowed word. `SELECT`, `CALL` and `DO`
 * are there for a function or procedure that cleans up. What those run is the
 * credential's business, and an effect postgres does not roll back (a sequence,
 * `dblink`) survives a failed copy and its retry.
 */
export const PRE_COPY_SCRIPT_STATEMENTS: Readonly<Record<SqlDialect, readonly string[]>> = {
  sqlite: ['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'DROP', 'ALTER', 'WITH'],
  postgres: [
    'INSERT',
    'UPDATE',
    'DELETE',
    'MERGE',
    'TRUNCATE',
    'CREATE',
    'DROP',
    'ALTER',
    'WITH',
    'SELECT',
    'CALL',
    'DO',
  ],
};

const STORE_NAMES: Readonly<Record<SqlDialect, string>> = {
  sqlite: 'SQLite',
  postgres: 'PostgreSQL',
};

/**
 * Why `script` may not run on `dialect`'s sink, or `null`. Checked before the
 * script reaches the store: the leading statement, then that every `:name` the
 * store's own lexer finds has a value, so a missing one is named rather than
 * left to each driver's own wording.
 */
export function preCopyScriptRefusal(script: PreCopyScript, dialect: SqlDialect): string | null {
  const allowed = PRE_COPY_SCRIPT_STATEMENTS[dialect];
  const keyword = sqlLeadingKeyword(script.sql, dialect);
  if (keyword === null) {
    return 'the Pre-copy script must begin with its statement (a comment may come first)';
  }
  if (!allowed.includes(keyword)) {
    return `a Pre-copy script on ${STORE_NAMES[dialect]} may not run ${keyword}; it may begin with ${allowed.join(', ')}`;
  }
  const missing = sqlBindNames(script.sql, dialect).filter(
    (name) => !Object.prototype.hasOwnProperty.call(script.parameters, name),
  );
  if (missing.length > 0) {
    // Named without a prefix: sqlite also binds `@n`, `$n` and `?n` from the record.
    return `the Pre-copy script binds ${missing.map((n) => `'${n}'`).join(', ')} with no value in Pre-copy bind values`;
  }
  return null;
}

/**
 * The bind values the statement actually uses, keyed as the sqlite driver binds
 * them, or `undefined` for none: better-sqlite3 refuses a bind object on a
 * statement with no named parameters (`sqlite.ts`'s `statementFor`).
 */
export function usedSqliteParameters(
  script: PreCopyScript,
): Record<string, SqlParameterValue> | undefined {
  const names = sqlBindNames(script.sql, 'sqlite');
  if (names.length === 0) return undefined;
  return Object.fromEntries(
    Object.entries(script.parameters).filter(([name]) => names.includes(name)),
  );
}
