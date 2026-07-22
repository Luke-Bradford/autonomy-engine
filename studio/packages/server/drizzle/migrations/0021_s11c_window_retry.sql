-- #5 S11c: per-trigger tumbling-window RETRY.
--
-- Two closed CHECK lists widen — `tumbling_window_state.status` gains
-- `retry_pending` and `window_events.type` gains `window.retryScheduled` /
-- `window.retryDue` — and the projection gains two columns: `attempt`
-- (retries consumed, 0 for every pre-S11c row — honest: none ever retried)
-- and `next_attempt_at_ms` (the STORED due instant of a pending retry, NULL
-- outside `retry_pending`; the sync/reconcile overdue heal reads it).
--
-- SQLite cannot ALTER a CHECK constraint; both tables use the documented
-- recreate procedure (https://www.sqlite.org/lang_altertable.html#otheralter):
-- CREATE the new shape, copy every row, DROP, RENAME, recreate indexes.
-- `migrate.ts` turns `PRAGMA foreign_keys` OFF around the run (the 0003
-- precedent), so the DROPs do not fire FK actions.
--
-- `window_events.seq` is the FOLD ORDER (`rebuildWindowStatus` scans by it),
-- so the copy carries `seq` EXPLICITLY — an unordered INSERT..SELECT that let
-- SQLite renumber could permute the fold. AUTOINCREMENT's `sqlite_sequence`
-- entry survives: inserting explicit rowids above the stored sequence value
-- advances it, so post-migration appends cannot collide with copied rows.

-- PART 1 — window_events: widen the type CHECK.
CREATE TABLE window_events_new (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_id TEXT NOT NULL REFERENCES triggers (id) ON DELETE CASCADE,
  config_epoch TEXT NOT NULL,
  window_start TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('window.created', 'window.runCreated', 'window.succeeded', 'window.failed', 'window.retryScheduled', 'window.retryDue')),
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO window_events_new
  (seq, trigger_id, config_epoch, window_start, type, payload, created_at)
SELECT
  seq, trigger_id, config_epoch, window_start, type, payload, created_at
FROM window_events;

DROP TABLE window_events;

ALTER TABLE window_events_new RENAME TO window_events;

-- The 0019 indexes, verbatim: the partial UNIQUE single-fire backstop and the
-- fold/rebuild scan index.
CREATE UNIQUE INDEX IF NOT EXISTS window_events_created_once_idx
  ON window_events (trigger_id, config_epoch, window_start)
  WHERE type = 'window.created';
CREATE INDEX IF NOT EXISTS window_events_window_idx
  ON window_events (trigger_id, config_epoch, window_start);

-- PART 2 — tumbling_window_state: widen the status CHECK, add the retry
-- columns. `origin` (added by 0020 as ALTER..ADD COLUMN) is reproduced with
-- its own CHECK and DEFAULT 'live'.
CREATE TABLE tumbling_window_state_new (
  trigger_id TEXT NOT NULL REFERENCES triggers (id) ON DELETE CASCADE,
  config_epoch TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'running', 'succeeded', 'failed', 'retry_pending')),
  run_id TEXT,
  origin TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live', 'backfill')),
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (trigger_id, config_epoch, window_start)
);

INSERT INTO tumbling_window_state_new
  (trigger_id, config_epoch, window_start, window_end, status, run_id, origin, updated_at)
SELECT
  trigger_id, config_epoch, window_start, window_end, status, run_id, origin, updated_at
FROM tumbling_window_state;

DROP TABLE tumbling_window_state;

ALTER TABLE tumbling_window_state_new RENAME TO tumbling_window_state;

-- The 0019 indexes, verbatim.
CREATE INDEX IF NOT EXISTS tumbling_window_state_run_id_idx
  ON tumbling_window_state (run_id);
CREATE INDEX IF NOT EXISTS tumbling_window_state_status_idx
  ON tumbling_window_state (status);
