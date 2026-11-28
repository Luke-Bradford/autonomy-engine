import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RUN_CAPTURE } from '@autonomy-studio/shared';
import { getWorkspaceSettings } from '../../repo/workspace-settings.js';
import { MIGRATIONS_DIR, runMigrations } from '../migrate.js';
import * as schema from '../schema.js';

/**
 * #1567 OR36 A4 — `workspace_settings.run_capture` on an UPGRADING DB: every
 * migration before 0051 applied directly, a settings row saved, then
 * `runMigrations` on the same connection (0048's convention). The column's SQL
 * default must be `DEFAULT_RUN_CAPTURE`, or an upgraded workspace would read
 * different caps from one that never saved.
 */
const MIGRATION = '0051_1567_run_capture.sql';

describe('0051 migration: run_capture on an upgrading DB', () => {
  it('backfills a saved row to the documented default', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = OFF');
    sqlite.exec(
      'CREATE TABLE IF NOT EXISTS __migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);',
    );
    const pre = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql') && name < '0051')
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
        `INSERT INTO workspace_settings (owner_id, default_activity_timeout_seconds, lookup_max_rows, created_at, updated_at)
         VALUES ('local', 600, 250, 1, 1)`,
      )
      .run();

    expect(runMigrations(sqlite).applied).toContain(MIGRATION);
    const db = drizzle({ client: sqlite, schema });
    expect(getWorkspaceSettings(db, 'local')).toEqual({
      settings: {
        defaultActivityTimeoutSeconds: 600,
        lookupMaxRows: 250,
        runCapture: DEFAULT_RUN_CAPTURE,
      },
      stored: true,
    });
  });
});
