-- Example table: proves the migration runner + Drizzle + better-sqlite3 wiring.
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
