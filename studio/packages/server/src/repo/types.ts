import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../db/schema.js';

/** The Drizzle client type every repo function operates against — matches
 * `DbHandle['db']` from `../db/client.js` without importing `client.ts`
 * itself (which would pull in filesystem/migration side effects at import
 * time; repo modules should only need the schema shape). */
export type Db = BetterSQLite3Database<typeof schema>;

/**
 * The handle `Db['transaction']` hands its callback.
 *
 * Derived from `Db` rather than spelled out, so a repo function that must run
 * INSIDE a caller's transaction (rather than opening its own) can be typed
 * without importing Drizzle's transaction generics — and cannot drift from the
 * client type. `aggregateAiActivity` needs this: its panels are read in one
 * SQLite snapshot precisely so they cannot describe different instants, which a
 * helper taking only `Db` would silently break by opening a second read.
 */
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];
