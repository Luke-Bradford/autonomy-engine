import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { sqlBindNames } from '@autonomy-studio/shared';

/**
 * #1600 OR41 C1q-c — the sqlite dialect of the shared placeholder scanner,
 * checked against the driver the reader binds through rather than against a
 * reading of sqlite's tokenizer. For each statement, binding EXACTLY the names
 * the scanner reports must succeed, and leaving any one of them out must fail
 * with better-sqlite3's own "Missing named parameter" — so the scanner neither
 * misses a name the driver binds nor reports one it does not.
 */
const CORPUS = [
  'select :a',
  'select @a, $b, #c, :a',
  'select :1, :a$b, :é',
  'select 1 as [x:y], 1 as `x:z`, 1 as ":w", \':v\', :a',
  'select 1 /* :y /* */ , :a',
  'select 1 -- :y\r, :b\n, :a',
  "select x'00', 1 as a$b, :a",
  "select 'it''s :q', :a, :a",
  'select :$a',
  'select ?1, ?2, ?1, :a',
];

describe('sqlite bind names agree with better-sqlite3', () => {
  const db = new Database(':memory:');

  for (const sql of CORPUS) {
    it(JSON.stringify(sql), () => {
      const names = sqlBindNames(sql, 'sqlite');
      const all = Object.fromEntries(names.map((n) => [n, 1]));
      expect(() => db.prepare(sql).get(all)).not.toThrow();
      for (const left of names) {
        const fewer = Object.fromEntries(names.filter((n) => n !== left).map((n) => [n, 1]));
        expect(() => db.prepare(sql).get(fewer)).toThrow(`Missing named parameter "${left}"`);
      }
    });
  }
});
