import type { ConnectionKind } from '../schemas/connection.js';

/**
 * The `:name` bind placeholders in a `query` dataset's SQL, found the way each
 * store's own lexer finds them (#1194, #1600 OR41 C1q-c).
 *
 * Two callers ask the same lexical question and must get the same answer:
 * - the postgres reader (`server/connectors/postgres-named-parameters.ts`),
 *   which rewrites each declared `:name` to `$n` at dispatch, because `pg`
 *   binds positionally;
 * - the dock's bind values table, which derives its rows from the statement
 *   (*Import from statement*) and says when a stored value names nothing in it.
 *
 * It lives here, not in the server, so that the table and the reader cannot
 * disagree about which `:name`s a statement has. The scanner only FINDS
 * placeholders: what to rewrite, refuse or show is each caller's decision.
 *
 * ## Why a scanner and not a regex (postgres)
 *
 * `:` and `$` each mean several different things in postgres, and every one of
 * these was MEASURED on `postgres:17` rather than assumed:
 *
 * | text | what postgres does |
 * | --- | --- |
 * | `'it''s :id'` | a literal; `''` escapes a quote |
 * | `E'a\':id'` | `a':id` — a BACKSLASH escapes the quote |
 * | `$$ :id $$`, `$tag$ :id $tag$` | dollar-quoted literals |
 * | `1 as ":id"` | a quoted identifier, named `:id` |
 * | a block comment inside a block comment | valid — they NEST |
 * | `-- c` + CR | the comment ends at the CR |
 * | `a::int` | the cast operator, not a `:name` |
 * | `(array[1,2,3])[1:2]` | an array slice |
 * | `1 as a$$b`, `1 as a$1` | IDENTIFIERS — `$` is a name character |
 *
 * A regex over any one of those rewrites text postgres never treats as a
 * parameter. The last row is why every `$` rule below carries a preceding-
 * character guard: without it `select a$$b ... :id` opens a dollar quote at the
 * first `$`, runs to EOF, and the real `:id` is never rewritten.
 *
 * Unterminated text simply ends the scan inside the region; the store raises
 * the syntax error.
 *
 * `standard_conforming_strings` is assumed `on` — MEASURED on `postgres:17`,
 * and the default since postgres 9.1. With it OFF, `'a\'` continues the literal
 * and this scanner's terminator diverges from the server's; see the reader for
 * why that fails loud rather than silent.
 *
 * ## sqlite
 *
 * sqlite's tokenizer is a different language, MEASURED on better-sqlite3@12
 * (the reader's driver), which binds every one of these from the same record,
 * keyed without the prefix:
 *
 * | text | what sqlite does |
 * | --- | --- |
 * | `:a`, `@a`, `$a`, `#a` | the bind name `a`, whichever prefix |
 * | `?1` | the bind name `1` (a bare `?` is positional) |
 * | `:1`, `:a$b`, `:é` | names: a digit may start one, `$` and non-ASCII continue one |
 * | `[x:y]`, `` `x:y` ``, `"x:y"` | quoted identifiers |
 * | a block comment inside a block comment | the first close ends both — they do NOT nest |
 * | `-- :y` + CR | NOT ended by the CR: only LF ends a line comment |
 * | `:a::b`, `$a(x)` | refused — the build has no TCL variable syntax |
 *
 * There is no `E''` and no dollar quote, so a `$` is a placeholder prefix or a
 * name character, never a quote.
 */

/** A store whose SQL this module can scan: the stores a `query` dataset lives in. */
export type SqlDialect = Extract<ConnectionKind, 'sqlite' | 'postgres'>;

export type SqlPlaceholder =
  /** A named placeholder, keyed as the bind record keys it: without its prefix. */
  | { readonly kind: 'name'; readonly name: string; readonly start: number; readonly end: number }
  /** A postgres positional `$n` (only postgres reports one). */
  | { readonly kind: 'positional'; readonly start: number };

