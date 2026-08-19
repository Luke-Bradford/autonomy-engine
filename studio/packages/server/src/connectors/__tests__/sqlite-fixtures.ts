import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Temp-database fixtures shared by the `sqlite` connector's READ suite (#1119)
 * and its SINK suite (#1125).
 *
 * Extracted rather than copied. `tempRoot`'s `realpathSync` is load-bearing and
 * was already duplicated three times before this file existed
 * (`sqlite.test.ts`, `confine.test.ts`, `fs.test.ts`); a fourth copy in the sink
 * suite would have been the one that eventually drifted. The two remaining
 * copies belong to suites this ticket does not touch.
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
