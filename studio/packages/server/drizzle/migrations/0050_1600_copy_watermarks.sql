-- #1600 OR41 C5a — `copy_watermarks`, the store behind a Copy's Load Incremental
-- with Watermark from Automatic: the highest watermark value each committed copy
-- read, one row per pipeline, activity and source.
--
-- A table of its own, not a read of the run log: deleting a run, pruning debug
-- runs or a secure output's redaction would otherwise lose the value, and the
-- next run would copy every row again. `copy_key` is a hash of the resolved
-- source (connection, dataset kind and config, bind values), the watermark
-- column and the resolved sink, so one node that reads different sources (a
-- `${}` connection, a parameterised query, a child pipeline called with other
-- parameters) keeps a watermark per source, and another sink table starts from
-- nothing. `value_json` holds a JSON string or number; a copy with no watermark
-- yet has no row. `column_name` and `run_id` are for diagnosis: which column
-- the value belongs to and which run stored it. It goes with its pipeline.

CREATE TABLE `copy_watermarks` (
  `pipeline_id` text NOT NULL REFERENCES `pipelines`(`id`) ON DELETE CASCADE,
  `node_id` text NOT NULL,
  `copy_key` text NOT NULL,
  `column_name` text NOT NULL,
  `value_json` text NOT NULL,
  `run_id` text NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`pipeline_id`, `node_id`, `copy_key`)
);