/**
 * What postgres's own lexer treats as CONTINUING an identifier, `$` included.
 *
 * UNICODE-AWARE, and that is load-bearing rather than thorough. MEASURED on
 * `postgres:17`: `select 1 as é$1` names the column `é$1` and `select 1 as é$$b`
 * names `é$$b` — exactly as the ASCII `a$1`/`a$$b` do. An ASCII-only test here
 * reads the `$` in `é$1` as a positional placeholder and refuses valid SQL, and
 * reads the `$$` in `é$$b` as opening a dollar-quoted string, swallowing the
 * rest of the statement so a real `:name` after it is never rewritten.
 *
 * NOT `SQL_IDENTIFIER_RE`, though it looks like the same fact. That regex is the
 * ALLOWLIST for an operator-declared table or schema name — an ASCII-only
 * validation policy, deliberately narrower than the lexer. This predicate is
 * asking a different question: what does postgres consider one token, in SQL
 * TEXT nobody validated. Borrowing the policy for the lexical question is what
 * produced the two failures above.
 *
 * NOR is it `\p{L}`, which is the SECOND way of asking the wrong question and the
 * one this module shipped with. Postgres does not classify identifier characters
 * by Unicode category at all: `scan.l` reads `ident_start [A-Za-z\200-\377_]`,
 * so in a multibyte encoding EVERY non-ASCII byte continues an identifier.
 * MEASURED on `postgres:17` (UTF8), every one of these names a column and not
 * one of them is a LETTER: `select 1 as 😀` (So), `select 1 as ¢` (Sc),
 * `select 1 as ²` (No), and `select 1 as \u0301x` — a lone COMBINING ACUTE
 * ACCENT (Mn), which postgres is content to have START an identifier.
 * `select $😀$ inner :id $😀$` is likewise a real dollar-quoted string.
 *
 * Exactly one of those the first rule (`\p{L}\p{N}_$`) survived: `²` is No, so
 * `\p{N}` caught it by luck. `😀` (So), `¢` (Sc), U+0301 (Mn) and a lone
 * surrogate half (Cs) fall in no category that rule named — so under it this
 * scanner did not see the `$😀$` tag, read the literal as CODE, and rewrote the
 * `:name` INSIDE it. That is the fail-open direction, the same hole a non-ASCII
 * tag opened before it.
 *
 * Testing the CODE UNIT rather than the code point is deliberate and is what
 * closes the astral-plane case for free: an astral character is a surrogate
 * pair, and both halves are `>= 0x80`, so each half answers this question the
 * same way the whole character would. A `\p{L}` test on `sql[i]` sees a lone
 * surrogate and matches nothing — the corner the category test could not reach
 * even in principle without code-point plumbing.
 */
function isIdentifierChar(char: string | undefined): boolean {
  return char !== undefined && (isNonAscii(char) || /[A-Za-z0-9_$]/.test(char));
}

/**
 * Postgres's `\200-\377` class, expressed in UTF-16. Every non-ASCII code unit
 * — including each half of a surrogate pair — encodes to UTF-8 bytes that are
 * all `>= 0x80`, so this is an exact restatement rather than an approximation.
 */
function isNonAscii(char: string): boolean {
  return char.charCodeAt(0) >= 0x80;
}

/**
 * What may START a bind name after `:`.
 *
 * Unicode for the same reason, and it costs nothing in portability: MEASURED,
 * better-sqlite3 binds `:aé` and `:é` from the same record, so an ASCII-only
 * scan here would leave a name sqlite accepts unbindable on postgres — the exact
 * divergence #1194 exists to close.
 */
function isNameStart(char: string | undefined): boolean {
  return char !== undefined && (isNonAscii(char) || /[A-Za-z_]/.test(char));
}

/**
 * The end of a `'…'` or `"…"` region, doubling being the escape. Returns the
 * index just PAST the closing quote, or the end of the string if there is none.
 */
function endOfDoubledQuoteRegion(sql: string, open: number, quote: string): number {
  let i = open + 1;
  while (i < sql.length) {
    if (sql[i] !== quote) {
      i += 1;
      continue;
    }
    if (sql[i + 1] === quote) {
      i += 2;
      continue;
    }
    return i + 1;
  }
  return sql.length;
}

