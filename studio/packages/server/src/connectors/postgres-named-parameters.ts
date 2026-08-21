import type { SqlParameterValue } from '@autonomy-studio/shared';

import { DatasetIoError } from './dataset-io-error.js';

/**
 * #1194 — a `query` dataset's NAMED parameters, bound on postgres.
 *
 * ## The divergence this closes
 *
 * `queryDatasetConfigSchema.parameters` is a record of named bind values "keyed
 * WITHOUT the `:` prefix the SQL carries". better-sqlite3 binds those by name;
 * `pg` has no named parameters at all, it binds POSITIONALLY (`$1`). M10 slice 2
 * therefore REFUSED a postgres `query` dataset that declared any, so the same
 * dataset config meant something in one store and nothing in the other. This
 * module makes `:name` the portable AUTHORING style and each store's reader
 * responsible for binding it — here, by rewriting to `$n` at dispatch.
 *
 * IT IS STILL NOT INTERPOLATION, and §8's rule is untouched: the operator's
 * VALUES never enter the statement text. What is rewritten is the PLACEHOLDER,
 * from one spelling to another; the values leave over the wire as bind
 * parameters exactly as they did on sqlite.
 *
 * ## Why a scanner and not a regex
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
 * ## What it deliberately does NOT do
 *
 * - **An UNDECLARED `:name` is left byte-identical.** This module's authority is
 *   exactly the names the operator declared. Postgres has valid syntax in which
 *   a `:` is not a parameter (`arr[1:hi]`), so refusing on sight would be a gate
 *   parsing an operator's SQL badly — the one direction §7 ② says a gate must
 *   never fail in. Postgres's own `42601`, which carries a position, is a better
 *   message than anything guessable from here. (The converse collision is real
 *   and pinned in the suite: an operator who declares `hi` AND writes
 *   `arr[1:hi]` has the slice colon rewritten with it, giving `arr[1$1]`.
 *   MEASURED, that is `42601 syntax error at or near "$1"` — so the collision
 *   fails at the first describe, loudly, and never runs a DIFFERENT query. It is
 *   a known trade, not an oversight.)
 * - **An UNUSED declared parameter is dropped rather than refused.** MEASURED on
 *   better-sqlite3@12.11.1: an extra named value is silently ignored. Since the
 *   point of #1194 is that one config means the same thing in both stores, a
 *   postgres-only refusal would re-break what it exists to fix. It is forced
 *   anyway — a spare value is `08P01` on postgres, so it cannot be passed on.
 * - **Unterminated text is not refused.** The scanner simply ends inside the
 *   region and rewrites nothing further; postgres raises the syntax error.
 *
 * The ONE refusal is a pre-existing positional `$n` alongside declared names,
 * because the rewrite appends `$1..$k` and would silently bind this module's
 * value to the operator's own placeholder. That is silent corruption, which is
 * the only outcome here worth a `permanent`. It is CONDITIONAL on named
 * parameters being declared, and deliberately so: an unconditional refusal would
 * be this module parsing SQL it was not asked to touch, and a statement with no
 * declared names is not scanned at all.
 *
 * ## Two assumptions, stated rather than smoothed over
 *
 * - `standard_conforming_strings` is `on` — MEASURED on this server, and the
 *   default since postgres 9.1. With it OFF, `'a\'` continues the literal and
 *   this scanner's terminator diverges from the server's. That fails LOUD (a
 *   syntax error, or `08P01` for a value with no placeholder), never silently,
 *   so it is not `SET` here: `postgres-session.ts` is shared with the sink and a
 *   session-wide `SET` for this would have a blast radius the ticket does not
 *   own.
 * - A value's TYPE can differ across stores. MEASURED: a bare `$1` infers `text`,
 *   so `select :id` with `3` yields `'3'` on postgres where sqlite yields `3`.
 *   The describe seam is names-only, so §7's drift gate is unaffected; the row
 *   data reaches §6.2's coercion matrix, which is where that difference is
 *   already handled.
 *
 * Note for the prose the catalog carries: better-sqlite3 ALSO binds `@name` and
 * `$name` from the same record (measured). Those two are sqlite-only — `$name`
 * is a dollar-quote opener on postgres — so `:name` is the portable spelling.
 */
