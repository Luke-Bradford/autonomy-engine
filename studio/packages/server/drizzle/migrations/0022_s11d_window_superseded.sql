-- #5 S11d: stale-epoch window DISPOSITION (`window.superseded`).
--
-- Two closed CHECK lists widen — `tumbling_window_state.status` gains
-- `superseded` (a TERMINAL status: old-epoch `waiting`/`retry_pending` debris
-- folded closed by the disposition pass after a geometry edit) and
-- `window_events.type` gains `window.superseded`. No new columns.
--
-- SQLite cannot ALTER a CHECK constraint; both tables use the documented
-- recreate procedure (https://www.sqlite.org/lang_altertable.html#otheralter):
-- CREATE the new shape, copy every row, DROP, RENAME, recreate indexes.
-- `migrate.ts` turns `PRAGMA foreign_keys` OFF around the run (the 0003
-- precedent), so the DROPs do not fire FK actions.
--
-- `window_events.seq` is the FOLD ORDER (`rebuildWindowStatus` scans by it),
-- so the copy carries `seq` EXPLICITLY (the 0021 discipline). The projection
-- copy carries EVERY column — including 0021's `attempt`/`next_attempt_at_ms`
-- (a copy list frozen at 0021's shape would silently reset a mid-retry
-- window's budget count and stored due instant).

-- PART 1 — window_events: widen the type CHECK.
CREATE TABLE window_events_new (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_id TEXT NOT NULL REFERENCES triggers (id) ON DELETE CASCADE,
  config_epoch TEXT NOT NULL,
  window_start TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('window.created', 'window.runCreated', 'window.succeeded', 'window.failed', 'window.retryScheduled', 'window.retryDue', 'window.superseded')),
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

-- PART 2 — tumbling_window_state: widen the status CHECK. Column set is
-- 0021's exactly (origin from 0020, attempt/next_attempt_at_ms from 0021).
CREATE TABLE tumbling_window_state_new (
  trigger_id TEXT NOT NULL REFERENCES triggers (id) ON DELETE CASCADE,
  config_epoch TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'running', 'succeeded', 'failed', 'retry_pending', 'superseded')),
  run_id TEXT,
  origin TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live', 'backfill')),
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (trigger_id, config_epoch, window_start)
);

INSERT INTO tumbling_window_state_new
  (trigger_id, config_epoch, window_start, window_end, status, run_id, origin, attempt, next_attempt_at_ms, updated_at)
SELECT
  trigger_id, config_epoch, window_start, window_end, status, run_id, origin, attempt, next_attempt_at_ms, updated_at
FROM tumbling_window_state;

DROP TABLE tumbling_window_state;

ALTER TABLE tumbling_window_state_new RENAME TO tumbling_window_state;

-- The 0019 indexes, verbatim.
CREATE INDEX IF NOT EXISTS tumbling_window_state_run_id_idx
  ON tumbling_window_state (run_id);
CREATE INDEX IF NOT EXISTS tumbling_window_state_status_idx
  ON tumbling_window_state (status);
