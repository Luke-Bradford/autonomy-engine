import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../migrate.js';

/**
 * #3 G5a (item ②) — the `archived` column on an UPGRADING (non-fresh) DB.
 *
 * Replays the REAL, committed 0001+0002 SQL directly onto a fresh in-memory DB
 * — bypassing `runMigrations` so a `pipelines` row can exist BEFORE 0026 runs,
 * mirroring an existing installation upgrading into this branch — then hands the
 * SAME connection to `runMigrations`. Mirrors `migrate-containers-column.test.ts`.
 *
 * The point: a pre-G5a pipeline must backfill to un-archived (a truthful
 * NOT-NULL default, not a manufactured absent value — #473).
 */
describe('0026 migration: archived column on an upgrading (non-fresh) DB', () => {
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

  it('backfills a pre-0026 row to un-archived (0)', () => {
    const sqlite = upgradingDb();

    const { applied } = runMigrations(sqlite);
    expect(applied).toContain('0026_g5a_pipeline_archived.sql');

    const row = sqlite.prepare('SELECT archived FROM pipelines WHERE id = ?').get('pipe_1') as {
      archived: number;
    };
    expect(row.archived).toBe(0);
  });

  it('adds archived as NOT NULL DEFAULT 0 — a stored pipeline can never lack the flag', () => {
    const sqlite = upgradingDb();
    runMigrations(sqlite);

    const columnInfo = sqlite
      .prepare(
        `SELECT "notnull", dflt_value FROM pragma_table_info('pipelines') WHERE name = 'archived'`,
      )
      .get() as { notnull: number; dflt_value: string };
    expect(columnInfo.notnull).toBe(1);
    expect(columnInfo.dflt_value).toBe('0');
  });
});
