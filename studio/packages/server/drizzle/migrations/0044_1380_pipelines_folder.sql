-- #1380 — the folder the Factory Resources pane files a pipeline under.
-- On the mutable ROW, beside `name`, not the immutable version doc: moving a
-- pipeline must not mint a version (spec #1 D1, amended by #1380).
-- NULL = top level: every pre-#1380 pipeline genuinely is at the top level,
-- so the nullable backfill records the truth (no manufactured default — #473).
ALTER TABLE pipelines ADD COLUMN folder TEXT;
