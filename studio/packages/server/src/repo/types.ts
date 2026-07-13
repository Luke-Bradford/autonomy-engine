import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../db/schema.js';

/** The Drizzle client type every repo function operates against — matches
 * `DbHandle['db']` from `../db/client.js` without importing `client.ts`
 * itself (which would pull in filesystem/migration side effects at import
 * time; repo modules should only need the schema shape). */
export type Db = BetterSQLite3Database<typeof schema>;
