-- #5 S10 — tumbling-window bounded BACKFILL: the durable cursor + the window
-- ORIGIN discriminator.
--
-- PART 1 — the durable backfill cursor, one row per (trigger, config epoch).
-- `cursor_ms` is the EXCLUSIVE disposition boundary: every window of that
-- epoch with `windowStart < cursor_ms` is DISPOSITIONED — either created (a
-- `tumbling_window_state` row exists) or deliberately skipped (beyond the
-- `maxBackfillWindows` lookback) — and must NEVER be re-created or re-armed.
-- This cursor (plus the projection PK) is what carries the wakeup-retention
-- no-double-fire guarantee for past windows: backfill NEVER arms
-- `scheduled_wakeups` rows at all, so `window_due` keys keep targeting only
-- future-ending windows and pruning fired rows stays safe (see the re-verified
-- note in repo/scheduled-wakeups.ts). Monotonic by the repo write path
-- (`advanceBackfillCursor` uses MAX) — a backwards move would un-disposition
-- skipped windows and resurrect them.
--
-- ON DELETE CASCADE: symmetric with `window_events`/`tumbling_window_state` —
-- deleting a trigger deletes its backfill progress. An epoch edit strands the
-- old epoch's cursor row; harmless debris (never read again — sync only reads
-- the CURRENT epoch's cursor), reclaimed by the trigger's eventual delete.
CREATE TABLE IF NOT EXISTS tumbling_backfill_cursors (
  trigger_id TEXT NOT NULL REFERENCES triggers (id) ON DELETE CASCADE,
  config_epoch TEXT NOT NULL,
  cursor_ms INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (trigger_id, config_epoch)
);

-- PART 2 — the window's ORIGIN: 'live' = the forward `window_due` chain (S9),
-- 'backfill' = the S10 backfill pass. Drives the materialization gate
-- (backfill windows fire one-at-a-time while live windows keep S9's ungated
-- behavior). A plain ADD COLUMN (no CHECK edit on an existing constraint —
-- the 0019 recreate reasoning does not apply to a NEW column); DEFAULT 'live'
-- is the HONEST value for every existing row: every pre-S10 window was
-- created by the live chain.
ALTER TABLE tumbling_window_state ADD COLUMN origin TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live', 'backfill'));
