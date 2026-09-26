import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../migrate.js';

/**
 * CX2 (0039) — `runs.status` accepts `cancelled`, on an UPGRADING DB.
 *
 * 0039 is a table RECREATE (SQLite cannot ALTER a CHECK), so the risk is not the
 * CHECK itself but the copy: a column left out of the `INSERT … SELECT` is lost
 * silently for every existing run. So every pre-0039 migration is replayed onto a
 * fresh DB, rows are written at their richest shape (a queued run with its frozen
 * trigger context, a child, a rerun), and only then does `runMigrations` apply
 * 0039.
 */
describe('0039 migration: runs.status accepts cancelled on an upgrading DB', () => {
  function upgradingDb() {
    const sqlite = new Database(':memory:');
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = OFF'); // as runMigrations holds it for recreates
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS __migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const pre0039 = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql') && name < '0039')
      .sort();
    for (const file of pre0039) {
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      sqlite
        .prepare('INSERT INTO __migrations (name, applied_at) VALUES (?, ?)')
        .run(file, new Date().toISOString());
    }
    sqlite.pragma('foreign_keys = ON');
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
    const insertRun = sqlite.prepare(
      `INSERT INTO runs
         (id, owner_id, pipeline_version_id, trigger_id, parent_run_id, params, status,
          lease_until, heartbeat_at, queued_at, trigger_context, started_at, finished_at, rerun_of)
       VALUES (?, 'own_1', 'pv_1', NULL, ?, '{"a":1}', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertRun.run('run_parent', null, 'failure', null, null, null, null, 10, 20, null);
    insertRun.run('run_child', 'run_parent', 'running', 99, 98, null, null, 11, null, null);
    insertRun.run(
      'run_queued',
      null,
      'queued',
      null,
      null,
      1234,
      '{"triggerId":"trg_x","scheduledTime":null,"body":null}',
      12,
      null,
      null,
    );
    insertRun.run('run_rerun', null, 'success', null, null, null, null, 13, 30, 'run_parent');
    return sqlite;
  }

  type Row = Record<string, unknown>;
  const allRows = (sqlite: Database.Database): Row[] =>
    sqlite.prepare('SELECT * FROM runs ORDER BY id').all() as Row[];

  it('carries every column of every existing run across the recreate', () => {
    const sqlite = upgradingDb();
    const before = allRows(sqlite);

    const { applied } = runMigrations(sqlite);

    expect(applied).toEqual(['0039_cx2_runs_cancelled_status.sql']);
    expect(allRows(sqlite)).toEqual(before);
  });

  it('accepts cancelled and still refuses a status outside the vocabulary', () => {
    const sqlite = upgradingDb();
    runMigrations(sqlite);

    sqlite.prepare(`UPDATE runs SET status = 'cancelled' WHERE id = 'run_child'`).run();
    expect(
      (sqlite.prepare(`SELECT status FROM runs WHERE id = 'run_child'`).get() as Row).status,
    ).toBe('cancelled');
    expect(() =>
      sqlite.prepare(`UPDATE runs SET status = 'aborted' WHERE id = 'run_child'`).run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('recreates all seven indexes', () => {
    const sqlite = upgradingDb();
    runMigrations(sqlite);

    const names = (
      sqlite
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'runs' AND name LIKE 'runs_%_idx' ORDER BY name`,
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual([
      'runs_owner_id_idx',
      'runs_parent_run_id_idx',
      'runs_pipeline_version_id_idx',
      'runs_rerun_of_idx',
      'runs_started_at_idx',
      'runs_status_idx',
      'runs_trigger_id_idx',
    ]);
  });

  it('keeps both self-referencing FKs as ON DELETE SET NULL', () => {
    const sqlite = upgradingDb();
    runMigrations(sqlite);
    sqlite.pragma('foreign_keys = ON');

    sqlite.prepare(`DELETE FROM runs WHERE id = 'run_parent'`).run();

    const rows = sqlite
      .prepare(
        `SELECT id, parent_run_id, rerun_of FROM runs WHERE id IN ('run_child', 'run_rerun') ORDER BY id`,
      )
      .all();
    expect(rows).toEqual([
      { id: 'run_child', parent_run_id: null, rerun_of: null },
      { id: 'run_rerun', parent_run_id: null, rerun_of: null },
    ]);
  });
});
