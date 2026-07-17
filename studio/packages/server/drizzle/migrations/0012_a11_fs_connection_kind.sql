-- #4 A11: add the local `fs` connector to the `connections.kind` enum.
--
-- The `fs` connector (the first non-http/LLM connector) needs `connections.kind`
-- to accept `'fs'`. Drizzle emits the `ConnectionKindSchema` enum as a SQL CHECK
-- constraint (see 0002), and SQLite has no `ALTER TABLE ... ALTER CONSTRAINT`, so
-- the documented table-recreate procedure
-- (https://www.sqlite.org/lang_altertable.html#otheralter) is used: CREATE the
-- new shape with the widened CHECK, copy every row, DROP the old table, RENAME
-- the new one into place, recreate its index.
--
-- `runMigrations` (packages/server/src/db/migrate.ts) turns `PRAGMA foreign_keys`
-- OFF around the whole migration run, so this recreate is safe. No table
-- FK-references `connections`, so the `DROP TABLE` triggers no cascade; the
-- OUTGOING `secret_ref -> secrets(ref)` FK is preserved by copying the column
-- verbatim and re-declaring it on the new table (the end-of-migration
-- `foreign_key_check` confirms every copied `secret_ref` still resolves).

CREATE TABLE connections_new (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('anthropic_api', 'openai_api', 'ollama', 'agent_cli', 'http', 'fs')),
  config TEXT NOT NULL,
  secret_ref TEXT REFERENCES secrets (ref) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO connections_new
  (id, owner_id, name, kind, config, secret_ref, created_at, updated_at)
SELECT
  id, owner_id, name, kind, config, secret_ref, created_at, updated_at
FROM connections;

DROP TABLE connections;

ALTER TABLE connections_new RENAME TO connections;

CREATE INDEX IF NOT EXISTS connections_owner_id_idx ON connections (owner_id);
