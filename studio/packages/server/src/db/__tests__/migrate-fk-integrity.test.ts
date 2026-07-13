import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrate.js';

/**
 * Regression test for the `PRAGMA foreign_key_check` guard `runMigrations`
 * runs after applying a batch (see `migrate.ts`): while `foreign_keys` is
 * OFF for the whole pending-migration batch (necessary for the 0003-style
 * table-recreate procedure), a migration that leaves a dangling FK reference
 * behind would otherwise apply silently — enforcement was off, so SQLite
 * never raises at INSERT time. These tests use a throwaway migrations
 * directory (via `runMigrations`'s `migrationsDir` param) with hand-crafted
 * `.sql` files, rather than the real `drizzle/migrations`, so a deliberately
 * bad migration never touches production migration history.
 */
describe('runMigrations: post-batch foreign_key_check', () => {
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
