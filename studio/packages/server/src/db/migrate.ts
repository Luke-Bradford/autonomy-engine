import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'drizzle',
  'migrations',
);

/**
 * Minimal, dependency-free migration runner: applies every `NNNN_*.sql` file
 * in `drizzle/migrations` (in filename order) exactly once, tracked in a
 * `__migrations` bookkeeping table. Deliberately hand-rolled rather than
 * pulling in `drizzle-kit` at runtime — for the P0a skeleton this is the
 * entire migration surface (one table), and it keeps the boot path dependency
 * -free.
 */
export function runMigrations(sqlite: Database.Database): { applied: string[] } {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const alreadyApplied = new Set(
    sqlite
      .prepare('SELECT name FROM __migrations')
      .all()
      .map((row) => (row as { name: string }).name),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const applied: string[] = [];

  for (const file of files) {
    if (alreadyApplied.has(file)) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const applyMigration = sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite
        .prepare('INSERT INTO __migrations (name, applied_at) VALUES (?, ?)')
        .run(file, new Date().toISOString());
    });
    applyMigration();
    applied.push(file);
  }

  return { applied };
}
