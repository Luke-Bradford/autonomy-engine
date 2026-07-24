-- #3 G9a (Foundation Spec #3 git-publish, ticket row G9 + the G3a deferral note
-- "the persisted working_branch column + feature-branch selection land with
-- their first reader, G9 PR-open") — persist the studio-owned working branch a
-- Commit lands on and a PR is opened FROM, replacing the per-commit-derived
-- `studio/<ownerId>/work`.
--
-- `working_branch` is really per-workspace CONFIG (a feature-branch SELECTION),
-- not an observed fact — but it follows the `secret_status` (0030) posture: it
-- has no single constant DEFAULT that fits every row (the value depends on
-- owner_id), so it is added nullable, backfilled per-row below, and the read
-- boundary (`WorkspaceGitSchema.workingBranch`) enforces NOT NULL. A row this
-- migration somehow failed to set would fail LOUDLY at read (a manufactured
-- benign default is the #473 anti-pattern) rather than silently. It is
-- always-set-on-write thereafter (connect seeds the default, the working-branch
-- route sets an explicit value).
ALTER TABLE workspace_git ADD COLUMN working_branch TEXT;

-- One-time backfill reproducing the EXACT value the commit route derived before
-- this slice (`studio/${ownerId}/work`) so behaviour is unchanged for every
-- already-connected workspace. JS `` `studio/${null}/work` `` renders
-- `studio/null/work`, which `COALESCE(owner_id,'null')` matches; in v1 owner_id
-- is always the concrete principal owner ('local'). This is the SQL
-- snapshot-duplicate of `deriveDefaultWorkingBranch` (shared/schemas/
-- workspace-git.ts), the runtime SSOT connect uses — same documented-duplicate
-- posture as the 0030 secret_status kind list.
UPDATE workspace_git
SET working_branch = 'studio/' || COALESCE(owner_id, 'null') || '/work';
