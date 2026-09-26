-- CX2 (#1320): widen `runs.status` to accept `'cancelled'`.
--
-- CX1 made `cancelled` a terminal run status and outcome (spec
-- `2026-09-26-foundation-run-cancellation.md` D1), and `syncRunLifecycle` writes
-- the folded status onto the row verbatim. Without this widening, the first run
-- to finish `cancelled` fails its row write on the CHECK constraint.
--
-- SQLite cannot ALTER a CHECK, so this is the same documented table-recreate
-- 0015 performed. Read 0015's header for the reasoning behind each step
-- (`legacy_alter_table`, the `run_events` delete trigger that references `runs`,
-- and the `foreign_key_check` the runner does inside the transaction). The one
-- difference is the column set: 0015 predates `rerun_of` (0034), which is carried
-- here with its self-referencing `ON DELETE SET NULL` FK and its index, so all
-- SEVEN indexes are recreated.
--
-- Forward-only and widening: every existing row already satisfies the new CHECK.

PRAGMA legacy_alter_table = ON;

CREATE TABLE runs_new (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  pipeline_version_id TEXT NOT NULL REFERENCES pipeline_versions (id) ON DELETE RESTRICT,
  trigger_id TEXT REFERENCES triggers (id) ON DELETE SET NULL,
  parent_run_id TEXT REFERENCES runs (id) ON DELETE SET NULL,
  params TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'pending', 'queued', 'running', 'success', 'failure', 'skipped', 'waiting',
      'interrupted', 'cancelled'
    )
  ),
  lease_until INTEGER,
  heartbeat_at INTEGER,
  queued_at INTEGER,
  trigger_context TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  rerun_of TEXT REFERENCES runs (id) ON DELETE SET NULL
);

INSERT INTO runs_new
  (id, owner_id, pipeline_version_id, trigger_id, parent_run_id, params, status,
   lease_until, heartbeat_at, queued_at, trigger_context, started_at, finished_at, rerun_of)
SELECT
  id, owner_id, pipeline_version_id, trigger_id, parent_run_id, params, status,
  lease_until, heartbeat_at, queued_at, trigger_context, started_at, finished_at, rerun_of
FROM runs;

DROP TABLE runs;

ALTER TABLE runs_new RENAME TO runs;

CREATE INDEX IF NOT EXISTS runs_pipeline_version_id_idx ON runs (pipeline_version_id);
CREATE INDEX IF NOT EXISTS runs_trigger_id_idx ON runs (trigger_id);
CREATE INDEX IF NOT EXISTS runs_parent_run_id_idx ON runs (parent_run_id);
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs (status);
CREATE INDEX IF NOT EXISTS runs_owner_id_idx ON runs (owner_id);
CREATE INDEX IF NOT EXISTS runs_started_at_idx ON runs (started_at);
CREATE INDEX IF NOT EXISTS runs_rerun_of_idx ON runs (rerun_of);

PRAGMA legacy_alter_table = OFF;
