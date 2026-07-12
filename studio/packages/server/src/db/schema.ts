import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The ONE example table for the P0a skeleton. It exists purely to prove the
 * migration runner + Drizzle + better-sqlite3 wiring works end to end — no
 * product schema lives here yet.
 */
export const appMeta = sqliteTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
