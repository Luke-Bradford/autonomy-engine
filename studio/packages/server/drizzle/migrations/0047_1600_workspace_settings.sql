-- #1600 OR41 C0f — `workspace_settings`, one row per workspace holding its own
-- settings (the first is the default activity timeout). Owner-scoped like
-- `global_params`, and keyed by `owner_id` itself: one row per owner is the whole
-- shape, so a surrogate id would only add a second key that could disagree.
--
-- `owner_id` is NOT NULL for `global_params`' reason: SQLite treats NULLs as
-- distinct, so a nullable key would admit two rows for one workspace. The
-- principal's `ownerId` is never null.
--
-- No row means the workspace never saved its settings, and the server reads
-- the documented defaults (`DEFAULT_WORKSPACE_SETTINGS`). Once a row exists,
-- `default_activity_timeout_seconds` NULL means the author turned the default
-- off. No column takes a DEFAULT: the repo always writes the whole row (#473).
CREATE TABLE `workspace_settings` (
  `owner_id` text PRIMARY KEY NOT NULL,
  `default_activity_timeout_seconds` integer CHECK (`default_activity_timeout_seconds` > 0),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
