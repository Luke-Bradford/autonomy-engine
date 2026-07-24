-- #3 G6b — git provenance on immutable pipeline versions.
--
-- A version minted by the workspace-git import (G5c) now records WHERE it came
-- from: the source commit, the collaboration branch, the repo-relative file path,
-- and the git blob SHA of that file. This is the substrate G6c's CAS Publish
-- reads (`Publish only from a DB version whose source commit/blob is known`) and
-- the answer to "what is running?" (spec #3 line 134: imported versions persist
-- `commitSha, branch, filePath, blobSha`).
--
-- All four are NULLABLE with NO default. Nullable is the HONEST value, not a
-- fail-open: a version minted by any NON-git path (the `POST /api/pipelines/:id/
-- versions` route, portable import, tests) genuinely has no source commit/blob,
-- and every row that existed before G6b was authored without git provenance.
-- Manufacturing a sentinel would be the #473 defect (an absent fact dressed up
-- as a benign value); a NULL says truthfully "not imported from git". Because
-- these columns are added independently, a partial state (commit set, blob null)
-- is nonsensical — but it cannot arise: the git reader lists every managed file
-- from `ls-tree` (which always carries a blob sha) before reading it, so a
-- git-minted version always has all four, and a non-git mint has none.
--
-- ALTER ... ADD COLUMN is native in SQLite (no table recreate), so this does NOT
-- disturb `0002`'s `pipeline_versions_no_update` / `_no_direct_delete` triggers:
-- both are `BEFORE UPDATE ON` / `BEFORE DELETE ON` (NOT column-scoped `UPDATE
-- OF ...`), so the new columns are covered by the immutability guarantee
-- automatically. Provenance is therefore write-once at INSERT (mint) and can
-- never be edited afterwards — the same immutability every other version field
-- has. No backfill: pre-G6b rows stay NULL, which is truthful (their provenance
-- is genuinely unknown), and they are immutable anyway.

ALTER TABLE pipeline_versions ADD COLUMN source_commit TEXT;
ALTER TABLE pipeline_versions ADD COLUMN source_branch TEXT;
ALTER TABLE pipeline_versions ADD COLUMN source_file_path TEXT;
ALTER TABLE pipeline_versions ADD COLUMN source_blob_sha TEXT;
