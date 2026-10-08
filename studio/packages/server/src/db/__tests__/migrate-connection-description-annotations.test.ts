import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../migrate.js';

/**
 * #1477 — a connection's `description` and `annotations` columns on an
 * UPGRADING DB: every migration before 0046 applied directly, a `connections`
 * row inserted, then `runMigrations` on the same connection (the
 * `migrate-description-annotations-columns.test.ts` convention).
 */
const MIGRATION = '0046_1477_connection_description_annotations.sql';

describe('0046 migration: connection description + annotations on an upgrading DB', () => {
  function upgradingDb() {
    const sqlite = new Database(':memory:');
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = OFF');
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS __migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const pre = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql') && name < '0046')
      .sort();
    for (const file of pre) {
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      sqlite
        .prepare('INSERT INTO __migrations (name, applied_at) VALUES (?, ?)')
        .run(file, new Date().toISOString());
    }
    sqlite.pragma('foreign_keys = ON');
    sqlite
      .prepare(
        `INSERT INTO connections (id, owner_id, name, kind, config, created_at, updated_at)
         VALUES (?, NULL, ?, 'http', '{}', 1, 1)`,
      )
      .run('conn_1', 'API');
    return sqlite;
  }

  it('backfills a pre-0046 row to no description and no annotations', () => {
    const sqlite = upgradingDb();
    expect(runMigrations(sqlite).applied).toContain(MIGRATION);
    const row = sqlite
      .prepare('SELECT description, annotations FROM connections WHERE id = ?')
      .get('conn_1') as { description: string; annotations: string };
    expect(row).toEqual({ description: '', annotations: '[]' });
  });

  it('adds both columns as NOT NULL', () => {
    const sqlite = upgradingDb();
    runMigrations(sqlite);
    const columns = sqlite
      .prepare(
        `SELECT name, "notnull", dflt_value FROM pragma_table_info('connections')
         WHERE name IN ('description', 'annotations') ORDER BY name`,
      )
      .all();
    expect(columns).toEqual([
      { name: 'annotations', notnull: 1, dflt_value: `'[]'` },
      { name: 'description', notnull: 1, dflt_value: `''` },
    ]);
  });
});
