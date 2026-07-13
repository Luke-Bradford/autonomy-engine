import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrate.js';

/**
 * Regression test for the `PRAGMA foreign_key_check` guard `runMigrations`
 * runs INSIDE each migration's transaction, before recording it in
 * `__migrations` (see `migrate.ts`): while `foreign_keys` is OFF for the
 * pending-migration batch (necessary for the 0003-style table-recreate
 * procedure), a migration that leaves a dangling FK reference behind would
 * otherwise apply silently — enforcement was off, so SQLite never raises at
 * INSERT time. Because the check runs in-transaction, a violation ROLLS BACK
 * the migration (not committed, not marked applied) rather than persisting a
 * bad migration and wedging the app on restart. These tests use a throwaway
 * migrations directory (via `runMigrations`'s `migrationsDir` param) with
 * hand-crafted `.sql` files, so a deliberately bad migration never touches
 * production migration history.
 */
describe('runMigrations: in-transaction foreign_key_check', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    while (createdDirs.length > 0) {
      const dir = createdDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function migrationsDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'migrate-fk-integrity-'));
    createdDirs.push(dir);
    return dir;
  }

  it('throws a clear error naming the offending table/rowid when a migration leaves a dangling FK row', () => {
    const dir = migrationsDir();
    writeFileSync(
      join(dir, '0001_bad.sql'),
      `
        CREATE TABLE parent (id TEXT PRIMARY KEY);
        CREATE TABLE child (
          id TEXT PRIMARY KEY,
          parent_id TEXT REFERENCES parent(id)
        );
        -- foreign_keys is OFF for the whole batch, so this INSERT against a
        -- non-existent parent row succeeds at apply time — exactly the
        -- dangling-reference hazard the post-batch check exists to catch.
        INSERT INTO child (id, parent_id) VALUES ('child_1', 'does_not_exist');
      `,
    );

    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');

    expect(() => runMigrations(sqlite, dir)).toThrow(
      /Migration integrity violation.*table 'child'.*rowid.*references missing row in 'parent'/s,
    );

    // The guarantee: the bad migration is ROLLED BACK, not persisted — it is
    // NOT recorded in `__migrations` (so a corrected migration + restart
    // applies cleanly, rather than the bad one being marked "applied" and
    // skipped forever), and its table changes are gone too (whole txn rolled
    // back). This is what makes "fails loudly instead of persisting" true.
    const recorded = sqlite.prepare('SELECT COUNT(*) AS n FROM __migrations').get() as {
      n: number;
    };
    expect(recorded.n).toBe(0);
    const childTable = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='child'")
      .get();
    expect(childTable).toBeUndefined();

    sqlite.close();
  });

  it('a clean migration batch (no dangling refs) still applies successfully', () => {
    const dir = migrationsDir();
    writeFileSync(
      join(dir, '0001_clean.sql'),
      `
        CREATE TABLE parent (id TEXT PRIMARY KEY);
        CREATE TABLE child (
          id TEXT PRIMARY KEY,
          parent_id TEXT REFERENCES parent(id)
        );
        INSERT INTO parent (id) VALUES ('parent_1');
        INSERT INTO child (id, parent_id) VALUES ('child_1', 'parent_1');
      `,
    );

    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');

    const { applied } = runMigrations(sqlite, dir);
    expect(applied).toEqual(['0001_clean.sql']);

    const child = sqlite.prepare('SELECT parent_id FROM child WHERE id = ?').get('child_1') as {
      parent_id: string;
    };
    expect(child.parent_id).toBe('parent_1');

    sqlite.close();
  });
});
