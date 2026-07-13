import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { runMigrations } from './migrate.js';

export interface DbHandle {
  sqlite: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
}

/**
 * Opens (creating if absent) the SQLite file at `dbPath`, switches it to WAL
 * mode (required so the single writer connection doesn't block readers),
 * and applies any pending migrations before handing back a Drizzle client.
 */
export function openDb(dbPath: string): DbHandle {
  mkdirSync(dirname(dbPath), { recursive: true });

  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  // better-sqlite3 (like SQLite itself) does NOT enforce FOREIGN KEY
  // constraints unless this pragma is set per-connection — without it every
  // `REFERENCES ...` clause in the schema is silently decorative.
  sqlite.pragma('foreign_keys = ON');

  runMigrations(sqlite);

  const db = drizzle({ client: sqlite, schema });

  return { sqlite, db };
}
