import { describe, expect, it } from 'vitest';

import { scanSqlPlaceholders, sqlBindNames } from './sql-placeholders.js';

// #1600 OR41 C1q-c — the bind names the dock derives its rows from. The
// postgres rules are pinned in depth by the reader's own suite
// (server `postgres-named-parameters.test.ts`), which rewrites through this
// scanner; the sqlite rules are cross-checked against better-sqlite3 in
// server `sqlite-bind-names.test.ts`.
describe('sqlBindNames', () => {
  it('lists each distinct name once, in first-appearance order', () => {
    expect(sqlBindNames('select :b, :a, :b', 'postgres')).toEqual(['b', 'a']);
    expect(sqlBindNames('select :b, :a, :b', 'sqlite')).toEqual(['b', 'a']);
  });

  it('postgres: skips literals, quoted identifiers, comments, dollar quotes and casts', () => {
    const sql =
      "select ':q1', E'\\':q2', \":q3\", $$ :q4 $$, $t$ :q5 $t$, a::int, /* /* :q6 */ :q7 */ -- :q8\r :real";
    expect(sqlBindNames(sql, 'postgres')).toEqual(['real']);
  });

  it('postgres: reports a positional $n, and a $ inside a word is neither', () => {
    expect(scanSqlPlaceholders('select a$1, $2', 'postgres')).toEqual([
      { kind: 'positional', start: 12 },
    ]);
  });

  it('sqlite: binds :, @, $ and # alike, keyed without the prefix', () => {
    expect(sqlBindNames('select :a, @b, $c, #d, :a', 'sqlite')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('sqlite: a digit starts a name, and $ and non-ASCII continue one', () => {
    expect(sqlBindNames('select :1, :a$b, :é', 'sqlite')).toEqual(['1', 'a$b', 'é']);
  });

  it('sqlite: skips [..], `..`, "..", \'..\', flat block comments and LF-ended line comments', () => {
    const sql = 'select 1 as [x:a], 1 as `x:b`, ":c", \':d\', /* /* :e */ :f -- :g\r :h\n, :i';
    expect(sqlBindNames(sql, 'sqlite')).toEqual(['f', 'i']);
  });

  it('sqlite: a $ inside a word is a name character, not a prefix', () => {
    expect(sqlBindNames('select a$b, :c', 'sqlite')).toEqual(['c']);
  });

  it('reports nothing for a statement with no placeholders', () => {
    expect(sqlBindNames('', 'sqlite')).toEqual([]);
    expect(sqlBindNames('select 1', 'postgres')).toEqual([]);
  });
});
