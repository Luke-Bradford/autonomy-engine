import { isSqlIdentifier } from '@autonomy-studio/shared';
import { DatasetIoError } from './dataset-io-error.js';

/**
 * #1190 (M10 slice 2) — the SQL identifier-quoting rules, in ONE place.
 *
 * Lifted out of `sqlite.ts` when `postgres.ts` needed the same two functions.
 * That module already said why this belongs here rather than in each store —
 * "two byte-identical copies of an escaping rule is how the halves drift" — and
 * a second store is the moment the sentence stops being hypothetical.
 *
 * Doubling an embedded `"` is the SQL-standard escape and is what BOTH engines
 * implement, so the rule genuinely is shared; what is NOT shared is how each
 * engine treats an UNQUOTED name, and that difference is documented on
 * `quoteIdentifier` rather than smoothed over here.
 */
export function doubleQuoted(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Quote a SQL identifier — AFTER refusing anything that is not one.
 *
 * Both halves matter and neither is redundant. The shape check is the policy
 * (§8: a name that only a quoting rule makes safe is refused, not accommodated);
 * the quoting is what stops a reserved word being a syntax error. Doubling an
 * embedded `"` cannot fire given the shape check, and is kept so the function is
 * correct on its own terms rather than only in its current callers.
 *
 * THE POSTGRES CASE-FOLD, stated because it is a difference in MEANING and not
 * in escaping (#1190). Postgres folds an unquoted identifier to LOWER case, so
 * `"Users"` and an unquoted `Users` name two different relations; SQLite folds
 * nothing and the question does not arise. This function quotes ALWAYS, for both
 * stores, which means a postgres `table: 'Users'` addresses the relation spelled
 * `Users` — not the `users` an operator would have got by typing it unquoted in
 * psql.
 *
 * Quote-always is the choice because it is the only one that can address EVERY
 * relation: folding to lower case first would make a genuinely mixed-case table
 * unreachable, which is hostile in a tool whose entire purpose is moving data
 * out of stores it did not create. The cost is bounded and LOUD — a mismatch
 * raises `relation "Users" does not exist`, naming the exact spelling that was
 * tried — and it can never silently read the wrong table, because the quoted
 * name matches at most the relation with that exact spelling. A loud miss with
 * the name in it is strictly better than a silent hit on a different table.
 */
export function quoteIdentifier(value: string, label: string): string {
  if (!isSqlIdentifier(value)) {
    throw new DatasetIoError(
      'permanent',
      `${label} '${value}' is not a bare SQL identifier, so it cannot be quoted into a statement`,
    );
  }
  return doubleQuoted(value);
}
