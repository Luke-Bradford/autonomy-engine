import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Temp-database fixtures shared by the `sqlite` connector's READ suite (#1119),
 * its SINK suite (#1125) and the reader→pump→sink composition suite (#1129).
 *
 * Extracted rather than copied. `tempRoot`'s `realpathSync` is load-bearing, and
 * the idiom already existed twice as a same-shaped `tempRoot()` before this file
 * did (`sqlite.test.ts`, `confine.test.ts`) plus once as an inline async variant
 * in `fs.test.ts`'s `beforeEach`; a fourth copy in the sink suite would have been
 * the one that eventually drifted. The remaining copies belong to suites this
 * ticket does not touch.
 */

const dirs: string[] = [];

/** A temp dir whose path is REALPATH'd.
 *
 * On macOS `os.tmpdir()` is itself a symlink (`/var` → `/private/var`), so a
 * root taken straight from `mkdtemp` never canonically contains the paths
 * resolved under it, and a confinement test would pass for the wrong reason —
 * or fail for one. */
export function tempRoot(prefix = 'sqlite-store-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

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
export function cleanupTempRoots(): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
}

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
