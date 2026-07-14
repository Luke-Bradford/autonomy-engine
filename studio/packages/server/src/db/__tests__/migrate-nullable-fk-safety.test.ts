import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../migrate.js';

/**
 * Regression test for the exact hazard `runMigrations`'s foreign-key toggle
 * (see `migrate.ts`) was added to prevent: recreating the `triggers` table
 * (migration 0003, dropping its `pipeline_version_id` NOT NULL) must NOT
 * silently null out `runs.trigger_id` for a run that genuinely references an
 * existing trigger.
 *
 * This replays the REAL, committed SQL files (0001 + 0002) directly onto a
 * fresh in-memory DB — bypassing `runMigrations` so a pipeline/trigger/run
 * can be inserted BEFORE 0003 ever runs, mirroring an existing installation
 * upgrading into this migration — then hands the same connection to
 * `runMigrations` (which finds only 0003 pending) and asserts the
 * cross-referencing data survived untouched.
 */
describe('0003 migration: foreign-key safety on an upgrading (non-fresh) DB', () => {
  it('does not null out runs.trigger_id when recreating triggers', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');

    // Bootstrap the bookkeeping table + apply 0001/0002 directly, exactly as
    // an already-migrated installation's DB would look the moment before
    // this branch's 0003 ships.
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS __migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    for (const file of ['0001_init.sql', '0002_p1a_data_model.sql']) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      sqlite.exec(sql);
      sqlite
        .prepare('INSERT INTO __migrations (name, applied_at) VALUES (?, ?)')
        .run(file, new Date().toISOString());
    }

    // Real cross-referencing data: a pipeline version, a trigger bound to
    // it, and a run that references that trigger — the exact shape whose
    // `runs.trigger_id` must survive the 0003 recreate untouched.
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
        `INSERT INTO triggers
           (id, owner_id, name, pipeline_version_id, params, mode, schedule, webhook, concurrency, run_windows, enabled, created_at, updated_at)
         VALUES (?, NULL, 'T', ?, '{}', 'manual', NULL, NULL, '{"policy":"queue"}', NULL, 1, 1, 1)`,
      )
      .run('trig_1', 'pv_1');
    sqlite
      .prepare(
        `INSERT INTO runs
           (id, owner_id, pipeline_version_id, trigger_id, parent_run_id, params, status, lease_until, heartbeat_at, started_at, finished_at)
         VALUES (?, NULL, ?, ?, NULL, '{}', 'pending', NULL, NULL, 1, NULL)`,
      )
      .run('run_1', 'pv_1', 'trig_1');

    const { applied } = runMigrations(sqlite);
    // 0003 is the migration under test; assert it ran (rather than pinning the
    // WHOLE pending set, which any later migration — e.g. 0004 — would grow).
    // The runner applies files in filename order, so 0003 precedes any newer
    // one, and the FK toggle wraps the whole run.
    expect(applied).toContain('0003_p1c_trigger_unbound_pipeline_version.sql');

    const run = sqlite.prepare('SELECT trigger_id FROM runs WHERE id = ?').get('run_1') as {
      trigger_id: string | null;
    };
    expect(run.trigger_id).toBe('trig_1');

    // The whole point of 0003: pipeline_version_id is now nullable.
    // `notnull` is a reserved SQLite keyword (the `X NOTNULL` operator), so
    // the column name from `pragma_table_info` must be double-quoted as an
    // identifier here.
    const columnInfo = sqlite
      .prepare(
        `SELECT "notnull" FROM pragma_table_info('triggers') WHERE name = 'pipeline_version_id'`,
      )
      .get() as { notnull: number };
    expect(columnInfo.notnull).toBe(0);

    sqlite
      .prepare(
        `INSERT INTO triggers
           (id, owner_id, name, pipeline_version_id, params, mode, schedule, webhook, concurrency, run_windows, enabled, created_at, updated_at)
         VALUES ('trig_unbound', NULL, 'Unbound', NULL, '{}', 'manual', NULL, NULL, '{"policy":"queue"}', NULL, 1, 1, 1)`,
      )
      .run();
    expect(
      sqlite.prepare('SELECT pipeline_version_id FROM triggers WHERE id = ?').get('trig_unbound'),
    ).toEqual({ pipeline_version_id: null });

    // FK enforcement is restored afterward — a bogus pipeline_version_id
    // still gets rejected.
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO triggers
             (id, owner_id, name, pipeline_version_id, params, mode, schedule, webhook, concurrency, run_windows, enabled, created_at, updated_at)
           VALUES ('trig_bogus', NULL, 'Bogus', 'pv_does_not_exist', '{}', 'manual', NULL, NULL, '{"policy":"queue"}', NULL, 1, 1, 1)`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);

    sqlite.close();
  });
});
