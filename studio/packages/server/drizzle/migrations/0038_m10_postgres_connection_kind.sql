-- #1189 (M10 slice 1, data-movement spec §12): add the `postgres` STORE
-- connector to the `connections.kind` enum.
--
-- `postgres` is the first NETWORKED store kind and the first store kind that
-- carries a credential. Drizzle emits `ConnectionKindSchema` as a SQL CHECK
-- constraint (0002, widened by 0012 for `fs` and 0037 for `sqlite`), and SQLite
-- has no `ALTER TABLE ... ALTER CONSTRAINT`, so the documented table-recreate
-- procedure (https://www.sqlite.org/lang_altertable.html#otheralter) runs again:
-- CREATE the new shape with the widened CHECK, copy every row, DROP the old
-- table, RENAME the new one into place, recreate BOTH its indexes.
--
-- The two standing notes from 0037 were RE-DERIVED against the tree as it
-- stands, not inherited:
--
-- 1. `connection_quota_state` (#2 L14c) still declares
--    `connection_id -> connections(id) ON DELETE CASCADE`, so this recreate's
--    DROP TABLE sits under a live FK. It is safe for the reason `runMigrations`
--    documents at length (`db/migrate.ts`): `PRAGMA foreign_keys` is OFF around
--    the whole migration batch precisely so a recreate performs no implicit
--    cascading delete, and the end-of-batch `foreign_key_check` confirms
--    nothing was left dangling before the migration is recorded.
--
-- 2. The column set is UNCHANGED since 0037 — checked against `db/schema.ts`'s
--    `connections` table today, not copied on faith: twelve columns, and both
--    indexes including the G1 owner-scoped UNIQUE one. As in 0037 the column
--    list is spelled out on BOTH sides of the INSERT ... SELECT, so a column
--    added between writing this file and applying it cannot be silently
--    positionally mismatched.
--
-- NO BACKFILL, and the reason is worth stating rather than leaving as silence:
-- `postgres` is credentialled, so it joins `SECRET_REQUIRING_CONNECTION_KINDS`,
-- and 0030 backfilled `secret_status` from a snapshot of that set. No row can
-- carry `kind = 'postgres'` before THIS migration widens the CHECK that has
-- refused it since 0002, so there is no pre-existing row whose `secret_status`
-- the widened set could make stale. Every postgres connection is written after
-- this point, through `deriveSecretStatus`.

CREATE TABLE connections_new (
  id TEXT PRIMARY KEY,
  resource_id TEXT,
  owner_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('anthropic_api', 'openai_api', 'ollama', 'agent_cli', 'http', 'fs', 'sqlite', 'postgres')),
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
