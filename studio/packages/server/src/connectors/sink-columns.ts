import { nocaseFold, type DatasetColumn } from '@autonomy-studio/shared';
import { DatasetIoError } from './dataset-io-error.js';

/**
 * #1196 M10 slice 3a — resolving a mapping's sink names onto the store's OWN
 * spelling of each column, shared by both sink writers.
 *
 * Lifted out of `sqlite-sink.ts` when postgres became the second sink. The
 * matching rule is not store-specific and copying it would have put two
 * versions of "is this the same column" in the tree — the defect
 * `sql-identifier.ts` was extracted to stop, one layer up.
 */

/** One resolved column: what the incoming rows are keyed by, and what the
 * statement must name. */
export interface SinkColumn {
  /** The key the incoming rows use — the mapping's `sink` name. */
  readonly mapped: string;
  /** The store's own spelling, which is what the statement names. */
  readonly actual: string;
}

/**
 * Resolve each mapped column onto the store's own spelling of it, CASE-INSENSITIVELY.
 *
 * SQLite matches column names without regard to case — measured: `INSERT INTO
 * "t" ("ID")` succeeds against a column declared `id` — and §6.3's auto-map is
 * itself "case-insensitive, trimmed", so the authoring surface generates exactly
 * this input. §7's refusal is for a column that is ABSENT, and a case variant is
 * not absent; an exact-string match would `permanent`-refuse a mapping SQLite
 * would have executed. Postgres reaches the same place by a different route: it
 * folds an UNQUOTED identifier to lower case, so a table created
 * `CREATE TABLE t (ID int)` really does have a column named `id`, and a mapping
 * that still says `ID` names it correctly.
 *
 * BOTH spellings are kept, and that is not tidiness. The store's spelling goes
 * into the statement, so the SQL reads the way the schema does; the MAPPED
 * spelling is what the incoming rows are keyed by, because the pump keys a row
 * by the mapping's `sink` name and has never seen the store. Collapsing the two
 * makes a case-differing mapping bind `undefined` for every row.
 *
 * Two mapped columns collapsing onto one actual column is REFUSED: it is silent
 * last-wins into the operator's table, the same defect `CopyMappingSchema`'s
 * duplicate-sink rule exists for, and one that rule cannot see because the two
 * names differ as strings.
 *
 * **Two ACTUAL columns collapsing onto one fold is refused too, and that rung is
 * new because postgres is the first store that can produce it.** SQLite refuses
 * to create `SINK` alongside `sink`, so its `describeSinkTable` could never hand
 * back a colliding pair; postgres will, because a quoted identifier is exact —
 * measured, `create table cc("id" int, "ID" int)` succeeds and reports both. A
 * fold-keyed index over that pair silently keeps whichever came last, so a
 * mapping naming `id` would write into whichever column the catalog order
 * happened to yield. There is no honest answer to pick, so it refuses.
 *
 * It refuses only when a MAPPED name lands on the ambiguous fold, never on the
 * mere presence of such a pair somewhere in the table. A copy that never touches
 * the colliding columns is work that would have succeeded, and refusing it is
 * the one direction §7 says a gate must not fail in.
 */
export function resolveSinkColumns(
  mapped: readonly string[],
  actual: readonly string[],
): SinkColumn[] {
  /* `nocaseFold`, NOT `toLowerCase()` — #1151. SQLite's NOCASE collation folds
     ASCII `A-Z` only, so `K` (KELVIN SIGN) and `k` are different identifiers
     to the store, while `toLowerCase()` folds one onto the other. Using the JS
     fold here made this resolver claim a column SQLite would never have matched,
     and left the sink and the source-side drift gate — which already shares this
     function — able to disagree about whether two names are the same column. */
  const byFold = new Map<string, string>();
  const ambiguousFolds = new Map<string, string[]>();
  for (const name of actual) {
    const fold = nocaseFold(name);
    const earlier = byFold.get(fold);
    if (earlier === undefined) {
      byFold.set(fold, name);
      continue;
    }
    const seen = ambiguousFolds.get(fold) ?? [earlier];
    seen.push(name);
    ambiguousFolds.set(fold, seen);
  }

  const resolved: SinkColumn[] = [];
  const claimed = new Map<string, string>();
  const missing: string[] = [];
  const collisions: string[] = [];
  const ambiguous: string[] = [];
  const actualExact = new Set(actual);
  for (const name of mapped) {
    const fold = nocaseFold(name);
    const clash = ambiguousFolds.get(fold);
    if (clash !== undefined && !actualExact.has(name)) {
      // AMBIGUOUS, and no exact spelling to fall back on. An EXACT match is
      // preferred over refusing (see `actualExact` above): postgres identifiers
      // are exact once quoted, so a mapping that names `id` where the store has
      // both `id` and `"ID"` has in fact named one of them unambiguously — and
      // refusing it would make this rung's own advice ("name the column exactly
      // as the store spells it") impossible to follow.
      ambiguous.push(
        `'${name}' matches ${clash.map((c) => `'${c}'`).join(' and ')} in the sink, which differ only in case`,
      );
      continue;
    }
    const match = clash !== undefined ? name : byFold.get(fold);
    if (match === undefined) {
      missing.push(name);
      continue;
    }
    const earlier = claimed.get(match);
    if (earlier !== undefined) {
      collisions.push(`'${earlier}' and '${name}' both resolve to the sink column '${match}'`);
      continue;
    }
    claimed.set(match, name);
    resolved.push({ mapped: name, actual: match });
  }
  // ALL the problems, in ONE refusal. Throwing on the first collision mid-pass
  // reports only whichever defect the array order happened to reach first, so a
  // mapping with two faults takes two runs to diagnose.
  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(`the sink has no column named ${missing.map((m) => `'${m}'`).join(', ')}`);
  }
  if (collisions.length > 0) {
    problems.push(`${collisions.join('; ')} (each sink column may be written by one mapping row)`);
  }
  if (ambiguous.length > 0) {
    problems.push(
      `${ambiguous.join('; ')} — name the column exactly as the store spells it, or rename one of them`,
    );
  }
  if (problems.length > 0) throw new DatasetIoError('permanent', problems.join('. '));
  return resolved;
}

