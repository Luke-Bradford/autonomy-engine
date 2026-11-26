-- #1567 OR36 A4 — `workspace_settings.run_capture_*`, how much of a run the log
-- keeps: the capture level, and the caps on a dispatch's JSON records, on an
-- output field and on a ForEach item.
--
-- NOT NULL with defaults, 0048's shape: SQLite needs a non-null default to add
-- a NOT NULL column to a table that has rows. The defaults are the documented
-- ones (`DEFAULT_RUN_CAPTURE`); a workspace that saved its settings before this
-- column existed chose none of these, so it reads the same values a workspace
-- that never saved does. The CHECKs are `> 0` only; the bounds are the PUT
-- body's write rule, as for 0048.

ALTER TABLE workspace_settings ADD COLUMN run_capture_level TEXT NOT NULL DEFAULT 'standard' CHECK (run_capture_level IN ('standard', 'full'));
ALTER TABLE workspace_settings ADD COLUMN run_capture_input_max_chars INTEGER NOT NULL DEFAULT 64000 CHECK (run_capture_input_max_chars > 0);
ALTER TABLE workspace_settings ADD COLUMN run_capture_output_max_bytes INTEGER NOT NULL DEFAULT 1048576 CHECK (run_capture_output_max_bytes > 0);
ALTER TABLE workspace_settings ADD COLUMN run_capture_iteration_item_max_chars INTEGER NOT NULL DEFAULT 16000 CHECK (run_capture_iteration_item_max_chars > 0);
