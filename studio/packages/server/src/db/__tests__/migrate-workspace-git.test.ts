import { describe, expect, it } from 'vitest';
import { freshDb } from '../../repo/__tests__/helpers.js';

/**
 * #3 G2 — the `workspace_git` table (0025). A NEW table (no upgrade
 * hazard/backfill — nothing existed before it), so the pins here are the
 * shape guarantees the repo layer + routes stand on: the columns exist with
 * the right nullability, and the OWNER-scoped uniqueness ("ONE repo per
 * owner in v1") is enforced by the DB, not just by the route's pre-check
 * (which a concurrent connect could race past).
 */
describe('0025 migration: workspace_git', () => {
  it('creates the table with the expected columns and nullability', () => {
    const { sqlite } = freshDb();
    const cols = sqlite.prepare('PRAGMA table_info(workspace_git)').all() as {
      name: string;
      notnull: number;
    }[];
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect([...byName.keys()].sort()).toEqual([
      'collab_branch',
      'created_at',
      'id',
      'last_fetch_at',
      'last_fetch_error',
      'observed_collab_head',
      'owner_id',
      'repo_url',
      'updated_at',
      'working_branch',
    ]);
    // Tracking fields are genuinely nullable (null = "not observed", stated
    // honestly — #473); the config fields are NOT NULL (a new table can say so
    // directly, no ADD COLUMN sentinel hazard). `working_branch` (#3 G9a, added
    // by 0031) is nullable IN SQL (ADD COLUMN + backfill; NOT NULL is enforced
    // at the read boundary, the `secret_status` posture) — see the 0031 test.
    expect(byName.get('repo_url')!.notnull).toBe(1);
    expect(byName.get('collab_branch')!.notnull).toBe(1);
    expect(byName.get('observed_collab_head')!.notnull).toBe(0);
    expect(byName.get('last_fetch_at')!.notnull).toBe(0);
    expect(byName.get('last_fetch_error')!.notnull).toBe(0);
    expect(byName.get('working_branch')!.notnull).toBe(0);
  });

  it('enforces ONE row per owner at the DB (unique index, not just the route pre-check)', () => {
    const { sqlite } = freshDb();
    const insert = sqlite.prepare(
      `INSERT INTO workspace_git
         (id, owner_id, repo_url, collab_branch, observed_collab_head, last_fetch_at, last_fetch_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, 1, 1)`,
    );
    insert.run('wsgit_1', 'local', '/repos/a', 'main');
    expect(() => insert.run('wsgit_2', 'local', '/repos/b', 'main')).toThrow(/UNIQUE/);
    // A different owner is fine — the uniqueness is owner-scoped.
    insert.run('wsgit_3', 'other', '/repos/a', 'main');
  });
});
