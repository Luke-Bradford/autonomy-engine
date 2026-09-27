import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../migrate.js';

/**
 * #1380 — the `folder` column on an UPGRADING (non-fresh) DB.
 *
 * Replays the REAL, committed 0001+0002 SQL directly onto a fresh in-memory DB
 * — bypassing `runMigrations` so a `pipelines` row can exist BEFORE 0044 runs,
 * mirroring an existing installation upgrading into this branch — then hands the
 * SAME connection to `runMigrations`. Mirrors `migrate-containers-column.test.ts`.
 *
 * The point: a pipeline that predates folders is at the TOP LEVEL, which is
 * what a NULL folder means — a truthful backfill, not a manufactured value.
 */
describe('0044 migration: folder column on an upgrading (non-fresh) DB', () => {
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
    return sqlite;
  }

  it('backfills a pre-0044 row to NULL (top level), and the column stays nullable', () => {
    const sqlite = upgradingDb();

    const { applied } = runMigrations(sqlite);
    expect(applied).toContain('0044_1380_pipelines_folder.sql');

    const row = sqlite.prepare('SELECT folder FROM pipelines WHERE id = ?').get('pipe_1') as {
      folder: string | null;
    };
    expect(row.folder).toBeNull();

    const column = (
      sqlite.prepare('PRAGMA table_info(pipelines)').all() as { name: string; notnull: number }[]
    ).find((c) => c.name === 'folder');
    expect(column?.notnull).toBe(0);
  });
});
