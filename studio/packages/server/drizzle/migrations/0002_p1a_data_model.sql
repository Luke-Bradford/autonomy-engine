-- P1a data model: Connection, Pipeline + immutable PipelineVersion, Trigger,
-- Run, run_events (append-only), Secret. Mirrors packages/server/src/db/schema.ts
-- and the Zod schemas in packages/shared/src/schemas/.
--
-- UNSHIPPED (this branch only) — edited in place per P1a review fixes rather
-- than layered as a follow-up migration:
--   * connections.secret_ref FK -> secrets(ref) ON DELETE RESTRICT (forward
--     reference to a table created later in this file — SQLite only checks
--     FK existence at DML time, not CREATE TABLE time, so this is fine).
--   * CHECK constraints mirroring the Zod enum vocab (defense-in-depth: Zod
--     validates on read, the DB now refuses the write) for every plain
--     enum/boolean column. `edge.on` and `concurrency.policy` are NOT
--     column-level (they live inside JSON blobs: pipeline_versions.edges,
--     triggers.concurrency), so there's no CHECK to add for them here.
--   * Immutability triggers for pipeline_versions and run_events. The DELETE
--     triggers carry a `WHEN` guard rather than being unconditional: SQLite
--     fires a child table's BEFORE DELETE trigger for a cascaded delete too
--     (verified empirically), and the sanctioned cleanup path for both
--     tables IS a cascade from a deleted parent row (pipelines -> cascade
--     pipeline_versions; runs -> cascade run_events) — by the time that
--     cascade fires, the parent row is already gone, so `WHEN (parent still
--     exists)` distinguishes "someone is trying to mutate/delete this row
--     directly while its parent is still alive" (blocked) from "this row is
--     being cleaned up as part of its parent's sanctioned deletion"
--     (allowed). BEFORE UPDATE triggers stay unconditional — neither table
--     has any legitimate cascade-triggered UPDATE path.
--   * runs.status / runs.owner_id / runs.started_at indexes.

CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('anthropic_api', 'openai_api', 'ollama', 'agent_cli', 'http')),
  config TEXT NOT NULL,
  secret_ref TEXT REFERENCES secrets (ref) ON DELETE RESTRICT,
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

-- IMMUTABLE: no update path exists in the repository layer (see
-- repo/pipeline-versions.ts) — this trigger defends the invariant at the DB
-- itself against a raw `db.update(pipelineVersions)...` bypassing the repo.
CREATE TRIGGER IF NOT EXISTS pipeline_versions_no_update
BEFORE UPDATE ON pipeline_versions
BEGIN
  SELECT RAISE(ABORT, 'pipeline_versions are immutable: update is not allowed');
END;

-- Direct/standalone delete is blocked; deleting the parent `pipelines` row
-- (which cascades) is the sanctioned cleanup path (see the header note and
-- repo/pipeline-versions.ts) and remains possible because by the time this
-- cascade fires the parent pipeline row no longer exists.
CREATE TRIGGER IF NOT EXISTS pipeline_versions_no_direct_delete
BEFORE DELETE ON pipeline_versions
WHEN (SELECT COUNT(*) FROM pipelines WHERE id = OLD.pipeline_id) > 0
BEGIN
  SELECT RAISE(ABORT, 'pipeline_versions are immutable: delete the parent pipeline instead');
END;

CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  name TEXT NOT NULL,
  pipeline_version_id TEXT NOT NULL REFERENCES pipeline_versions (id) ON DELETE CASCADE,
  params TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('manual', 'schedule', 'webhook', 'event', 'continuous')),
  schedule TEXT,
  webhook TEXT,
  concurrency TEXT NOT NULL,
  run_windows TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
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
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'running', 'success', 'failure', 'skipped', 'waiting', 'interrupted')
  ),
  lease_until INTEGER,
  heartbeat_at INTEGER,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS runs_pipeline_version_id_idx ON runs (pipeline_version_id);
CREATE INDEX IF NOT EXISTS runs_trigger_id_idx ON runs (trigger_id);
CREATE INDEX IF NOT EXISTS runs_parent_run_id_idx ON runs (parent_run_id);
-- `status`: the boot-reconciler's "find all running rows" scan. `owner_id`:
-- per-owner run listing. `started_at`: time-ordered listing.
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs (status);
CREATE INDEX IF NOT EXISTS runs_owner_id_idx ON runs (owner_id);
CREATE INDEX IF NOT EXISTS runs_started_at_idx ON runs (started_at);

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

-- APPEND-ONLY: no update/delete path exists in the repository layer (see
-- repo/run-events.ts) — same defense-in-depth rationale as pipeline_versions
-- above, and the same direct-vs-cascade distinction: deleting the parent
-- `runs` row (which cascades) is the sanctioned way an entire run's event
-- history goes away; a standalone delete/update of one event while its run
-- still exists is not.
CREATE TRIGGER IF NOT EXISTS run_events_no_update
BEFORE UPDATE ON run_events
BEGIN
  SELECT RAISE(ABORT, 'run_events are append-only: update is not allowed');
END;

CREATE TRIGGER IF NOT EXISTS run_events_no_direct_delete
BEFORE DELETE ON run_events
WHEN (SELECT COUNT(*) FROM runs WHERE id = OLD.run_id) > 0
BEGIN
  SELECT RAISE(ABORT, 'run_events are append-only: delete the parent run instead');
END;

CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS secrets_ref_idx ON secrets (ref);
