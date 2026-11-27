-- #1567 OR36 A4 — `workspace_settings.run_capture`, how much of a run the log
-- keeps: the capture level, and the caps on a dispatch's JSON records, on an
-- output field and on a ForEach item. One JSON column, as `WorkspaceSettings`
-- holds one `runCapture` object (the #473 parity rule).
--
-- NOT NULL with a default, 0048's shape: SQLite needs a non-null default to add
-- a NOT NULL column to a table that has rows. The default is the documented one
-- (`DEFAULT_RUN_CAPTURE`): a workspace that saved its settings before this
-- column existed chose none of these, so it reads what a workspace that never
-- saved does. The bounds are the PUT body's write rule, as for 0048.

ALTER TABLE workspace_settings ADD COLUMN run_capture TEXT NOT NULL DEFAULT '{"level":"standard","inputMaxChars":64000,"outputMaxBytes":1048576,"iterationItemMaxChars":16000}';
