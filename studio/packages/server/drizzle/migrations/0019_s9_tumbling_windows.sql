-- #5 S9 — tumbling-window trigger: the `tumbling` mode + `window` config
-- column on `triggers`, the window-domain EVENT LOG (`window_events`, the
-- truth), and the materialized state PROJECTION (`tumbling_window_state`).
-- Full rationale: the scheduler-lifecycle spec §S3/S9 + its codex-hardened
-- window block ("Tumbling state = projection, not truth. Window lifecycle is
-- domain events; the `tumbling_window_state` table is a materialized
-- projection with uniqueness.").
--
-- PART 1 — recreate `triggers`. A native ADD COLUMN cannot widen the `mode`
-- CHECK constraint (SQLite has no ALTER for CHECKs — the same reason 0017
-- chose an ADD COLUMN shape and 0003 did this recreate), so the documented
-- recreate procedure is used: CREATE the new shape, copy, DROP, RENAME,
-- recreate indexes. `runMigrations` turns `PRAGMA foreign_keys` OFF around the
-- batch, so the DROP does not fire `runs.trigger_id`'s ON DELETE SET NULL /
-- `webhook_deliveries.trigger_id`'s CASCADE (verified empirically in 0003 —
-- with enforcement on, dropping a referenced table corrupts referencing rows).
--
-- `window` is nullable with NO default, exactly like `recurrence` (0010) and
-- `event` (0018): NULL is the HONEST value for every existing row — a
-- non-tumbling trigger has no window geometry. Never a manufactured `{}`
-- (contrast #473's fail-open `.default([])`).

CREATE TABLE triggers_new (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  name TEXT NOT NULL,
  pipeline_version_id TEXT REFERENCES pipeline_versions (id) ON DELETE CASCADE,
  params TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('manual', 'schedule', 'webhook', 'event', 'continuous', 'tumbling')),
  schedule TEXT,
  recurrence TEXT,
  webhook TEXT,
  event TEXT,
  window TEXT,
  concurrency TEXT NOT NULL,
  run_windows TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO triggers_new
  (id, owner_id, name, pipeline_version_id, params, mode, schedule, recurrence, webhook, event, concurrency, run_windows, enabled, created_at, updated_at)
SELECT
  id, owner_id, name, pipeline_version_id, params, mode, schedule, recurrence, webhook, event, concurrency, run_windows, enabled, created_at, updated_at
FROM triggers;

DROP TABLE triggers;

ALTER TABLE triggers_new RENAME TO triggers;

CREATE INDEX IF NOT EXISTS triggers_pipeline_version_id_idx ON triggers (pipeline_version_id);
CREATE INDEX IF NOT EXISTS triggers_owner_id_idx ON triggers (owner_id);

-- PART 2 — the window-domain event log (the TRUTH for window lifecycle). The
-- codex-hardened window key `(triggerId, configEpoch, windowStart)` rides the
-- ROW as columns (`config_epoch` = the server-computed hash of the geometry
-- tuple (frequency, interval, startTime); `interval` is inside the hash);
-- each event's payload carries only what its type adds (`window.created`
-- snapshots the full geometry so an old epoch stays rebuildable after a
-- config edit). `seq` (rowid alias) is the global append order — the fold
-- order for rebuilds. ON DELETE CASCADE: deleting a trigger deletes its
-- window history, symmetric with `webhook_deliveries` and (part 3) the
-- projection, so a rebuild can never resurrect rows for a gone trigger.
CREATE TABLE IF NOT EXISTS window_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_id TEXT NOT NULL REFERENCES triggers (id) ON DELETE CASCADE,
  config_epoch TEXT NOT NULL,
  window_start TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('window.created', 'window.runCreated', 'window.succeeded', 'window.failed')),
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- SINGLE-FIRE at the event level: a window is CREATED exactly once per
-- `(trigger, epoch, windowStart)` — the hard uniqueness backstop beneath the
-- projection's own UNIQUE key (a partial index, so the lifecycle events that
-- legitimately repeat per window are untouched).
CREATE UNIQUE INDEX IF NOT EXISTS window_events_created_once_idx
  ON window_events (trigger_id, config_epoch, window_start)
  WHERE type = 'window.created';

-- Fold/rebuild scan: one window's events in append order.
CREATE INDEX IF NOT EXISTS window_events_window_idx
  ON window_events (trigger_id, config_epoch, window_start);

-- PART 3 — the materialized projection (rebuildable from `window_events`;
-- UNIQUE on the window key). `run_id` is BARE (no FK) like
-- `webhook_deliveries.run_id`: a window outlives its run row's lifecycle and
-- the link is provenance, not integrity. `trigger_id` cascades WITH the
-- events (finding: an FK-less projection would orphan rows the cascaded log
-- could no longer rebuild).
CREATE TABLE IF NOT EXISTS tumbling_window_state (
  trigger_id TEXT NOT NULL REFERENCES triggers (id) ON DELETE CASCADE,
  config_epoch TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'running', 'succeeded', 'failed')),
  run_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (trigger_id, config_epoch, window_start)
);

-- Completion tap: resolve a terminalized run back to its window.
CREATE INDEX IF NOT EXISTS tumbling_window_state_run_id_idx
  ON tumbling_window_state (run_id);

-- Reconcile/stranded scans: non-terminal windows per trigger.
CREATE INDEX IF NOT EXISTS tumbling_window_state_status_idx
  ON tumbling_window_state (status);
