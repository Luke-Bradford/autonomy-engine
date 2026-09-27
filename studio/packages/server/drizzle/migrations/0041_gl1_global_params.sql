-- #844 GL1 (global-params spec GL-D1) — `global_params`, a workspace's global
-- parameters: owner-scoped, MUTABLE `{ name, type, value }` rows that every
-- pipeline of that owner will read as `${global.<name>}` (GL3). Inert until
-- then: nothing reads this table yet.
--
-- `owner_id` is NOT NULL, unlike every other resource table. SQLite treats
-- NULLs as distinct, so a nullable owner under the unique `(owner_id, name)`
-- index would admit duplicate names — the hole `secrets` has. The principal's
-- `ownerId` is never null, so nothing legitimate is refused.
--
-- The unique index collates `name` NOCASE, as `secrets_owner_name_idx` does:
-- `apiUrl` and `apiURL` cannot both exist, so a global's git file name
-- (`global-params/<name>.json`, GL6) cannot collide on a case-insensitive
-- filesystem either.
--
-- `type` is CHECKed against `GlobalParamTypeSchema` (the param types minus
-- `secret` — there are no secure globals, GL-D5); `constraints.test.ts` loops
-- the enum so a new type owes this CHECK a migration by construction.
--
-- `value` is the value's JSON TEXT, serialized by the repo (not drizzle's json
-- mode, which would write a JSON `null` value as SQL NULL). No column takes a
-- DEFAULT: every row is written whole by `createGlobalParam`, and an absent
-- fact must fail rather than be manufactured (#473).
CREATE TABLE `global_params` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_id` text NOT NULL,
  `name` text NOT NULL,
  `type` text NOT NULL CHECK (`type` IN ('string', 'number', 'boolean', 'json')),
  `value` text NOT NULL,
  `description` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
CREATE UNIQUE INDEX `global_params_owner_name_idx` ON `global_params` (`owner_id`, `name` COLLATE NOCASE);
