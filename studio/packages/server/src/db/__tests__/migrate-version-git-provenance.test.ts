import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../migrate.js';

/**
 * #3 G6b — the git-provenance columns on an UPGRADING (non-fresh) DB.
 *
 * Replays the REAL, committed 0001+0002 SQL directly onto a fresh in-memory DB
 * — bypassing `runMigrations` so a `pipeline_versions` row can exist BEFORE 0028
 * runs, mirroring an existing installation upgrading into this branch — then
 * hands the SAME connection to `runMigrations`. Mirrors
 * `migrate-containers-column.test.ts`.
 *
 * Unlike 0006, there is NO backfill: a pre-G6b version genuinely has no source
 * commit/blob, so `null` is the honest value (never a manufactured default —
 * #473). These tests pin (a) the honest-null upgrade, (b) nullability, and (c)
 * that the immutability trigger still covers the new columns.
 */
describe('0028 migration: git-provenance columns on an upgrading (non-fresh) DB', () => {
  const PROVENANCE_COLUMNS = [
    'source_commit',
    'source_branch',
    'source_file_path',
    'source_blob_sha',
  ];

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

  it('leaves a pre-0028 row with NULL provenance (honest — no manufactured default)', () => {
    const sqlite = upgradingDb();

    const { applied } = runMigrations(sqlite);
    expect(applied).toContain('0028_g6b_version_git_provenance.sql');

    const row = sqlite
      .prepare(
        'SELECT source_commit, source_branch, source_file_path, source_blob_sha FROM pipeline_versions WHERE id = ?',
      )
      .get('pv_1') as Record<string, unknown>;
    expect(row).toEqual({
      source_commit: null,
      source_branch: null,
      source_file_path: null,
      source_blob_sha: null,
    });
  });

  it('adds each provenance column as NULLABLE with no default', () => {
    const sqlite = upgradingDb();
    runMigrations(sqlite);

    for (const name of PROVENANCE_COLUMNS) {
      // `notnull` is a reserved SQLite keyword; double-quote it as an identifier.
      const info = sqlite
        .prepare(
          `SELECT "notnull", dflt_value FROM pragma_table_info('pipeline_versions') WHERE name = ?`,
        )
        .get(name) as { notnull: number; dflt_value: string | null } | undefined;
      expect(info, `column ${name} must exist`).toBeDefined();
      expect(info!.notnull).toBe(0);
      expect(info!.dflt_value).toBeNull();
    }
  });

  it('leaves pipeline_versions IMMUTABLE — the no-update trigger still covers the new columns', () => {
    const sqlite = upgradingDb();
    runMigrations(sqlite);

    // 0002's `pipeline_versions_no_update` is `BEFORE UPDATE ON` (not column-
    // scoped via `UPDATE OF`), so it must still abort an UPDATE touching a column
    // added afterwards — provenance is write-once at mint. Pin the ABORT REASON,
    // not just "it threw" (a missing column would throw for the wrong reason).
    expect(() =>
      sqlite
        .prepare('UPDATE pipeline_versions SET source_commit = ? WHERE id = ?')
        .run('commit-x', 'pv_1'),
    ).toThrow(/immutable/);
  });
});
