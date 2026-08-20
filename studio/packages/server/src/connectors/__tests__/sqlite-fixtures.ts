import { join } from 'node:path';
import Database from 'better-sqlite3';
// The temp-root helpers moved to `temp-roots.ts` when #1165's reader suite became
// their fourth consumer and this file's store-specific name stopped fitting.
// Re-exported so every existing consumer keeps its single import.
export { cleanupTempRoots, tempRoot } from './temp-roots.js';

/**
 * Temp-database fixtures shared by the `sqlite` connector's READ suite (#1119),
 * its SINK suite (#1125) and the reader→pump→sink composition suite (#1129).
 *
 * Extracted rather than copied. The temp-root half has since moved again, to
 * `temp-roots.ts`, once #1165's `delimited` reader suite made it store-agnostic
 * in fact as well as in use; what remains here is the genuinely SQLite-specific
 * seeding.
 */

/** A database file under `root`, seeded with `rows` rows in `t(id, name)`. */
export function seedDb(root: string, rows: number, name = 'app.db'): string {
  const path = join(root, name);
  const db = new Database(path);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  const insert = db.prepare('INSERT INTO t (id, name) VALUES (?, ?)');
  const many = db.transaction((count: number) => {
    for (let i = 1; i <= count; i += 1) insert.run(i, `row-${i}`);
  });
  many(rows);
  db.close();
  return path;
}

/** Remove every temp dir this module handed out.
 *
 * REMOVED, not left for the OS: these dirs hold real database files, some tests
 * write a WAL sidecar pair, and `/tmp` is not reaped between runs on every
 * platform — so leaving them just accumulates litter. */
/** A sink database: `t(id,name)` from `seedDb` plus a wider `sink` table. */
export function seedSink(root: string, name = 'app.db'): string {
  const path = seedDb(root, 0, name);
  const db = new Database(path);
  db.exec(
    'CREATE TABLE sink (id INTEGER, name TEXT, flag INTEGER, big INTEGER, payload BLOB, note TEXT)',
  );
  db.close();
  return path;
}

/** Read a table back, for asserting what actually landed. */
export function rowsOf(path: string, sql = 'SELECT * FROM sink ORDER BY rowid'): unknown[] {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

/** A `sqlite` connection config with the `writable` gate OPEN. */
export const writableConfig = (root: string, path: string) => ({
  roots: [root],
  path,
  writable: true,
});
