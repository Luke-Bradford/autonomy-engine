import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../migrate.js';

/**
 * #844 V1 — the `variables` column on an UPGRADING (non-fresh) DB. Applies every
 * committed migration BEFORE 0040 directly, inserts a `pipeline_versions` row,
 * then hands the same connection to `runMigrations`, mirroring an existing
 * installation upgrading into V1 (the `migrate-cx2-runs-cancelled.test.ts`
 * convention). The migration's own header explains why `'[]'` is the honest
 * backfill.
 */
const MIGRATION = '0040_v1_pipeline_versions_variables.sql';

describe('0040 migration: variables column on an upgrading DB', () => {
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
    const pre0040 = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql') && name < '0040')
      .sort();
    for (const file of pre0040) {
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
    return sqlite;
  }

  it('backfills a pre-0040 row to an empty variable list', () => {
    const sqlite = upgradingDb();
    expect(runMigrations(sqlite).applied).toContain(MIGRATION);
    const row = sqlite
      .prepare('SELECT variables FROM pipeline_versions WHERE id = ?')
      .get('pv_1') as { variables: string };
    expect(row.variables).toBe('[]');
  });

  it('adds variables as NOT NULL', () => {
    const sqlite = upgradingDb();
    runMigrations(sqlite);
    // `notnull` is a reserved word, hence the quoted identifier.
    const column = sqlite
      .prepare(
        `SELECT "notnull", dflt_value FROM pragma_table_info('pipeline_versions') WHERE name = 'variables'`,
      )
      .get() as { notnull: number; dflt_value: string };
    expect(column.notnull).toBe(1);
    expect(column.dflt_value).toBe(`'[]'`);
  });

  it('leaves pipeline_versions IMMUTABLE — the no-update trigger covers the new column', () => {
    const sqlite = upgradingDb();
    runMigrations(sqlite);
    // Pinned on the ABORT REASON: before 0040 the same statement throws
    // `no such column`, which a bare `.toThrow()` would accept.
    expect(() =>
      sqlite.prepare('UPDATE pipeline_versions SET variables = ? WHERE id = ?').run('[]', 'pv_1'),
    ).toThrow(/immutable/);
  });
});