/**
 * Where a refusal's "this column is NOT NULL" came from. Two sources, ONE rule
 * (#1162) — and the lookup differs between them on purpose, so it is spelled
 * out per source rather than hidden behind a predicate.
 *
 * - `dataset`: the sink dataset's DECLARED columns. Matched by `nocaseFold`,
 *   because a declaration is operator-authored and is not the store's spelling.
 * - `store`: the store's ACTUAL schema, read by the sink under its write lock.
 *   Matched by the EXACT store spelling the shared resolver has already paired
 *   each mapped name with — never by a fold. Postgres can hold `id` and `"ID"`
 *   side by side (`resolveSinkColumns`' docblock), and a fold-keyed set would
 *   let one's NOT NULL refuse a write into the other: the over-refusal
 *   `refuseUnwritableColumns` was restructured to avoid, one rung over.
 *   `notNullActual` must hold only columns that CERTAINLY refuse an explicit
 *   NULL; each sink states what it had to leave out to guarantee that.
 */
export type NotNullEvidence =
  | { readonly kind: 'dataset'; readonly columns: readonly DatasetColumn[] }
  | {
      readonly kind: 'store';
      readonly resolved: readonly SinkColumn[];
      readonly notNullActual: ReadonlySet<string>;
    };

/**
 * §6.2's refusal: `onError: 'null'` onto a NOT NULL column.
 *
 * `onError: 'null'` writes a null where a value fails to coerce. Against a NOT
 * NULL column that turns a coercion failure into a CONSTRAINT violation raised
 * by the store, mid-copy, after rows have already been read and written into
 * the open transaction. Refusing before the first row moves keeps the failure
 * at the boundary, and names the mapping row that causes it.
 *
 * It runs twice per copy. At DISPATCH (`copy.ts`) against what the sink dataset
 * declares — before any store is opened. Then inside each database sink,
 * against the store's actual schema — because §7 says the declared schema is
 * deliberately not the gate, so a column the dataset calls nullable but the
 * store declares NOT NULL used to reach the store and fail there (#1162).
 *
 * The store half is a stated BEHAVIOUR BREAK: a copy with `onError: 'null'`
 * into such a column is now refused up front even if no value would in fact
 * have failed to coerce. That is the break the declared half has always made;
 * it now holds for the real schema too.
 *
 * It checks only columns the evidence knows about. An undeclared or unresolved
 * column is not this rule's business: whether a column exists is §7's drift
 * gate (`resolveSinkColumns`), and widening this into an existence check would
 * duplicate that gate with weaker evidence.
 *
 * `nullOnError` is the mapping's `sink` names whose row sets `onError: 'null'`.
 */
export function refuseNullOnNonNullable(
  nullOnError: readonly string[],
  evidence: NotNullEvidence,
): string | null {
  let offender: string | undefined;
  if (evidence.kind === 'dataset') {
    // Folded the way SQLite's NOCASE folds, via the SAME helper the pump plans
    // columns with. A case-sensitive check would let a sink declaring 'ID' and
    // a mapping naming 'id' — ONE column to the store — through to become the
    // mid-copy constraint violation this rung exists to move to the boundary.
    const nonNullable = new Set(
      evidence.columns
        .filter((column) => !column.nullable)
        .map((column) => nocaseFold(column.name)),
    );
    offender = nullOnError.find((sink) => nonNullable.has(nocaseFold(sink)));
  } else {
    const actualOf = new Map(evidence.resolved.map((column) => [column.mapped, column.actual]));
    offender = nullOnError.find((sink) => {
      const actual = actualOf.get(sink);
      return actual !== undefined && evidence.notNullActual.has(actual);
    });
  }
  if (offender === undefined) return null;
  const who =
    evidence.kind === 'dataset'
      ? 'the sink dataset declares that column NOT NULL'
      : 'the sink table in the store is NOT NULL on that column';
  return (
    `mapping row for sink column '${offender}' sets onError:'null', but ${who} — a coercion ` +
    `failure would reach the store as a constraint violation mid-copy, after rows have already ` +
    `been read and written`
  );
}
