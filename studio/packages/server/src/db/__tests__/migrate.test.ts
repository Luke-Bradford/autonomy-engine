import { describe, expect, it } from 'vitest';
import { openDb } from '../client.js';
import { runMigrations } from '../migrate.js';

const EXPECTED_TABLES = [
  'app_meta',
  'connections',
  'pipelines',
  'pipeline_versions',
  'triggers',
  'runs',
  'run_events',
  'secrets',
];

const EXPECTED_INDEXES = [
  'connections_owner_id_idx',
  'pipelines_owner_id_idx',
  'pipeline_versions_pipeline_id_version_idx',
  'pipeline_versions_pipeline_id_idx',
  'triggers_pipeline_version_id_idx',
  'triggers_owner_id_idx',
  'runs_pipeline_version_id_idx',
  'runs_trigger_id_idx',
  'runs_parent_run_id_idx',
  'run_events_run_id_seq_idx',
  'run_events_run_id_idx',
  'secrets_ref_idx',
];

describe('migrations', () => {
  it('applies cleanly on a fresh DB and creates every P1a table', () => {
    const { sqlite } = openDb(':memory:');
    const tableNames = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);

    for (const table of EXPECTED_TABLES) {
      expect(tableNames).toContain(table);
    }
    sqlite.close();
  });

  it('creates every P1a index', () => {
    const { sqlite } = openDb(':memory:');
    const indexNames = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);

    for (const index of EXPECTED_INDEXES) {
      expect(indexNames).toContain(index);
    }
    sqlite.close();
  });

  it('is idempotent: re-running the migration runner against an already-migrated DB applies nothing new', () => {
    const { sqlite } = openDb(':memory:');
    const { applied } = runMigrations(sqlite);
    expect(applied).toEqual([]);
    sqlite.close();
  });

  it('turns foreign_keys ON for the connection (required for FK enforcement in better-sqlite3)', () => {
    const { sqlite } = openDb(':memory:');
    const row = sqlite.pragma('foreign_keys', { simple: true });
    expect(row).toBe(1);
    sqlite.close();
  });
});
