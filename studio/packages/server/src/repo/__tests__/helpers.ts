import { openDb } from '../../db/client.js';

/** A fresh, fully-migrated in-memory SQLite DB for one test file/case — no
 * mocking, real migrations, real `better-sqlite3`. */
export function freshDb() {
  return openDb(':memory:');
}
