import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

export const MIGRATIONS_DIR = join(
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
export function runMigrations(
  sqlite: Database.Database,
  migrationsDir: string = MIGRATIONS_DIR,
): { applied: string[] } {
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

  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const pending = files.filter((file) => !alreadyApplied.has(file));

  if (pending.length === 0) return { applied: [] };

  // Foreign-key enforcement must be OFF while any migration recreates a
  // table (SQLite has no `ALTER TABLE ... ALTER COLUMN`; the documented
  // procedure — https://www.sqlite.org/lang_altertable.html#otheralter — is
  // CREATE new / INSERT-SELECT / DROP old / RENAME). Verified empirically:
  // with `foreign_keys` ON, `DROP TABLE` on a table another table's FK
  // references performs an IMPLICIT DELETE that fires that FK's
  // `ON DELETE` action (e.g. `SET NULL`) against every referencing row —
  // which would silently null out e.g. `runs.trigger_id` for real,
  // unrelated data when a migration recreates `triggers` (see the 0003
  // migration). `PRAGMA foreign_keys` is ALSO a documented no-op inside a
  // transaction, so it must be toggled here, outside every per-file
  // `sqlite.transaction()` below, not inside one.
  const foreignKeysWereOn = sqlite.pragma('foreign_keys', { simple: true }) === 1;
  if (foreignKeysWereOn) sqlite.pragma('foreign_keys = OFF');

  const applied: string[] = [];
  try {
    for (const file of pending) {
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      const applyMigration = sqlite.transaction(() => {
        sqlite.exec(sql);
        sqlite
          .prepare('INSERT INTO __migrations (name, applied_at) VALUES (?, ?)')
          .run(file, new Date().toISOString());
      });
      applyMigration();
      applied.push(file);
    }
  } finally {
    if (foreignKeysWereOn) sqlite.pragma('foreign_keys = ON');
  }

  // With `foreign_keys` OFF for the whole batch above (required for the
  // table-recreate procedure — see the comment above), a migration that
  // introduces a dangling reference (e.g. an INSERT/UPDATE against a
  // recreated table that no longer satisfies an FK) would NOT raise at
  // apply time — enforcement was off. `PRAGMA foreign_key_check` is a
  // point-in-time integrity scan that is independent of the enforcement
  // pragma (verified empirically: it reports the same violations whether
  // `foreign_keys` is ON or OFF), so running it once here, after the whole
  // batch, catches anything a bad migration left behind and fails loudly
  // instead of silently persisting invalid refs.
  const violations = sqlite.pragma('foreign_key_check') as Array<{
    table: string;
    rowid: number | bigint | null;
    parent: string;
    fkid: number;
  }>;
  if (violations.length > 0) {
    const [first] = violations;
    throw new Error(
      `Migration integrity violation: applying [${applied.join(', ')}] left a dangling foreign ` +
        `key — table '${first!.table}' rowid ${String(first!.rowid)} references missing row in ` +
        `'${first!.parent}' (${violations.length} violation(s) total)`,
    );
  }

  return { applied };
}
