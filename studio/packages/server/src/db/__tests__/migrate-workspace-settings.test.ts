import { describe, expect, it } from 'vitest';
import { freshDb } from '../../repo/__tests__/helpers.js';

/**
 * #1600 OR41 C0f — the `workspace_settings` table (0047). A new table, so the
 * pins are the shape the repo stands on: one row per owner, enforced by the key,
 * and a timeout that may be NULL (the default turned off) but never zero.
 */
describe('0047 migration: workspace_settings', () => {
  it('creates the table keyed by owner, with a nullable timeout', () => {
    const { sqlite } = freshDb();
    const cols = sqlite.prepare('PRAGMA table_info(workspace_settings)').all() as {
      name: string;
      notnull: number;
      pk: number;
    }[];
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect([...byName.keys()].sort()).toEqual([
      'created_at',
      'default_activity_timeout_seconds',
      'lookup_max_rows',
      'owner_id',
      'updated_at',
    ]);
    expect(byName.get('owner_id')!.pk).toBe(1);
    expect(byName.get('owner_id')!.notnull).toBe(1);
    expect(byName.get('default_activity_timeout_seconds')!.notnull).toBe(0);
    // #1600 C7d (0048) — the Lookup ceiling always has a value.
    expect(byName.get('lookup_max_rows')!.notnull).toBe(1);
  });

  it('refuses a second row for one owner, a NULL owner and a non-positive timeout', () => {
    const { sqlite } = freshDb();
    const insert = sqlite.prepare(
      'INSERT INTO workspace_settings (owner_id, default_activity_timeout_seconds, created_at, updated_at) VALUES (?, ?, 1, 1)',
    );
    insert.run('local', 60);
    expect(() => insert.run('local', 120)).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(() => insert.run(null, 60)).toThrow(/NOT NULL/);
    expect(() => insert.run('other', 0)).toThrow(/CHECK/);
    insert.run('third', null);
    expect(
      sqlite.prepare('SELECT lookup_max_rows FROM workspace_settings WHERE owner_id = ?').get('third'),
    ).toEqual({ lookup_max_rows: 1000 });
    expect(() =>
      sqlite
        .prepare(
          'INSERT INTO workspace_settings (owner_id, lookup_max_rows, created_at, updated_at) VALUES (?, 0, 1, 1)',
        )
        .run('fourth'),
    ).toThrow(/CHECK/);
  });
});
