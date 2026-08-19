-- #1119 (M4, data-movement spec §12): add the `sqlite` STORE connector to the
-- `connections.kind` enum.
--
-- `sqlite` is the first STORE connection kind — a linked service that holds
-- data rather than a service that computes. Drizzle emits `ConnectionKindSchema`
-- as a SQL CHECK constraint (see 0002, widened by 0012 for `fs`), and SQLite has
-- no `ALTER TABLE ... ALTER CONSTRAINT`, so the documented table-recreate
-- procedure (https://www.sqlite.org/lang_altertable.html#otheralter) is used
-- again: CREATE the new shape with the widened CHECK, copy every row, DROP the
-- old table, RENAME the new one into place, recreate BOTH its indexes.
--
-- TWO THINGS CHANGED SINCE 0012, and neither is inherited — both were re-derived
-- against the tree as it stands today:
--
-- 1. 0012's header said "No table FK-references `connections`, so the DROP TABLE
--    triggers no cascade." THAT IS NO LONGER TRUE: `connection_quota_state`
--    (#2 L14c) declares `connection_id -> connections(id) ON DELETE CASCADE`.
--    The recreate is still safe, for the reason `runMigrations` documents at
--    length (`db/migrate.ts`): `PRAGMA foreign_keys` is turned OFF around the
--    whole migration batch precisely so a recreate's `DROP TABLE` performs no
--    implicit cascading delete — the identical situation 0003 already handles,
--    where `runs.trigger_id` FK-references the `triggers` table it recreates.
--    The end-of-migration `foreign_key_check` (inside this migration's own
--    transaction, before it is recorded) confirms nothing was left dangling.
--
-- 2. The table has gained FOUR columns and ONE index since 0012 — `parameters`
--    (0023), `resource_id` + the UNIQUE `connections_owner_resource_id_idx`
--    (0024), and `enabled` + `secret_status` (0030). Copying 0012's 8-column
--    shape verbatim would silently drop three columns and the G1 owner-scoped
--    uniqueness invariant. Every column and both indexes are reproduced below;
--    the column list is spelled out on BOTH sides of the INSERT ... SELECT so a
--    future column added between writing and applying this file cannot be
--    silently positionally mismatched.
--
-- `datasets.kind` deliberately gets NO equivalent constraint here: 0036 declared
-- it as a plain `TEXT NOT NULL` with no CHECK, so the `table`/`query` dataset
-- kinds M4 gives config schemas to need no migration at all.

CREATE TABLE connections_new (
  id TEXT PRIMARY KEY,
  resource_id TEXT,
  owner_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('anthropic_api', 'openai_api', 'ollama', 'agent_cli', 'http', 'fs', 'sqlite')),
  config TEXT NOT NULL,
  parameters TEXT NOT NULL DEFAULT '[]',
  secret_ref TEXT REFERENCES secrets (ref) ON DELETE RESTRICT,
  secret_status TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO connections_new
  (id, resource_id, owner_id, name, kind, config, parameters, secret_ref, secret_status, enabled, created_at, updated_at)
SELECT
  id, resource_id, owner_id, name, kind, config, parameters, secret_ref, secret_status, enabled, created_at, updated_at
FROM connections;

DROP TABLE connections;

ALTER TABLE connections_new RENAME TO connections;

CREATE INDEX IF NOT EXISTS connections_owner_id_idx ON connections (owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS connections_owner_resource_id_idx ON connections (owner_id, resource_id);