export interface PostgresStatement {
  /** The statement with every declared `:name` rewritten to `$n`. */
  readonly sql: string;
  /** One value per DISTINCT rewritten name, in first-appearance order. */
  readonly values: readonly SqlParameterValue[];
}

/** `[A-Za-z0-9_$]` — what may continue an identifier, per `SQL_IDENTIFIER_RE`. */
function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$]/.test(char);
}

function isNameStart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z_]/.test(char);
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
 * The `$tag$` delimiter opening at `start`, or `null` if this `$` opens no
 * dollar-quoted string. A tag follows unquoted-identifier rules and cannot
 * itself contain `$`, so `$1` is not a tag (a digit cannot start one) — MEASURED,
 * `$1t$ … $1t$` raises `42601 trailing junk after parameter`, i.e. postgres reads
 * the `$1` as a parameter too.
 *
 * The charset is UNICODE-aware, unlike the `:name` scan above it, and the
 * asymmetry is deliberate rather than an oversight. MEASURED: `$é$ :id $é$` is a
 * valid dollar-quoted string. Missing a tag means treating a LITERAL as code and
 * rewriting inside it, which is the fail-open direction; missing a `:name` only
 * means leaving text alone, which is this module's documented default. So the
 * region detector is generous and the rewrite trigger is narrow.
 */
function dollarQuoteTagAt(sql: string, start: number): string | null {
  let i = start + 1;
  if (sql[i] !== undefined && /[\p{L}_]/u.test(sql[i] as string)) {
    i += 1;
    while (i < sql.length && /[\p{L}\p{N}_]/u.test(sql[i] as string)) i += 1;
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

/**
 * Rewrite the declared `:name` placeholders in `sql` to `$n`, and return the
 * values to bind alongside, in placeholder order.
 *
 * With no declared parameters the statement is returned UNTOUCHED and the
 * scanner never runs, so the pre-#1194 path cannot be perturbed by any shape of
 * SQL.
 *
 * @throws DatasetIoError `permanent` if the statement already carries a
 * positional placeholder while also declaring named parameters.
 */
export function rewriteNamedParametersToPositional(
  sql: string,
  parameters: Readonly<Record<string, SqlParameterValue>> | undefined,
): PostgresStatement {
  if (parameters === undefined || Object.keys(parameters).length === 0) {
    return { sql, values: [] };
  }

  const order: string[] = [];
  const positionOf = new Map<string, number>();
  const pieces: string[] = [];
  let copiedTo = 0;
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
    if ((char === 'e' || char === 'E') && sql[i + 1] === "'" && !isWordChar(previous)) {
      i = endOfEscapeStringRegion(sql, i + 1);
      continue;
    }
    if (char === "'" || char === '"') {
      i = endOfDoubledQuoteRegion(sql, i, char);
      continue;
    }
    if (char === '$' && !isWordChar(previous)) {
      const tag = dollarQuoteTagAt(sql, i);
      if (tag !== null) {
        const close = sql.indexOf(tag, i + tag.length);
        i = close === -1 ? sql.length : close + tag.length;
        continue;
      }
      if (/[0-9]/.test(sql[i + 1] ?? '')) {
        throw new DatasetIoError(
          'permanent',
          'this query dataset declares named `parameters` and its SQL also uses a positional placeholder ' +
            `(\`${sql.slice(i, i + 2)}\`); the named values are bound as $1 upwards, so the two would ` +
            'collide — use one style or the other',
        );
      }
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
      while (isWordChar(sql[end])) end += 1;
      const name = sql.slice(i + 1, end);
      if (Object.prototype.hasOwnProperty.call(parameters, name)) {
        let position = positionOf.get(name);
        if (position === undefined) {
          order.push(name);
          position = order.length;
          positionOf.set(name, position);
        }
        pieces.push(sql.slice(copiedTo, i), `$${String(position)}`);
        copiedTo = end;
      }
      i = end;
      continue;
    }
    i += 1;
  }

  if (order.length === 0) return { sql, values: [] };
  pieces.push(sql.slice(copiedTo));
  return {
    sql: pieces.join(''),
    values: order.map((name) => parameters[name] as SqlParameterValue),
  };
}
