-- #844 GL3 (global-params spec GL-D3): `pipeline_versions.global_reads` — the
-- workspace globals a version reads, `[{ "name", "type" }]`, as its save gate
-- typed them. DERIVED and write-once: the gate records it on every version write
-- (git import included), and it is not part of the content form, the git file or
-- the export. A run's start check reads it, never re-running the validator.
--
-- NULLABLE with no default. NULL means "reads none", which is TRUE of every row
-- that exists when this runs: the `${global}` root was refused until GL3, so no
-- earlier version can reference a global. A new row always gets a list, `[]`
-- included, so NULL also marks a row as pre-GL3.
--
-- ADD COLUMN leaves 0002's `pipeline_versions_no_update` trigger intact, and it
-- is table-wide, so the column is immutable like every other version field.

ALTER TABLE pipeline_versions ADD COLUMN global_reads TEXT;
