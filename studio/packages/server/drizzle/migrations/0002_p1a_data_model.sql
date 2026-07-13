-- P1a data model: Connection, Pipeline + immutable PipelineVersion, Trigger,
-- Run, run_events (append-only), Secret. Mirrors packages/server/src/db/schema.ts
-- and the Zod schemas in packages/shared/src/schemas/.

CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  config TEXT NOT NULL,
  secret_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS connections_owner_id_idx ON connections (owner_id);

CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pipelines_owner_id_idx ON pipelines (owner_id);

CREATE TABLE IF NOT EXISTS pipeline_versions (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES pipelines (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  params TEXT NOT NULL,
  outputs TEXT NOT NULL,
  nodes TEXT NOT NULL,
  edges TEXT NOT NULL,
  catalog_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_versions_pipeline_id_version_idx
  ON pipeline_versions (pipeline_id, version);
CREATE INDEX IF NOT EXISTS pipeline_versions_pipeline_id_idx ON pipeline_versions (pipeline_id);

CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  name TEXT NOT NULL,
  pipeline_version_id TEXT NOT NULL REFERENCES pipeline_versions (id) ON DELETE CASCADE,
  params TEXT NOT NULL,
  mode TEXT NOT NULL,
  schedule TEXT,
  webhook TEXT,
  concurrency TEXT NOT NULL,
  run_windows TEXT,
  enabled INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS triggers_pipeline_version_id_idx ON triggers (pipeline_version_id);
CREATE INDEX IF NOT EXISTS triggers_owner_id_idx ON triggers (owner_id);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  pipeline_version_id TEXT NOT NULL REFERENCES pipeline_versions (id) ON DELETE RESTRICT,
  trigger_id TEXT REFERENCES triggers (id) ON DELETE SET NULL,
  parent_run_id TEXT REFERENCES runs (id) ON DELETE SET NULL,
  params TEXT NOT NULL,
  status TEXT NOT NULL,
  lease_until INTEGER,
  heartbeat_at INTEGER,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS runs_pipeline_version_id_idx ON runs (pipeline_version_id);
CREATE INDEX IF NOT EXISTS runs_trigger_id_idx ON runs (trigger_id);
CREATE INDEX IF NOT EXISTS runs_parent_run_id_idx ON runs (parent_run_id);

CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS run_events_run_id_seq_idx ON run_events (run_id, seq);
CREATE INDEX IF NOT EXISTS run_events_run_id_idx ON run_events (run_id);

CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS secrets_ref_idx ON secrets (ref);
