import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../migrate.js';

/**
 * #3 G8a — the `secret_status` + `enabled` columns on an UPGRADING (non-fresh)
 * DB. Replays the REAL, committed 0001+0002 SQL directly onto a fresh in-memory
 * DB — bypassing `runMigrations` so `connections` rows can exist BEFORE 0030
 * runs, mirroring an existing installation upgrading into this branch — then
 * hands the SAME connection to `runMigrations`. Mirrors
 * `migrate-archived-column.test.ts`.
 *
 * `enabled` backfills to true (every pre-G8 connection was usable — a truthful
 * NOT NULL default, not a manufactured absent value, #473). `secret_status` is
 * DERIVED per row by the migration's CASE and must match `deriveSecretStatus`:
 * a present `secret_ref` ⟹ ready; a secret-requiring kind with none ⟹
 * needs_secret; any other kind ⟹ not_required.
 */
describe('0030 migration: connection secret-readiness on an upgrading (non-fresh) DB', () => {
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
    // A secret the "ready" connection points at (FK RESTRICT, so a non-null
    // secret_ref always resolves — the migration's `ready` shortcut).
    sqlite
      .prepare('INSERT INTO secrets (id, ref, ciphertext, created_at) VALUES (?, ?, ?, 1)')
      .run('sec_1', 'ref_1', 'blob');
    const insertConn = sqlite.prepare(
      `INSERT INTO connections (id, owner_id, name, kind, config, secret_ref, created_at, updated_at)
       VALUES (?, NULL, ?, ?, '{}', ?, 1, 1)`,
    );
    insertConn.run('conn_ready', 'has-secret', 'anthropic_api', 'ref_1');
    insertConn.run('conn_needs', 'no-secret', 'openai_api', null);
    insertConn.run('conn_notreq', 'credential-less', 'http', null);
    return sqlite;
  }

  it('backfills secret_status by the same rule deriveSecretStatus uses', () => {
    const sqlite = upgradingDb();

    const { applied } = runMigrations(sqlite);
    expect(applied).toContain('0030_g8a_connection_secret_readiness.sql');

    const statusOf = (id: string) =>
      (
        sqlite.prepare('SELECT secret_status FROM connections WHERE id = ?').get(id) as {
          secret_status: string;
        }
      ).secret_status;
    expect(statusOf('conn_ready')).toBe('ready'); // secret_ref present
    expect(statusOf('conn_needs')).toBe('needs_secret'); // secret-requiring kind, none
    expect(statusOf('conn_notreq')).toBe('not_required'); // credential-less kind
  });

  it('backfills enabled to true (1) — a truthful default, never NULL', () => {
    const sqlite = upgradingDb();
    runMigrations(sqlite);

    const rows = sqlite.prepare('SELECT enabled FROM connections').all() as { enabled: number }[];
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.enabled).toBe(1);
  });

  it('adds enabled NOT NULL DEFAULT 1; secret_status nullable-in-SQL (Zod-enforced NOT NULL)', () => {
    const sqlite = upgradingDb();
    runMigrations(sqlite);

    const enabled = sqlite
      .prepare(
        `SELECT "notnull", dflt_value FROM pragma_table_info('connections') WHERE name = 'enabled'`,
      )
      .get() as { notnull: number; dflt_value: string };
    expect(enabled.notnull).toBe(1);
    expect(enabled.dflt_value).toBe('1');

    const status = sqlite
      .prepare(
        `SELECT "notnull", dflt_value FROM pragma_table_info('connections') WHERE name = 'secret_status'`,
      )
      .get() as { notnull: number; dflt_value: string | null };
    expect(status.notnull).toBe(0);
    expect(status.dflt_value).toBeNull();
  });
});
