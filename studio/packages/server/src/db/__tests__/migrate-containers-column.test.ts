import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../migrate.js';

/**
 * #473 — the `containers` column on an UPGRADING (non-fresh) DB.
 *
 * Replays the REAL, committed 0001+0002 SQL directly onto a fresh in-memory DB
 * — bypassing `runMigrations` so a `pipeline_versions` row can exist BEFORE
 * 0006 runs, mirroring an existing installation upgrading into this branch —
 * then hands the SAME connection to `runMigrations`. Mirrors the convention in
 * `migrate-nullable-fk-safety.test.ts`.
 *
 * The backfill's rationale (why `'[]'` is honest rather than lossy for an
 * existing row) lives in the migration itself.
 */
describe('0006 migration: containers column on an upgrading (non-fresh) DB', () => {
  function upgradingDb() {
    const sqlite = new Database(':memory:');
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS __migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    for (const file of ['0001_init.sql', '0002_p1a_data_model.sql']) {
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      sqlite
        .prepare('INSERT INTO __migrations (name, applied_at) VALUES (?, ?)')
        .run(file, new Date().toISOString());
    }
    sqlite
      .prepare(
        'INSERT INTO pipelines (id, owner_id, name, created_at, updated_at) VALUES (?, NULL, ?, 1, 1)',
      )
      .run('pipe_1', 'P');
    sqlite
      .prepare(
        `INSERT INTO pipeline_versions
           (id, pipeline_id, version, params, outputs, nodes, edges, catalog_version, created_at)
         VALUES (?, ?, 1, '[]', '[]', '[]', '[]', 1, 1)`,
      )
      .run('pv_1', 'pipe_1');
    return sqlite;
  }

  it('backfills a pre-0006 row to an empty container list', () => {
    const sqlite = upgradingDb();

    const { applied } = runMigrations(sqlite);
    // 0006 is the migration under test; assert it ran rather than pinning the
    // WHOLE pending set, which any later migration would grow.
    expect(applied).toContain('0006_p2c_pipeline_versions_containers.sql');

    const row = sqlite
      .prepare('SELECT containers FROM pipeline_versions WHERE id = ?')
      .get('pv_1') as { containers: string };
    expect(row.containers).toBe('[]');
  });

  it('adds containers as NOT NULL — a stored version can never lack the field', () => {
    const sqlite = upgradingDb();
    runMigrations(sqlite);

    // `notnull` is a reserved SQLite keyword (the `X NOTNULL` operator), so the
    // column name from `pragma_table_info` must be double-quoted as an
    // identifier here.
    const columnInfo = sqlite
      .prepare(
        `SELECT "notnull", dflt_value FROM pragma_table_info('pipeline_versions') WHERE name = 'containers'`,
      )
      .get() as { notnull: number; dflt_value: string };
    expect(columnInfo.notnull).toBe(1);
    expect(columnInfo.dflt_value).toBe(`'[]'`);
  });

  it('leaves pipeline_versions IMMUTABLE — the no-update trigger still covers the new column', () => {
    const sqlite = upgradingDb();
    runMigrations(sqlite);

    // 0002's `pipeline_versions_no_update` is `BEFORE UPDATE ON` (not column-
    // scoped via `UPDATE OF`), so it must still abort an UPDATE touching a
    // column added afterwards. If a later migration ever narrows that trigger,
    // this is what catches it.
    // Pin the ABORT REASON, not just "it threw": pre-0006 this same statement
    // throws `no such column: containers`, so a bare `.toThrow()` would pass
    // for entirely the wrong reason and false-green on a future column rename.
    expect(() =>
      sqlite
        .prepare('UPDATE pipeline_versions SET containers = ? WHERE id = ?')
        .run('[{"id":"c1"}]', 'pv_1'),
    ).toThrow(/immutable/);
  });
});
