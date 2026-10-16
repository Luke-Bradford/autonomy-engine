-- #1600 OR41 C7d — `workspace_settings.lookup_max_rows`, the workspace's Lookup
-- max rows: the ceiling every Lookup run is held to (a node's own Max rows can
-- only ask for less).
--
-- NOT NULL DEFAULT 1000, 0046's shape: SQLite needs a non-null default to add a
-- NOT NULL column to a table that has rows, and 1000 is the TRUE value for every
-- existing row — it is the cap every Lookup ran under before this column
-- existed (`LOOKUP_ROW_CAP`). The repo still writes the whole row (#473).
--
-- The CHECK is `> 0` only, like 0047's timeout: the upper bound (ADF's 5000) is
-- the PUT body's write rule, and SQLite cannot change a CHECK without
-- rebuilding the table.

ALTER TABLE workspace_settings ADD COLUMN lookup_max_rows INTEGER NOT NULL DEFAULT 1000 CHECK (lookup_max_rows > 0);
