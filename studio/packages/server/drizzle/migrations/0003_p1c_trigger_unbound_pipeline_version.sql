-- P1c: `triggers.pipeline_version_id` becomes NULLABLE.
--
-- A standalone-imported Trigger (see packages/server/src/portability/import.ts)
-- has no pipeline version to bind in the importer's own workspace yet — the
-- exported JSON always nulls `pipelineVersionId` (a cross-workspace version
-- id is meaningless) and the importer re-binds it afterward via the normal
-- `PATCH /api/triggers/:id` route. An "unbound" trigger is otherwise inert:
-- nothing in P1-P3 (no scheduler/executor exists yet) ever reads
-- `pipeline_version_id` to actually fire a run, so this relaxation carries no
-- runtime behavior change beyond allowing the row to exist in that state.
--
-- SQLite has no `ALTER TABLE ... ALTER COLUMN`; the documented recreate
-- procedure (https://www.sqlite.org/lang_altertable.html#otheralter) is used
-- instead: CREATE the new shape, copy every row, DROP the old table, RENAME
-- the new one into place, recreate its indexes.
--
-- `packages/server/src/db/migrate.ts`'s `runMigrations` turns
-- `PRAGMA foreign_keys` OFF around the whole migration run (and back ON
-- after) specifically so this recreate does not trigger the
-- `ON DELETE SET NULL` action `runs.trigger_id` has on this table via the
-- implicit DELETE SQLite performs for `DROP TABLE` while FK enforcement is
-- on — verified empirically: with enforcement on, dropping a table that
-- another table's FK references nulls out every referencing row's FK column,
-- which would otherwise have corrupted `runs.trigger_id` for any run
-- genuinely bound to an existing trigger.

CREATE TABLE triggers_new (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  name TEXT NOT NULL,
  pipeline_version_id TEXT REFERENCES pipeline_versions (id) ON DELETE CASCADE,
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

INSERT INTO triggers_new
  (id, owner_id, name, pipeline_version_id, params, mode, schedule, webhook, concurrency, run_windows, enabled, created_at, updated_at)
SELECT
  id, owner_id, name, pipeline_version_id, params, mode, schedule, webhook, concurrency, run_windows, enabled, created_at, updated_at
FROM triggers;

DROP TABLE triggers;

ALTER TABLE triggers_new RENAME TO triggers;

CREATE INDEX IF NOT EXISTS triggers_pipeline_version_id_idx ON triggers (pipeline_version_id);
CREATE INDEX IF NOT EXISTS triggers_owner_id_idx ON triggers (owner_id);
