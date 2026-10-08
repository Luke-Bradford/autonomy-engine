-- #1477 (OR29): `connections.description` and `.annotations` — what a
-- connection is for, and the tags it carries (ADF's linked-service Description
-- and Annotations). The same pair 0043 gave `pipeline_versions`.
--
-- A field `ConnectionSchema` has and this table lacks is silently dropped on
-- insert (#473), so the columns arrive with the schema fields, and
-- `db/__tests__/schema-table-parity.test.ts` fails if one ever does not.
--
-- NOT NULL, with DEFAULTs of '' and '[]': SQLite needs a non-null default to
-- add a NOT NULL column to a table that has rows, and those are the TRUE values
-- for every existing row — neither field existed when it was written.

ALTER TABLE connections ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE connections ADD COLUMN annotations TEXT NOT NULL DEFAULT '[]';
