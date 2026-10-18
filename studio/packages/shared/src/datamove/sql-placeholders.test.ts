import { describe, expect, it } from 'vitest';

import { scanSqlPlaceholders, sqlBindNames, sqlLeadingKeyword } from './sql-placeholders.js';

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

  it('sqlite: ?NNN binds the key NNN, and a bare ? binds no name', () => {
    expect(sqlBindNames('select ?1, ?, ?12', 'sqlite')).toEqual(['1', '12']);
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

// #1600 OR41 C3b — the pre-copy script's allow-list keys on this word, and on
// sqlite it is the ONLY barrier between authored SQL and an `ATTACH` that
// writes outside the connection's roots. So every way of NOT starting with a
// word must answer null, never the word after it.
describe('sqlLeadingKeyword', () => {
  it('upper-cases the first word', () => {
    expect(sqlLeadingKeyword('delete from t', 'sqlite')).toBe('DELETE');
    expect(sqlLeadingKeyword('Insert into t values (1)', 'postgres')).toBe('INSERT');
  });

  it('skips whitespace and comments, by each store\'s own comment rules', () => {
    expect(sqlLeadingKeyword(' \n\t-- note\n/* a */ update t set a = 1', 'sqlite')).toBe('UPDATE');
    expect(sqlLeadingKeyword('/* /* nested */ still */ delete from t', 'postgres')).toBe('DELETE');
    // postgres ends a line comment at a CR; sqlite does not, so there the rest is comment.
    expect(sqlLeadingKeyword('-- c\rdelete from t', 'postgres')).toBe('DELETE');
    expect(sqlLeadingKeyword('-- c\rdelete from t', 'sqlite')).toBeNull();
    // sqlite comments do not nest: the first close ends the comment.
    expect(sqlLeadingKeyword('/* /* x */ attach', 'sqlite')).toBe('ATTACH');
  });

  it('answers null for a statement that does not begin with a word', () => {
    // MEASURED by the C3b plan review: better-sqlite3 runs ";attach database …".
    expect(sqlLeadingKeyword(";attach database 'x' as o", 'sqlite')).toBeNull();
    expect(sqlLeadingKeyword(' ; delete from t', 'postgres')).toBeNull();
    expect(sqlLeadingKeyword('(select 1)', 'postgres')).toBeNull();
    expect(sqlLeadingKeyword('', 'sqlite')).toBeNull();
    expect(sqlLeadingKeyword('/* never closed delete', 'sqlite')).toBeNull();
    expect(sqlLeadingKeyword('"delete" from t', 'sqlite')).toBeNull();
  });

  it('reads the whole word, so a longer identifier is not its prefix', () => {
    expect(sqlLeadingKeyword('deleted_rows', 'sqlite')).toBe('DELETED_ROWS');
    expect(sqlLeadingKeyword('delete$x', 'postgres')).toBe('DELETE$X');
  });
});
