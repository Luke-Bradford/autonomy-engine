import { scanSqlPlaceholders, type SqlParameterValue } from '@autonomy-studio/shared';

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
 * ## The scanner is shared
 *
 * WHICH text is a `:name` is a lexical question about postgres SQL with many
 * measured traps (`E''`, dollar quotes, nested comments, `::`, `$` as a name
 * character). The scanner that answers it is `scanSqlPlaceholders` in
 * `@autonomy-studio/shared` (`datamove/sql-placeholders.ts`, where the measured
 * table lives), so the dock's bind values table finds exactly the names this
 * reader rewrites (#1600 OR41 C1q-c). This module decides what to DO with them.
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

  const placeholders = scanSqlPlaceholders(sql, 'postgres');
  // Refused whether or not a declared name is ever rewritten: the rewrite would
  // append `$1..$k` alongside the operator's own placeholder.
  const positional = placeholders.find((p) => p.kind === 'positional');
  if (positional !== undefined) {
    throw new DatasetIoError(
      'permanent',
      'this query dataset declares named `parameters` and its SQL also uses a positional placeholder ' +
        `(\`${sql.slice(positional.start, positional.start + 2)}\`); the named values are bound as $1 upwards, so the two would ` +
        'collide — use one style or the other',
    );
  }

  const order: string[] = [];
  const positionOf = new Map<string, number>();
  const pieces: string[] = [];
  let copiedTo = 0;
  for (const p of placeholders) {
    if (p.kind !== 'name' || !Object.prototype.hasOwnProperty.call(parameters, p.name)) continue;
    let position = positionOf.get(p.name);
    if (position === undefined) {
      order.push(p.name);
      position = order.length;
      positionOf.set(p.name, position);
    }
    pieces.push(sql.slice(copiedTo, p.start), `$${String(position)}`);
    copiedTo = p.end;
  }

  if (order.length === 0) return { sql, values: [] };
  pieces.push(sql.slice(copiedTo));
  return {
    sql: pieces.join(''),
    values: order.map((name) => parameters[name] as SqlParameterValue),
  };
}
