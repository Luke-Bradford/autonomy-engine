-- #1600 OR41 C5a — `copy_watermarks`, the store behind a Copy's Load Incremental
-- with Watermark from Automatic: the highest watermark value each committed copy
-- read, one row per pipeline, activity and source.
--
-- A table of its own, not a read of the run log: deleting a run, pruning debug
-- runs or a secure output's redaction would otherwise lose the value, and the
-- next run would copy every row again. `source_key` is a hash of the resolved
-- source (connection, dataset kind and config, watermark column), so one node
-- that reads different sources (a `${}` connection, a parameterised query, a
-- child pipeline called with other parameters) keeps a watermark per source.
-- `value_json` holds a JSON string or number; a source with no watermark yet has
-- no row. It goes with its pipeline.

CREATE TABLE `copy_watermarks` (
  `pipeline_id` text NOT NULL REFERENCES `pipelines`(`id`) ON DELETE CASCADE,
  `node_id` text NOT NULL,
  `source_key` text NOT NULL,
  `column_name` text NOT NULL,
  `value_json` text NOT NULL,
  `run_id` text NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`pipeline_id`, `node_id`, `source_key`)
);
