import { describe, expect, it } from 'vitest';

import { rewriteNamedParametersToPositional } from '../postgres-named-parameters.js';

/**
 * #1194 — the `:name` → `$n` rewriter, tested against the postgres LEXER rather
 * than against a regex's idea of one.
 *
 * Every lexical case below was MEASURED on `postgres:17` while this was built,
 * and the measurement is quoted on the case it justifies. A test whose premise
 * is "postgres probably does X" is the failure mode this file exists to avoid —
 * the whole ticket turned on `:` and `$` meaning several different things.
 */
describe('rewriteNamedParametersToPositional', () => {
  const rewrite = rewriteNamedParametersToPositional;

  describe('when no parameters are declared', () => {
    it('returns the statement BYTE-identical and binds nothing', () => {
      // The no-parameter path must stay exactly what it was before #1194: the
      // scanner does not even run, so there is no shape of SQL it can perturb.
      const sql = "select ':id', a$1, $$ raw $$ from t where a > :id";
      expect(rewrite(sql, undefined)).toEqual({ sql, values: [] });
      expect(rewrite(sql, {})).toEqual({ sql, values: [] });
    });
  });

  describe('the rewrite itself', () => {
    it('rewrites a declared name to $1 and binds its value', () => {
      expect(rewrite('select a from t where a > :id', { id: 3 })).toEqual({
        sql: 'select a from t where a > $1',
        values: [3],
      });
    });

    it('gives one name ONE placeholder however many times it is used', () => {
      // MEASURED: postgres accepts `where a > $1 and a < $1 + 100` with a single
      // value, and supplying a second raises `08P01 bind message supplies 2
      // parameters, but prepared statement "" requires 1`. So a repeated name
      // must NOT append a second value.
      expect(rewrite('select a from t where a > :id and a < :id + 100', { id: 3 })).toEqual({
        sql: 'select a from t where a > $1 and a < $1 + 100',
        values: [3],
      });
    });

    it('numbers distinct names by FIRST APPEARANCE, not by key order', () => {
      const parameters = { hi: 9, lo: 1 };
      expect(rewrite('select a from t where a > :lo and a < :hi', parameters)).toEqual({
        sql: 'select a from t where a > $1 and a < $2',
        values: [1, 9],
      });
    });

    it('binds string, number and null values', () => {
      expect(rewrite('select :s, :n, :z', { s: 'x', n: 1, z: null })).toEqual({
        sql: 'select $1, $2, $3',
        values: ['x', 1, null],
      });
    });

    it('drops a declared parameter the statement never names', () => {
      // MEASURED on better-sqlite3@12.11.1: `.all({id: 3, unused: 7})` against
      // `where a > :id` SUCCEEDS — an extra named value is silently ignored. The
      // point of #1194 is that one dataset config means the same thing in both
      // stores, so inventing a postgres-only refusal here would re-break exactly
      // what the ticket exists to fix. It is also forced: a spare value is
      // `08P01` on postgres, so it cannot be passed through.
      expect(rewrite('select a from t where a > :id', { id: 3, unused: 7 })).toEqual({
        sql: 'select a from t where a > $1',
        values: [3],
      });
    });

    it('leaves an UNDECLARED :name byte-identical', () => {
      // This module's authority is exactly the names the operator declared. A
      // `:` it was given no name for is postgres's business — see the docblock
      // for why refusing it would be a gate parsing operator SQL badly.
      expect(rewrite('select a from t where a = :ide and b = :id', { id: 3 })).toEqual({
        sql: 'select a from t where a = :ide and b = $1',
        values: [3],
      });
    });
  });

  describe('the name is matched with MAXIMAL MUNCH, because `$` is a name character', () => {
    it('does not rewrite the prefix of a longer name', () => {
      // MEASURED on better-sqlite3: `:a$b` binds the key `a$b`, and this repo's
      // own `SQL_IDENTIFIER_RE` is `/^[A-Za-z_][A-Za-z0-9_$]*$/`. Were the scan
      // to stop at `a`, `:a$b` would become `$1$b` — and `$b` then reads as a
      // dollar-quote opener. That is a MANGLED statement, not a loud refusal,
      // which is why maximal munch is the rule rather than a nicety.
      expect(rewrite('select :a$b, :a', { a: 1, a$b: 2 })).toEqual({
        sql: 'select $1, $2',
        values: [2, 1],
      });
    });

    it('leaves `:a$b` alone when only `a` is declared', () => {
      expect(rewrite('select :a$b', { a: 1 })).toEqual({ sql: 'select :a$b', values: [] });
    });
  });

  describe('a colon that is not a parameter', () => {
    it('does not read the second colon of a `::` cast as a name', () => {
      // The mutation-killing shape: a parameter is DECLARED under the type's
      // own name, so dropping the `::` skip would rewrite `a::int` to `a:$1`.
      expect(rewrite('select a::int from t where a > :int', { int: 3 })).toEqual({
        sql: 'select a::int from t where a > $1',
        values: [3],
      });
    });

    it('leaves an array slice alone when its bound is not a declared name', () => {
      // MEASURED: `(array[1,2,3])[1:2]` is valid postgres and returns `{1,2}`.
      expect(rewrite('select (array[1,2,3])[1:2], :id', { id: 3 })).toEqual({
        sql: 'select (array[1,2,3])[1:2], $1',
        values: [3],
      });
    });

    it('collides LOUDLY with an array slice bound that shares a declared name', () => {
      // A KNOWN, documented collision rather than a solved case, pinned so the
      // trade is visible in the suite instead of being discovered in a run.
      // MEASURED: `(array[1,2,3])[1:hi]` is valid syntax (it reaches `42703
      // column "hi" does not exist`, i.e. it parsed). The rewrite consumes the
      // colon along with the name, so an operator who declares `hi` AND means a
      // column-bounded slice gets `[1$1]` — and MEASURED, that is `42601 syntax
      // error at or near "$1"`. The collision therefore fails at the first
      // describe, loudly and immediately; it never runs a DIFFERENT query.
      expect(rewrite('select (array[1,2,3])[1:hi]', { hi: 2 })).toEqual({
        sql: 'select (array[1,2,3])[1$1]',
        values: [2],
      });
    });
  });

  describe('regions the scanner must not rewrite inside', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      // MEASURED: `select 'it''s :id'` yields `it's :id`.
      ['a single-quoted literal, with a doubled quote', "select 'it''s :id' as v, :id"],
      // MEASURED: `select E'a\':id'` yields `a':id` — the backslash escapes the
      // quote, so a scanner that stops at the first `'` mis-locates the end.
      ['an E-string escaping a quote with a backslash', "select E'a\\':id' as v, :id"],
      // MEASURED: `select E'a\\'` yields `a\` — `\\` consumes two characters, so
      // the quote that follows really does terminate.
      ['an E-string ending in an escaped backslash', "select E'a\\\\' as v, :id"],
      // MEASURED: `select $$ it's :id $$` yields ` it's :id `.
      ['a plain dollar-quoted string', 'select $$ :id $$ as v, :id'],
      // MEASURED: `select $tag$ :id $tag$` yields ` :id `.
      ['a tagged dollar-quoted string', 'select $tag$ :id $tag$ as v, :id'],
      // MEASURED: `select $é$ :id $é$` yields ` :id ` — a tag may be non-ASCII,
      // so an ASCII-only tag scan would read this literal as CODE.
      ['a dollar-quoted string with a NON-ASCII tag', 'select $é$ :id $é$ as v, :id'],
      // MEASURED: `select $t1$ :id $t1$` yields ` :id ` — a digit may CONTINUE a
      // tag even though it cannot start one.
      ['a dollar-quoted string with a digit in its tag', 'select $t1$ :id $t1$ as v, :id'],
      // MEASURED: `select 1 as ":id"` names the column `:id`.
      ['a double-quoted identifier', 'select 1 as ":id", :id'],
      ['a double-quoted identifier with a doubled quote', 'select 1 as ":id""x", :id'],
      ['a line comment', 'select 1 -- :id\n, :id'],
      // MEASURED: `select 1 as n -- c\rselect 2 as m` raises `42601 syntax error
      // at or near "select"` — the comment ended at the CR, so CR terminates it.
      ['a line comment terminated by a bare CR', 'select 1 -- :id\r, :id'],
      // MEASURED: postgres block comments NEST — `/* a /* b */ c */` is valid,
      // and reading it un-nested raises `42601 unterminated /* comment`.
      ['a NESTED block comment', 'select 1 /* :id /* :id */ :id */, :id'],
    ];

    it.each(cases)('leaves `:id` alone inside %s', (_label, sql) => {
      const result = rewrite(sql, { id: 3 });
      // Exactly ONE rewrite happened — the trailing `:id`, which is in code.
      expect(result.sql).toBe(`${sql.slice(0, sql.length - 3)}$1`);
      expect(result.values).toEqual([3]);
    });

    it('does not read a word-final e before a quote as an E-string prefix', () => {
      // MEASURED: `select ae'x'` raises `42704 type "ae" does not exist` — so
      // postgres lexed `ae` as a type name and `'x'` as a PLAIN literal. Without
      // the preceding-character guard the scanner would honour backslashes in it
      // and mis-locate the terminator.
      expect(rewrite("select ae'a\\' as v, :id", { id: 3 })).toEqual({
        sql: "select ae'a\\' as v, $1",
        values: [3],
      });
    });
  });

  describe('`$` inside an identifier is not a dollar quote', () => {
    it('does not open a dollar quote on `a$$b`', () => {
      // MEASURED: `select 1 as a$$b` names the column `a$$b`; `select 1 as
      // a$q$x$q$` names `a$q$x$q$`. A scanner without the preceding-character
      // guard opens a dollar quote at the first `$` and runs to EOF, so the
      // `:id` after it is never rewritten and postgres gets a raw `:` — a false
      // refusal of working SQL.
      expect(rewrite('select a$$b from t where a > :id', { id: 3 })).toEqual({
        sql: 'select a$$b from t where a > $1',
        values: [3],
      });
      expect(rewrite('select a$q$x$q$ from t where a > :id', { id: 3 })).toEqual({
        sql: 'select a$q$x$q$ from t where a > $1',
        values: [3],
      });
    });
  });

  describe('a NON-ASCII identifier is still an identifier', () => {
    // MEASURED on `postgres:17`: `select 1 as é$1` names the column `é$1` and
    // `select 1 as é$$b` names `é$$b` — the `$` continues the identifier exactly
    // as it does in the ASCII `a$1`/`a$$b`. An ASCII-only adjacency test reads
    // the first as a positional placeholder and refuses valid SQL, and the
    // second as an opening dollar quote, swallowing the rest of the statement so
    // a real `:name` after it is never rewritten.
    it('does not read the `$1` in `é$1` as a positional placeholder', () => {
      expect(rewrite('select 1 as é$1, a from t where a > :id', { id: 3 })).toEqual({
        sql: 'select 1 as é$1, a from t where a > $1',
        values: [3],
      });
    });

    it('does not open a dollar quote on `é$$b`', () => {
      expect(rewrite('select é$$b from t where a > :id', { id: 3 })).toEqual({
        sql: 'select é$$b from t where a > $1',
        values: [3],
      });
    });

    it('binds a NON-ASCII parameter name, which sqlite already accepts', () => {
      // MEASURED: better-sqlite3 binds `:aé` and `:é` from this same record. An
      // ASCII-only name scan would leave a name sqlite takes unbindable on
      // postgres — the exact divergence #1194 exists to close.
      expect(rewrite('select a from t where a = :aé', { aé: 3 })).toEqual({
        sql: 'select a from t where a = $1',
        values: [3],
      });
    });
  });

  describe('a positional placeholder the operator wrote themselves', () => {
    it('is REFUSED when named parameters are also declared', () => {
      // The rewrite appends `$1..$k`, so a pre-existing `$1` would silently take
      // this module's value instead of the operator's own — silent corruption,
      // which is the one outcome worth a `permanent` refusal here.
      expect(() => rewrite('select a from t where a > $1 and b = :id', { id: 3 })).toThrowError(
        /positional/i,
      );
    });

    it('is NOT confused by `a$1`, which is an identifier', () => {
      // MEASURED: `select 1 as a$1` names the column `a$1`. Same guard as the
      // dollar-quote case; without it this is a permanent refusal of valid SQL.
      expect(rewrite('select a$1 from t where a > :id', { id: 3 })).toEqual({
        sql: 'select a$1 from t where a > $1',
        values: [3],
      });
    });
  });

  describe('text the scanner cannot finish reading', () => {
    it.each([
      ['an unterminated literal', "select 'oops, :id"],
      ['an unterminated block comment', 'select /* oops, :id'],
      ['an unterminated dollar quote', 'select $q$ oops, :id'],
    ])('leaves %s alone without throwing', (_label, sql) => {
      // The scanner ends inside the region and rewrites nothing further. It does
      // NOT invent a refusal: postgres raises the syntax error itself, with a
      // position, which is a better message than anything guessable from here.
      expect(rewrite(sql, { id: 3 })).toEqual({ sql, values: [] });
    });
  });
});
