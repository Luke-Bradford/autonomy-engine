import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../migrate.js';

/**
 * #3 G1 — `resource_id` backfill (0024) on an UPGRADING (non-fresh) DB.
 *
 * Replays the REAL, committed 0001+0002 SQL directly onto a fresh in-memory DB
 * — bypassing `runMigrations` so pre-G1 rows exist BEFORE 0024 runs, mirroring
 * an existing installation upgrading into this branch — then hands the SAME
 * connection to `runMigrations`. Mirrors `migrate-containers-column.test.ts`.
 *
 * The critical hazard this pins: `pipeline_versions` carries the
 * `pipeline_versions_no_update` immutability trigger, which would RAISE(ABORT)
 * the backfill UPDATE — 0024 drops it around the system backfill and MUST
 * recreate it verbatim.
 */
describe('0024 migration: resource identity on an upgrading (non-fresh) DB', () => {
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
    // Two rows per resource table (uniqueness needs >1), plus a shared owner.
    const insertPipeline = sqlite.prepare(
      'INSERT INTO pipelines (id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
    );
    insertPipeline.run('pipe_1', 'local', 'P1');
    insertPipeline.run('pipe_2', 'local', 'P2');
    const insertVersion = sqlite.prepare(
      `INSERT INTO pipeline_versions
         (id, pipeline_id, version, params, outputs, nodes, edges, catalog_version, created_at)
       VALUES (?, ?, ?, '[]', '[]', '[]', '[]', 1, 1)`,
    );
    insertVersion.run('pv_1', 'pipe_1', 1);
    insertVersion.run('pv_2', 'pipe_1', 2);
    const insertConnection = sqlite.prepare(
      `INSERT INTO connections (id, owner_id, name, kind, config, created_at, updated_at)
       VALUES (?, ?, ?, 'http', '{}', 1, 1)`,
    );
    insertConnection.run('conn_1', 'local', 'C1');
    insertConnection.run('conn_2', 'local', 'C2');
    const insertTrigger = sqlite.prepare(
      `INSERT INTO triggers
         (id, owner_id, name, pipeline_version_id, params, mode, schedule, webhook, concurrency, run_windows, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'pv_1', '{}', 'manual', NULL, NULL, '{"policy":"queue"}', NULL, 0, 1, 1)`,
    );
    insertTrigger.run('trig_1', 'local', 'T1');
    insertTrigger.run('trig_2', 'local', 'T2');
    return sqlite;
  }

  it('backfills every pre-G1 row on all four tables with a unique non-null resource_id', () => {
    const sqlite = upgradingDb();
    const { applied } = runMigrations(sqlite);
    expect(applied).toContain('0024_g1_resource_identity.sql');

    for (const table of ['pipelines', 'pipeline_versions', 'connections', 'triggers']) {
      const rows = sqlite.prepare(`SELECT resource_id AS resourceId FROM ${table}`).all() as Array<{
        resourceId: string | null;
      }>;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.resourceId).toBeTruthy();
      }
      expect(new Set(rows.map((r) => r.resourceId)).size).toBe(rows.length);
    }
  });

  it('recreates the pipeline_versions immutability trigger after the backfill', () => {
    const sqlite = upgradingDb();
    runMigrations(sqlite);

    // The backfill dropped `pipeline_versions_no_update` around its system
    // UPDATE — a normal update must STILL be refused afterwards.
    expect(() =>
      sqlite.prepare("UPDATE pipeline_versions SET nodes = '[]' WHERE id = 'pv_1'").run(),
    ).toThrow(/immutable/);
    // And the resource_id column itself is covered too — identity is stamped
    // once, never rewritten.
    expect(() =>
      sqlite.prepare("UPDATE pipeline_versions SET resource_id = 'res_x' WHERE id = 'pv_1'").run(),
    ).toThrow(/immutable/);
  });

  it('enforces OWNER-scoped uniqueness (same resource_id under two owners is legal)', () => {
    const sqlite = upgradingDb();
    runMigrations(sqlite);

    // Same resource_id, DIFFERENT owner: legal (workspace-git import preserves
    // ids across owners — the whole reason the index is owner-scoped).
    sqlite
      .prepare(
        'INSERT INTO pipelines (id, resource_id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)',
      )
      .run('pipe_a', 'res_shared', 'alice', 'PA');
    sqlite
      .prepare(
        'INSERT INTO pipelines (id, resource_id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)',
      )
      .run('pipe_b', 'res_shared', 'bob', 'PB');

    // Same resource_id, SAME owner: refused.
    expect(() =>
      sqlite
        .prepare(
          'INSERT INTO pipelines (id, resource_id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)',
        )
        .run('pipe_c', 'res_shared', 'alice', 'PC'),
    ).toThrow(/UNIQUE/);
  });
});
