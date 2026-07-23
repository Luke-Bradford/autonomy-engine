-- #3 G2 — the workspace↔git association (Foundation Spec #3, Option A:
-- DB-SSOT + git seam). ONE row per owner: which repo is connected, which
-- branch is the collaboration branch, and the last OBSERVED collaboration
-- head (the drift reference G3's commit guard + G4's import will read). The
-- managed checkout itself is derived state on disk under the server's
-- `workspaceGitRoot` (always OUR clone — the user's own repo is never
-- studio's working tree); this row is the DB's record of the association.
--
-- A NEW table, so NOT NULL is stated directly (no ADD-COLUMN sentinel
-- hazard, unlike 0024). The tracking fields are genuinely nullable: NULL
-- means "not observed"/"never failed", stated honestly rather than
-- manufactured (#473).
--
-- Uniqueness is OWNER-scoped ("one repo per workspace" in v1): the route
-- pre-checks and returns a clear 409, but the DB index is the authority a
-- concurrent double-connect cannot race past. NULL owner_ids compare
-- distinct in SQLite unique indexes (same note as 0024) — acceptable; the
-- app always stamps the principal's ownerId.

CREATE TABLE workspace_git (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  repo_url TEXT NOT NULL,
  collab_branch TEXT NOT NULL,
  observed_collab_head TEXT,
  last_fetch_at INTEGER,
  last_fetch_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX workspace_git_owner_id_idx ON workspace_git (owner_id);
