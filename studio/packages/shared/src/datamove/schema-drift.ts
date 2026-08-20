import type { CopyPumpMappingEntry } from './pump.js';

/**
 * #996 M6 (#1148), spec §7 — the SOURCE half of the drift gate, and the one
 * predicate that resolves a mapping entry onto a source column.
 *
 * §7 names three schemas that must not be conflated: the dataset's DECLARED
 * columns (1, a mutable authoring aid), the node's MAPPING (2, immutable inside
 * the pipeline version) and the store's ACTUAL columns at run time (3,
 * discovered). The gate is (2) against (3). This module is (2)-against-(3) for
 * the source, expressed over a plain list of column names so it is
 * store-agnostic: M7's `delimited` source hands it a CSV header row and M10's
 * postgres a result-set description, and neither needs a second implementation.
 *
 * WHY THE RESOLVER LIVES HERE AND NOT IN `pump.ts`, WHICH USED TO OWN IT.
 * Before M6 the only source-column check ran inside `planColumns`, from the
 * FIRST ROW's key set — so it fired from inside the sink's open write
 * transaction, and never fired at all against an empty source (a mapping naming
 * a column that does not exist reported SUCCESS over 0 rows). M6 adds a
 * dispatch-time gate that runs before the first row moves, and #1148 is explicit
 * that it must not become "a second, looser copy" of the existing rule. So the
 * per-entry resolution is extracted ONCE and both callers use it: the gate for
 * its early, well-named refusal, the pump as the binding-time check that has
 * actually seen the rows.
 */

/**
 * Fold for comparison the way SQLite's `NOCASE` does — ASCII `A-Z` ONLY.
 *
 * Not `toLowerCase()`, which is Unicode-aware and therefore folds MORE than the
 * collation this claims to mirror: `'K'` (KELVIN SIGN) lowercases to `k` in
 * JavaScript while SQLite treats the two as different identifiers entirely, so a
 * mapping naming one would silently bind to the other. Exotic, and that is
 * precisely why it would never be found later.
 *
 * MOVED here from `pump.ts` by M6, unchanged: the gate and the pump must fold
 * identically or they disagree about what "the same column" means, and the one
 * that disagrees is whichever ran second.
 */
export function nocaseFold(value: string): string {
  return value.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * The source's column names, indexed for matching — built ONCE per copy.
 *
 * Both spellings are kept because both are load-bearing: an EXACT match always
 * wins, and only a name matching neither exactly and more than one loosely is
 * ambiguous. A source really can carry both `name` and `Name` (SQLite's result
 * columns are not folded), and binding those by declaration order would be a
 * silent wrong-column read.
 */
export interface SourceColumnIndex {
  readonly exact: ReadonlySet<string>;
  readonly lowered: ReadonlyMap<string, readonly string[]>;
  /** In statement order, each distinct EXACT name once — see {@link indexSourceColumns}. */
  readonly names: readonly string[];
}

export function indexSourceColumns(names: readonly string[]): SourceColumnIndex {
  // COLLAPSED to distinct exact names, and that is not tidiness. A statement may
  // report one name twice — `SELECT i, i` gives `['i','i']` from
  // `Statement.columns()` (measured, better-sqlite3 12.11.1) — while the row it
  // yields is an OBJECT and therefore carries the name ONCE. Left uncollapsed
  // the gate would see two candidates and refuse `ambiguous_source_column` for a
  // copy the pump binds without complaint: a `permanent` refusal of working
  // work, which is the one direction a gate must never fail in.
  const distinct: string[] = [];
  const exact = new Set<string>();
  for (const name of names) {
    if (exact.has(name)) continue;
    exact.add(name);
    distinct.push(name);
  }
  const lowered = new Map<string, string[]>();
  for (const name of distinct) {
    const lower = nocaseFold(name);
    const bucket = lowered.get(lower);
    if (bucket) bucket.push(name);
    else lowered.set(lower, [name]);
  }
  return { exact, lowered, names: distinct };
}

/** What one mapping entry's `source` resolves to against a given source. */
export type SourceResolution =
  /** Bound to `key`, which is the source's OWN spelling — rows are keyed by it. */
  | { readonly kind: 'bound'; readonly key: string }
  /** Absent, but the entry opted out with `onError: 'null'`, so it writes null. */
  | { readonly kind: 'null' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'ambiguous' };

/**
 * Resolve ONE entry's `source` against the indexed source columns.
 *
 * Callers must have established that `entry.source !== undefined` — an
 * expression-only entry reads no source column and is not this function's
 * business. The `onError: 'null'` branch is part of the resolution and not a
 * caller's to re-apply: it is the column's own opt-out ("if this column cannot
 * produce a value, write null"), and a gate that refused where the pump absorbs
 * would refuse copies that succeed today.
 */
export function resolveSourceColumn(
  entry: Pick<CopyPumpMappingEntry, 'source' | 'onError'>,
  index: SourceColumnIndex,
): SourceResolution {
  const source = entry.source;
  if (source === undefined) return { kind: 'missing' };
  if (index.exact.has(source)) return { kind: 'bound', key: source };
  const candidates = index.lowered.get(nocaseFold(source)) ?? [];
  if (candidates.length > 1) return { kind: 'ambiguous' };
  if (candidates.length === 1) return { kind: 'bound', key: candidates[0] as string };
  if (entry.onError === 'null') return { kind: 'null' };
  return { kind: 'missing' };
}

/** §7's source-side verdict: what refuses the copy, and what merely warns. */
export interface SourceDrift {
  /** §7 row 1 — mapped source columns absent from the actual source. */
  readonly missing: readonly string[];
  /** Not a §7 row: a name matching several actual columns loosely and none exactly. */
  readonly ambiguous: readonly string[];
  /**
   * §7 row 4 — actual source columns the mapping does not mention. ALLOWED, and
   * reported: additive drift must never break a working pipeline, but silent
   * additive drift is how a mapping quietly stops covering its source.
   *
   * (§7 row 5 — an UNMAPPED column that disappeared — is allowed and silent, and
   * needs no code: it was never read, so nothing here can see it go.)
   */
  readonly unmapped: readonly string[];
}

export function checkSourceDrift(
  mapping: readonly CopyPumpMappingEntry[],
  sourceColumns: readonly string[],
): SourceDrift {
  const index = indexSourceColumns(sourceColumns);
  const missing: string[] = [];
  const ambiguous: string[] = [];
  const bound = new Set<string>();
  for (const entry of mapping) {
    if (entry.source === undefined) continue;
    const resolved = resolveSourceColumn(entry, index);
    if (resolved.kind === 'bound') bound.add(resolved.key);
    else if (resolved.kind === 'missing') missing.push(entry.source);
    else if (resolved.kind === 'ambiguous') ambiguous.push(entry.source);
  }
  // An EMPTY mapping reports nothing unmapped. It is refused outright by the
  // pump (`empty_mapping`), and listing every column of the source as "not
  // mentioned" would bury that refusal under a warning about its consequence.
  const unmapped = mapping.length === 0 ? [] : index.names.filter((name) => !bound.has(name));
  return { missing, ambiguous, unmapped };
}
