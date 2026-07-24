import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../migrate.js';

/**
 * RS6 (0034) — the `runs.rerun_of` durable rerun-from-failed LINEAGE column on
 * an UPGRADING (non-fresh) DB.
 *
 * Replays the REAL, committed 0001+0002 SQL directly onto a fresh in-memory DB —
 * bypassing `runMigrations` so a `runs` row can exist BEFORE 0034 runs, mirroring
 * an existing installation upgrading into this branch — then hands the SAME
 * connection to `runMigrations`. Mirrors `migrate-archived-column.test.ts`.
 *
 * The point: a plain `ALTER TABLE ADD COLUMN` (no table recreate — unlike 0015's
 * CHECK widen) leaves every pre-existing run with `rerun_of = NULL` (a truthful
 * "this run is not a rerun"), and the self-referencing FK enforces `ON DELETE SET
 * NULL` so a retention sweep of a source run leaves its rerun a valid orphan.
 */
describe('0034 migration: runs.rerun_of on an upgrading (non-fresh) DB', () => {
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
    // A pipeline version + a run that references it — the pre-0034 shape whose
    // `rerun_of` must backfill to NULL.
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
    sqlite
      .prepare(
        `INSERT INTO runs (id, owner_id, pipeline_version_id, params, status, started_at)
         VALUES (?, NULL, ?, '{}', 'success', 1)`,
      )
      .run('run_source', 'pv_1');
    return sqlite;
  }

  it('backfills a pre-0034 run to rerun_of NULL (not a rerun)', () => {
    const sqlite = upgradingDb();

    const { applied } = runMigrations(sqlite);
    expect(applied).toContain('0034_rs6_runs_rerun_of.sql');

    const row = sqlite.prepare('SELECT rerun_of FROM runs WHERE id = ?').get('run_source') as {
      rerun_of: string | null;
    };
    expect(row.rerun_of).toBeNull();
  });

  it('adds rerun_of as a NULLABLE column with no default', () => {
    const sqlite = upgradingDb();
    runMigrations(sqlite);

    const columnInfo = sqlite
      .prepare(
        `SELECT "notnull", dflt_value FROM pragma_table_info('runs') WHERE name = 'rerun_of'`,
      )
      .get() as { notnull: number; dflt_value: string | null };
    expect(columnInfo.notnull).toBe(0);
    expect(columnInfo.dflt_value).toBeNull();
  });

  it('indexes rerun_of (the rerun-history grouping scan)', () => {
    const sqlite = upgradingDb();
    runMigrations(sqlite);

    const idx = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'runs_rerun_of_idx'`)
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe('runs_rerun_of_idx');
  });

  it('enforces ON DELETE SET NULL: deleting a source run orphans its rerun (no cascade, no block)', () => {
    const sqlite = upgradingDb();
    runMigrations(sqlite);
    sqlite.pragma('foreign_keys = ON');

    // A rerun-from-failed of run_source.
    sqlite
      .prepare(
        `INSERT INTO runs (id, owner_id, pipeline_version_id, params, status, started_at, rerun_of)
         VALUES (?, NULL, ?, '{}', 'running', 2, ?)`,
      )
      .run('run_rerun', 'pv_1', 'run_source');

    sqlite.prepare('DELETE FROM runs WHERE id = ?').run('run_source');

    const rerun = sqlite.prepare('SELECT id, rerun_of FROM runs WHERE id = ?').get('run_rerun') as {
      id: string;
      rerun_of: string | null;
    };
    // The rerun row SURVIVES (not cascaded away) with its lineage pointer nulled.
    expect(rerun.id).toBe('run_rerun');
    expect(rerun.rerun_of).toBeNull();
  });

  it('rejects a rerun_of pointing at a nonexistent run (FK enforced)', () => {
    const sqlite = upgradingDb();
    runMigrations(sqlite);
    sqlite.pragma('foreign_keys = ON');

    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO runs (id, owner_id, pipeline_version_id, params, status, started_at, rerun_of)
           VALUES (?, NULL, ?, '{}', 'running', 2, ?)`,
        )
        .run('run_bad', 'pv_1', 'run_does_not_exist'),
    ).toThrow();
  });
});