/** The end of an `E'…'` region, where a BACKSLASH escapes the next character. */
function endOfEscapeStringRegion(sql: string, openQuote: number): number {
  let i = openQuote + 1;
  while (i < sql.length) {
    const char = sql[i];
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === "'") {
      if (sql[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return sql.length;
}

/**
 * What CONTINUES a dollar-quote tag: `isIdentifierChar` minus `$`, because a `$`
 * is what closes the tag rather than extending it. Same non-ASCII rule, for the
 * same measured reason — `$😀$ … $😀$` and `$é$ … $é$` are both real literals.
 */
function isTagChar(char: string): boolean {
  return isNonAscii(char) || /[A-Za-z0-9_]/.test(char);
}

/**
 * The `$tag$` delimiter opening at `start`, or `null` if this `$` opens no
 * dollar-quoted string. A tag follows unquoted-identifier rules and cannot
 * itself contain `$`, so `$1` is not a tag (a digit cannot start one) — MEASURED,
 * `$1t$ … $1t$` raises `42601 trailing junk after parameter`, i.e. postgres reads
 * the `$1` as a parameter too.
 *
 * MEASURED: `$é$ :id $é$` is a valid dollar-quoted string, so the tag charset is
 * unicode like every other identifier rule here. An ASCII-only tag scan reads
 * that literal as CODE and rewrites the `:id` inside it — the fail-open
 * direction, and the reason the whole module asks postgres's lexical question
 * rather than this repo's identifier-validation one.
 */
function dollarQuoteTagAt(sql: string, start: number): string | null {
  let i = start + 1;
  if (isNameStart(sql[i])) {
    i += 1;
    // `$` is excluded here and only here: a tag may not contain one, because a
    // `$` is what CLOSES it.
    while (i < sql.length && isTagChar(sql[i] as string)) i += 1;
  }
  return sql[i] === '$' ? sql.slice(start, i + 1) : null;
}

/** The end of a NESTED block comment — measured: postgres nests them. */
function endOfBlockComment(sql: string, start: number): number {
  let depth = 1;
  let i = start + 2;
  while (i < sql.length - 1) {
    if (sql[i] === '/' && sql[i + 1] === '*') {
      depth += 1;
      i += 2;
      continue;
    }
    if (sql[i] === '*' && sql[i + 1] === '/') {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    i += 1;
  }
  return sql.length;
}

/** The end of a `--` comment. Measured: a bare CR terminates one too. */
function endOfLineComment(sql: string, start: number): number {
  let i = start + 2;
  while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i += 1;
  return i;
}

/** The end of a NON-nesting block comment (sqlite). */
function endOfFlatBlockComment(sql: string, start: number): number {
  const close = sql.indexOf('*/', start + 2);
  return close === -1 ? sql.length : close + 2;
}

/** The end of a `--` comment that only LF ends (sqlite) — measured, a CR does not. */
function endOfLfLineComment(sql: string, start: number): number {
  const close = sql.indexOf('\n', start + 2);
  return close === -1 ? sql.length : close;
}

/** The end of a `[...]` identifier (sqlite): no escape, the first `]` closes it. */
function endOfBracketIdentifier(sql: string, start: number): number {
  const close = sql.indexOf(']', start + 1);
  return close === -1 ? sql.length : close + 1;
}

function scanPostgres(sql: string): SqlPlaceholder[] {
  const found: SqlPlaceholder[] = [];
  let i = 0;
  while (i < sql.length) {
    const char = sql[i] as string;
    const previous = i > 0 ? sql[i - 1] : undefined;

    if (char === '-' && sql[i + 1] === '-') {
      i = endOfLineComment(sql, i);
      continue;
    }
    if (char === '/' && sql[i + 1] === '*') {
      i = endOfBlockComment(sql, i);
      continue;
    }
    // `E'…'` only when the `e` begins a word — measured, `ae'x'` is the type
    // `ae` followed by a PLAIN literal, whose backslashes escape nothing.
    if ((char === 'e' || char === 'E') && sql[i + 1] === "'" && !isIdentifierChar(previous)) {
      i = endOfEscapeStringRegion(sql, i + 1);
      continue;
    }
    if (char === "'" || char === '"') {
      i = endOfDoubledQuoteRegion(sql, i, char);
      continue;
    }
    if (char === '$' && !isIdentifierChar(previous)) {
      const tag = dollarQuoteTagAt(sql, i);
      if (tag !== null) {
        const close = sql.indexOf(tag, i + tag.length);
        i = close === -1 ? sql.length : close + tag.length;
        continue;
      }
      if (/[0-9]/.test(sql[i + 1] ?? '')) found.push({ kind: 'positional', start: i });
    }
    // The cast operator, consumed whole so its second colon is never read as the
    // start of a name.
    if (char === ':' && sql[i + 1] === ':') {
      i += 2;
      continue;
    }
    if (char === ':' && isNameStart(sql[i + 1])) {
      // MAXIMAL MUNCH, because `$` is a name character: stopping at `a` would
      // turn `:a$b` into `$1$b`, whose `$b` then reads as a dollar quote.
      let end = i + 1;
      while (isIdentifierChar(sql[end])) end += 1;
      found.push({ kind: 'name', name: sql.slice(i + 1, end), start: i, end });
      i = end;
      continue;
    }
    i += 1;
  }
  return found;
}

function scanSqlite(sql: string): SqlPlaceholder[] {
  const found: SqlPlaceholder[] = [];
  let i = 0;
  while (i < sql.length) {
    const char = sql[i] as string;
    if (char === '-' && sql[i + 1] === '-') {
      i = endOfLfLineComment(sql, i);
      continue;
    }
    if (char === '/' && sql[i + 1] === '*') {
      i = endOfFlatBlockComment(sql, i);
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      i = endOfDoubledQuoteRegion(sql, i, char);
      continue;
    }
    if (char === '[') {
      i = endOfBracketIdentifier(sql, i);
      continue;
    }
    // A prefix at the START of a token opens a placeholder; `$` included, which
    // is otherwise a name character (checked first for that reason).
    if (char === ':' || char === '@' || char === '#' || char === '$') {
      let end = i + 1;
      while (isIdentifierChar(sql[end])) end += 1;
      if (end > i + 1) found.push({ kind: 'name', name: sql.slice(i + 1, end), start: i, end });
      i = Math.max(end, i + 1);
      continue;
    }
    // `?NNN` binds the key `NNN` from the record (measured); a bare `?` is
    // anonymous and positional, which a named record cannot bind.
    if (char === '?') {
      let end = i + 1;
      while (/[0-9]/.test(sql[end] ?? '')) end += 1;
      if (end > i + 1) found.push({ kind: 'name', name: sql.slice(i + 1, end), start: i, end });
      i = Math.max(end, i + 1);
      continue;
    }
    // A word is consumed whole, so a `$` inside one (`a$b`) is a name character
    // rather than a placeholder prefix.
    if (isIdentifierChar(char)) {
      while (isIdentifierChar(sql[i])) i += 1;
      continue;
    }
    i += 1;
  }
  return found;
}

/** Every placeholder in `sql`, in order, as `dialect`'s lexer finds them. */
export function scanSqlPlaceholders(sql: string, dialect: SqlDialect): SqlPlaceholder[] {
  return dialect === 'postgres' ? scanPostgres(sql) : scanSqlite(sql);
}

/** The distinct bind names `sql` uses, in first-appearance order. */
export function sqlBindNames(sql: string, dialect: SqlDialect): string[] {
  const names: string[] = [];
  for (const p of scanSqlPlaceholders(sql, dialect)) {
    if (p.kind === 'name' && !names.includes(p.name)) names.push(p.name);
  }
  return names;
}

/** Each store's whitespace: postgres's `scan.l` `space`, sqlite's `sqlite3Isspace`. */
const SQL_SPACE: Record<SqlDialect, RegExp> = {
  postgres: /[ \t\n\r\f\v]/,
  sqlite: /[ \t\n\f\r]/,
};

/**
 * #1600 OR41 C3b — the first word of `sql`, upper-cased, after the whitespace
 * and comments `dialect`'s own lexer skips; `null` when the text does not begin
 * with a word.
 *
 * The pre-copy script's allow-list keys on this, and on sqlite it is the only
 * barrier between authored SQL and an `ATTACH` or `VACUUM INTO` that writes a
 * file outside the connection's roots. So it errs one way only: anything it does
 * not recognise as a leading word (a `;`, a `(`, a quote, an unclosed comment)
 * is `null`, which the caller refuses. MEASURED by the C3b plan review:
 * better-sqlite3 runs `;attach database …`, so a scan that stepped over a `;`
 * would have read the empty statement's successor as the statement.
 *
 * Skipping a character the store does not skip only makes the store raise a
 * syntax error, and not skipping one it does only refuses here, so neither
 * divergence lets a different statement through.
 */
export function sqlLeadingKeyword(sql: string, dialect: SqlDialect): string | null {
  let i = 0;
  while (i < sql.length) {
    const char = sql[i] as string;
    if (SQL_SPACE[dialect].test(char)) {
      i += 1;
    } else if (char === '-' && sql[i + 1] === '-') {
      i = dialect === 'postgres' ? endOfLineComment(sql, i) : endOfLfLineComment(sql, i);
    } else if (char === '/' && sql[i + 1] === '*') {
      i = dialect === 'postgres' ? endOfBlockComment(sql, i) : endOfFlatBlockComment(sql, i);
    } else {
      break;
    }
  }
  if (!/[A-Za-z]/.test(sql[i] ?? '')) return null;
  let end = i;
  while (isIdentifierChar(sql[end])) end += 1;
  return sql.slice(i, end).toUpperCase();
}
