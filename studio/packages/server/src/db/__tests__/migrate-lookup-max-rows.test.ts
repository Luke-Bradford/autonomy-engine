import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { getWorkspaceSettings } from '../../repo/workspace-settings.js';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { MIGRATIONS_DIR, runMigrations } from '../migrate.js';
import * as schema from '../schema.js';

/**
 * #1600 OR41 C7d — `workspace_settings.lookup_max_rows` on an UPGRADING DB:
 * every migration before 0048 applied directly, a settings row saved, then
 * `runMigrations` on the same connection (0046's convention).
 */
const MIGRATION = '0048_1600_lookup_max_rows.sql';

describe('0048 migration: lookup_max_rows on an upgrading DB', () => {
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
      .filter((name) => name.endsWith('.sql') && name < '0048')
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
        `INSERT INTO workspace_settings (owner_id, default_activity_timeout_seconds, created_at, updated_at)
         VALUES ('local', 600, 1, 1)`,
      )
      .run();
    return sqlite;
  }

  it('backfills a pre-0048 row to the 1000-row cap every Lookup ran under', () => {
    const sqlite = upgradingDb();
    expect(runMigrations(sqlite).applied).toContain(MIGRATION);
    const db = drizzle({ client: sqlite, schema });
    expect(getWorkspaceSettings(db, 'local')).toEqual({
      settings: { defaultActivityTimeoutSeconds: 600, lookupMaxRows: 1000 },
      stored: true,
    });
  });
});
