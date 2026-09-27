import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../migrate.js';

/**
 * #1 F8a — the `description` and `annotations` columns on an UPGRADING (non-fresh) DB. Applies every
 * committed migration BEFORE 0043 directly, inserts a `pipeline_versions` row,
 * then hands the same connection to `runMigrations`, mirroring an existing
 * installation upgrading into F8a (the `migrate-cx2-runs-cancelled.test.ts`
 * convention). The migration's own header explains why `''`/`'[]'` are the honest
 * backfill.
 */
const MIGRATION = '0043_f8a_pipeline_versions_description_annotations.sql';

describe('0043 migration: description + annotations columns on an upgrading DB', () => {
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
    const pre0043 = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql') && name < '0043')
      .sort();
    for (const file of pre0043) {
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

  it('backfills a pre-0043 row to no description and no annotations', () => {
    const sqlite = upgradingDb();
    expect(runMigrations(sqlite).applied).toContain(MIGRATION);
    const row = sqlite
      .prepare('SELECT description, annotations FROM pipeline_versions WHERE id = ?')
      .get('pv_1') as { description: string; annotations: string };
    expect(row).toEqual({ description: '', annotations: '[]' });
  });

  it('adds both columns as NOT NULL', () => {
    const sqlite = upgradingDb();
    runMigrations(sqlite);
    // `notnull` is a reserved word, hence the quoted identifier.
    const columns = sqlite
      .prepare(
        `SELECT name, "notnull", dflt_value FROM pragma_table_info('pipeline_versions')
         WHERE name IN ('description', 'annotations') ORDER BY name`,
      )
      .all();
    expect(columns).toEqual([
      { name: 'annotations', notnull: 1, dflt_value: `'[]'` },
      { name: 'description', notnull: 1, dflt_value: `''` },
    ]);
  });

  it('leaves pipeline_versions IMMUTABLE — the no-update trigger covers the new columns', () => {
    const sqlite = upgradingDb();
    runMigrations(sqlite);
    // Pinned on the ABORT REASON: before 0043 the same statements throw
    // `no such column`, which a bare `.toThrow()` would accept.
    expect(() =>
      sqlite.prepare('UPDATE pipeline_versions SET description = ? WHERE id = ?').run('x', 'pv_1'),
    ).toThrow(/immutable/);
    expect(() =>
      sqlite.prepare('UPDATE pipeline_versions SET annotations = ? WHERE id = ?').run('[]', 'pv_1'),
    ).toThrow(/immutable/);
  });
});
