-- #1395 OR4 slice 3: DEBUG versions — the editor's unsaved draft, minted as a
-- hidden version so a run can bind it like any other.
--
-- `debug` is 1 for a version the editor's Debug minted and 0 for every other
-- row. ADD COLUMN is native in SQLite, and 0 is the TRUE value for every
-- existing row: none of them was a debug run. `pipeline_versions_no_update` is
-- `BEFORE UPDATE ON` the whole row, so it covers the new column too: a version
-- can never be turned into, or out of, a debug version after it is written.
--
-- Server-only, like `global_reads`: it is NOT a `PipelineVersionSchema` field,
-- so it never reaches the content form, git or an export. Adding it there would
-- make every stored version differ from its branch file and re-mint it on the
-- next pull.

ALTER TABLE pipeline_versions ADD COLUMN debug INTEGER NOT NULL DEFAULT 0;

-- Saved versions keep their own dense numbering (v1, v2, ...) and debug versions
-- number separately (debug 1, debug 2, ...), so a Debug never leaves a gap in
-- the history the operator reads. Same index NAME, so everything that names it
-- still refers to the one uniqueness backstop.
DROP INDEX IF EXISTS pipeline_versions_pipeline_id_version_idx;
CREATE UNIQUE INDEX pipeline_versions_pipeline_id_version_idx
  ON pipeline_versions (pipeline_id, debug, version);

-- Debug versions are DELETABLE: the retention sweep removes them (and, first,
-- their runs, which reference them ON DELETE RESTRICT) once they are older than
-- `DEBUG_RETENTION_DAYS`. Every saved version stays exactly as immutable and
-- undeletable as 0002 made it — the only new path is `OLD.debug = 1`.
DROP TRIGGER IF EXISTS pipeline_versions_no_direct_delete;
CREATE TRIGGER pipeline_versions_no_direct_delete
BEFORE DELETE ON pipeline_versions
WHEN OLD.debug = 0 AND (SELECT COUNT(*) FROM pipelines WHERE id = OLD.pipeline_id) > 0
BEGIN
  SELECT RAISE(ABORT, 'pipeline_versions are immutable: delete the parent pipeline instead');
END;
