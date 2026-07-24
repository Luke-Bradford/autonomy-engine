-- RS6: durable rerun-from-failed LINEAGE projection on `runs`.
--
-- RS1-RS3 shipped the reseed MECHANISM: a rerun-from-failed starts a new run R2
-- whose log opens with `run.started{rerunOf: R1}` + `run.reseeded{...}`. But the
-- `runs` PROJECTION table had no `rerun_of` column, so answering "which runs are
-- reruns of R1?" (the Monitor's rerun-history grouping, T13) meant folding every
-- run's event log. This adds the durable, indexed projection the RS2 producer
-- writes in the SAME transaction as those events, so the row lineage and the
-- event-log lineage can never disagree.
--
-- A PLAIN `ALTER TABLE ADD COLUMN` — NO table recreate. Unlike 0015 (S6a), this
-- adds no CHECK constraint and changes none, so the documented table-recreate
-- procedure is not required. SQLite permits a `REFERENCES` clause on ADD COLUMN
-- as long as the column is nullable with a NULL default (verified empirically:
-- add + insert + `PRAGMA foreign_key_check` clean + `ON DELETE SET NULL` fires).
-- `runMigrations` applies this with `foreign_keys = OFF` and a
-- `foreign_key_check` inside the transaction; the new column is NULL on every
-- existing row, so the check passes.
--
-- Self-referencing FK (rerun -> source), `ON DELETE SET NULL` — mirrors
-- `runs.parent_run_id` exactly: a retention sweep (#464) that deletes the source
-- run R1 leaves R2 a valid orphan-lineage row (`rerun_of` nulled) rather than
-- blocking the delete (RESTRICT) or cascading R2's history away (CASCADE).

ALTER TABLE runs ADD COLUMN rerun_of TEXT REFERENCES runs (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS runs_rerun_of_idx ON runs (rerun_of);
