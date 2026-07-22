-- #5 S6a: durable admission QUEUE — widen `runs.status` to accept `'queued'`
-- and add the two columns a durably-queued fire carries.
--
-- The launcher's admission queue was an IN-MEMORY per-trigger FIFO (a process
-- crash silently dropped every queued fire). S6a makes it durable: an overflow
-- fire becomes a `runs` row with `status = 'queued'`, a `queued_at` FIFO key,
-- and the frozen fire-time `trigger_context` (so a delayed admission still seeds
-- `${trigger.scheduledTime}` with the occurrence that fired it). On admission the
-- launcher re-stamps `started_at`, flips the row to `pending`, and drives it.
--
-- A `queued` run is modelled as a ROW STATUS on `runs`, not a separate
-- `run_queue` table. A queue table would avoid this CHECK rebuild, but the durable
-- fire already IS a nascent run: it carries the run's `params`, `owner_id`,
-- `pipeline_version_id`, and `trigger_context`, and admission is a single in-place
-- UPDATE (`queued → pending`) that lets `startRun`/the boot reconciler reuse the
-- `runs` shape verbatim rather than copy a row across tables. It also matches the
-- spec's "durable `queuedAt`" phrasing and keeps `queued` a first-class run
-- lifecycle status (`pending → queued → running → …`). The cost is this one-time
-- table rebuild.
--
-- `runs.status`'s vocab is a SQL CHECK (0002), and SQLite has no
-- `ALTER TABLE ... ALTER CONSTRAINT`, so the documented table-recreate procedure
-- (https://www.sqlite.org/lang_altertable.html#otheralter) is used: CREATE the
-- new shape with the widened CHECK + the two new columns, copy every row, DROP
-- the old table, RENAME the new one into place, recreate ALL SIX indexes.
--
-- `runMigrations` (packages/server/src/db/migrate.ts) runs this with
-- `PRAGMA foreign_keys = OFF` and a `PRAGMA foreign_key_check` inside the same
-- transaction, which ROLLS BACK the whole migration if the recreate leaves any
-- dangling reference. `runs` is harder to rebuild than `connections`/`triggers`
-- were:
--   * FOUR things FK-reference `runs` — `run_events.run_id` (CASCADE),
--     `run_diagnostics.run_id` (CASCADE), `external_waits.run_id` (CASCADE), and
--     `runs.parent_run_id` (self-ref, SET NULL). With `foreign_keys` OFF the
--     `DROP TABLE runs` performs no cascade, so the children's rows are
--     untouched; each child's FK is stored by table NAME and re-binds to the
--     recreated `runs` after the RENAME (confirmed by the end-of-migration
--     `foreign_key_check`).
--   * The SELF-reference: `runs_new.parent_run_id REFERENCES runs (id)` names the
--     FINAL table name. It resolves to the old `runs` at CREATE time (still
--     present), and after DROP-old + RENAME `runs_new -> runs` it correctly
--     self-references the recreated table — the standard self-referential form of
--     the recreate procedure. The `foreign_key_check` proves no `parent_run_id`
--     is left dangling.
--   * `lease_until` / `heartbeat_at` (#5 S4) are preserved verbatim.
--
-- `PRAGMA legacy_alter_table` — REQUIRED here, and `runs` is the first table this
-- repo rebuilds that a TRIGGER body references. With the modern default (OFF),
-- `ALTER TABLE runs_new RENAME TO runs` reparses every schema object that could
-- reference the table, INCLUDING `run_events_no_direct_delete`, whose `WHEN`
-- clause reads `FROM runs`. Between `DROP TABLE runs` and the RENAME that
-- recreates it, `runs` does not exist, so that reparse throws
-- "no such table: main.runs" and the whole migration fails (confirmed
-- empirically). Turning `legacy_alter_table` ON for the recreate suppresses the
-- reparse (the SQLite-documented escape hatch for exactly this case); the
-- trigger still names `runs`, which the RENAME restores, so it keeps guarding
-- correctly afterwards. Restored to OFF at the end so nothing else is affected —
-- unlike `foreign_keys`, this pragma is NOT a no-op inside the migration's
-- transaction.
PRAGMA legacy_alter_table = ON;

CREATE TABLE runs_new (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  pipeline_version_id TEXT NOT NULL REFERENCES pipeline_versions (id) ON DELETE RESTRICT,
  trigger_id TEXT REFERENCES triggers (id) ON DELETE SET NULL,
  parent_run_id TEXT REFERENCES runs (id) ON DELETE SET NULL,
  params TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'queued', 'running', 'success', 'failure', 'skipped', 'waiting', 'interrupted')
  ),
  lease_until INTEGER,
  heartbeat_at INTEGER,
  queued_at INTEGER,
  trigger_context TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

-- `queued_at` / `trigger_context` are absent from the copy list, so every
-- existing row gets SQLite's column default (NULL) — correct: no historical run
-- was ever queued, and a started run's trigger context lives in its event log.
INSERT INTO runs_new
  (id, owner_id, pipeline_version_id, trigger_id, parent_run_id, params, status,
   lease_until, heartbeat_at, started_at, finished_at)
SELECT
  id, owner_id, pipeline_version_id, trigger_id, parent_run_id, params, status,
  lease_until, heartbeat_at, started_at, finished_at
FROM runs;

DROP TABLE runs;

ALTER TABLE runs_new RENAME TO runs;

CREATE INDEX IF NOT EXISTS runs_pipeline_version_id_idx ON runs (pipeline_version_id);
CREATE INDEX IF NOT EXISTS runs_trigger_id_idx ON runs (trigger_id);
CREATE INDEX IF NOT EXISTS runs_parent_run_id_idx ON runs (parent_run_id);
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs (status);
CREATE INDEX IF NOT EXISTS runs_owner_id_idx ON runs (owner_id);
CREATE INDEX IF NOT EXISTS runs_started_at_idx ON runs (started_at);

PRAGMA legacy_alter_table = OFF;
