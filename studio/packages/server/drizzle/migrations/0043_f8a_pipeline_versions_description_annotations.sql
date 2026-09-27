-- #1 F8a: `pipeline_versions.description` and `.annotations` — what a pipeline
-- is for, and the tags it carries (spec
-- `studio/docs/2026-07-14-foundation-domain-activity-framework.md` D1).
--
-- Each version doc field is its own column, and a field the table lacks is
-- silently dropped on insert (#473). So the new doc fields arrive with their
-- columns in the same change, and `db/__tests__/schema-table-parity.test.ts`
-- fails if one ever does not.
--
-- ALTER ... ADD COLUMN is native in SQLite (no table recreate), so 0002's
-- `pipeline_versions_no_update` / `_no_delete` triggers are undisturbed and,
-- being `BEFORE UPDATE ON` the whole row, cover the new columns (pinned by
-- `migrate-description-annotations-columns.test.ts`).
--
-- NOT NULL, with DEFAULTs of '' and '[]'. SQLite needs a non-null default to
-- add a NOT NULL column to a table that has rows, and those are the TRUE values
-- for every existing row: neither field existed when it was written, so no
-- version had a description or an annotation and nothing is lost. The DEFAULTs
-- serve only that backfill; the drizzle columns have none, so the repo layer's
-- insert must name both keys (the `containers` / `variables` pairing).

ALTER TABLE pipeline_versions ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE pipeline_versions ADD COLUMN annotations TEXT NOT NULL DEFAULT '[]';
