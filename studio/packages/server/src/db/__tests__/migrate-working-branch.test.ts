import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { deriveDefaultWorkingBranch } from '@autonomy-studio/shared';
import { MIGRATIONS_DIR, runMigrations } from '../migrate.js';

/**
 * #3 G9a — the `working_branch` column + backfill (0031) on an UPGRADING
 * (non-fresh) DB with `workspace_git` rows that predate the column. Builds the
 * pre-0031 state directly — the 0025 `workspace_git` shape + every migration
 * marked applied EXCEPT 0031 (no migration between 0026-0030 touches
 * `workspace_git`, so this is the faithful pre-0031 table) — inserts rows, then
 * runs the REAL 0031 SQL via `runMigrations`.
 *
 * The backfill must reproduce EXACTLY the value the commit route derived before
 * this slice (`studio/${ownerId}/work`, the runtime SSOT `deriveDefaultWorkingBranch`)
 * so behaviour is unchanged for every already-connected workspace. A NULL owner
 * renders `studio/null/work` (JS `${null}` = "null"; the SQL COALESCEs).
 */
const MIGRATION_0031 = '0031_g9a_working_branch.sql';

describe('0031 migration: working_branch on an upgrading (non-fresh) DB', () => {
  function upgradingDb() {
    const sqlite = new Database(':memory:');
    sqlite.pragma('journal_mode = WAL');
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS __migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    // The pre-0031 workspace_git table (0025 shape — no working_branch column).
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0025_workspace_git.sql'), 'utf8'));
    // Mark every migration EXCEPT 0031 applied, so runMigrations applies only it.
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (file === MIGRATION_0031) continue;
      sqlite
        .prepare('INSERT INTO __migrations (name, applied_at) VALUES (?, ?)')
        .run(file, '2020-01-01T00:00:00.000Z');
    }
    const insert = sqlite.prepare(
      `INSERT INTO workspace_git
         (id, owner_id, repo_url, collab_branch, observed_collab_head, last_fetch_at, last_fetch_error, created_at, updated_at)
       VALUES (?, ?, ?, 'main', NULL, NULL, NULL, 1, 1)`,
    );
    insert.run('wsgit_local', 'local', '/repos/a');
    insert.run('wsgit_null', null, '/repos/b');
    return sqlite;
  }

  it('applies 0031 and backfills working_branch to the previously-derived value', () => {
    const sqlite = upgradingDb();

    const { applied } = runMigrations(sqlite);
    expect(applied).toEqual([MIGRATION_0031]);

    const branchOf = (id: string) =>
      (
        sqlite.prepare('SELECT working_branch FROM workspace_git WHERE id = ?').get(id) as {
          working_branch: string;
        }
      ).working_branch;
    expect(branchOf('wsgit_local')).toBe(deriveDefaultWorkingBranch('local'));
    expect(branchOf('wsgit_local')).toBe('studio/local/work');
    // A NULL owner_id COALESCEs to 'null', matching JS `${null}`.
    expect(branchOf('wsgit_null')).toBe('studio/null/work');
  });

  it('adds working_branch nullable-in-SQL (NOT NULL enforced at the read boundary)', () => {
    const sqlite = upgradingDb();
    runMigrations(sqlite);

    const col = sqlite
      .prepare(
        `SELECT "notnull", dflt_value FROM pragma_table_info('workspace_git') WHERE name = 'working_branch'`,
      )
      .get() as { notnull: number; dflt_value: string | null };
    expect(col.notnull).toBe(0);
    expect(col.dflt_value).toBeNull();
  });
});
