import type { DataType, DatasetColumn } from '../schemas/dataset.js';

import { indexSourceColumns, nocaseFold, resolveSourceColumn } from './schema-drift.js';

/**
 * #996 M8 slice 2 (#1170), spec §6.3 + §13 — the AUTHORING-time half of mapping:
 * what auto-map writes, and which declared columns a mapping leaves alone.
 *
 * WHY THIS IS NOT `schema-drift.ts`, WHICH LOOKS LIKE THE SAME QUESTION.
 * §7 names three schemas that must not be conflated: a dataset's DECLARED
 * columns (1), the node's MAPPING (2), and the store's ACTUAL columns at run
 * time (3). `schema-drift.ts` is the dispatch GATE and compares (2) against (3).
 * Everything here compares (1) against (2) and is therefore **advisory** — a
 * declared list is a mutable authoring aid that can be stale, so nothing in this
 * module may ever refuse a copy. `DatasetSchema.columns`' own docblock states
 * that distinction, and the gate deliberately does not read the declared list.
 *
 * WHY IT REUSES THE GATE'S PRIMITIVES ANYWAY, AND WHY THAT IS LOAD-BEARING.
 * Auto-map's whole output is a mapping the gate will later resolve. Matching by
 * any other rule would let it write a row it believes is fine and the gate then
 * refuses — a button that authors a broken copy is worse than no button. So the
 * name matching goes through `indexSourceColumns`/`resolveSourceColumn`, and the
 * sink side folds with `nocaseFold` exactly as `resolveSinkColumns` does.
 *
 * §6.3's "trimmed" is DELIBERATELY NOT IMPLEMENTED. The spec's parenthetical
 * says auto-map matches "case-insensitive, trimmed", but neither the source
 * resolver nor the store's sink resolver trims. A trimmed match would bind
 * declared `" id "` to source `id` and then emit a row whose `sink` is `" id "`,
 * which `resolveSinkColumns` cannot match against the actual column `id` — i.e.
 * trimming would author precisely the unrunnable row this module exists to
 * avoid. Matching agrees with the gate instead; the as-built block records it.
 */

/** One row auto-map writes. `onError` is fixed — see {@link autoMapMapping}. */
export interface AutoMapRow {
  readonly source: string;
  readonly sink: string;
  readonly type: DataType;
  readonly onError: 'fail';
}

export interface AutoMapResult {
  readonly rows: readonly AutoMapRow[];
  /** Sink columns matching more than one source column loosely and none exactly. */
  readonly ambiguous: readonly string[];
  /** Sink columns the source has no column for. */
  readonly unmatched: readonly string[];
  /** Sink columns an EXISTING mapping row already claims — the ADDITIVE skip. */
  readonly alreadyMapped: readonly string[];
  /**
   * Sink columns skipped because an EARLIER DECLARED column folded onto the same
   * target. Kept apart from {@link alreadyMapped}, which the author caused: this
   * one is a fault in the dataset's declared list, and reporting it as "already
   * mapped" would tell them they mapped a column they have never touched.
   */
  readonly duplicateDeclared: readonly string[];
}

/**
 * Match source→sink by name and return the rows to ADD.
 *
 * ADDITIVE, never a replacement: `mappedSinks` carries the sink columns the
 * current mapping already claims, and those are skipped. Replacing would
 * silently destroy hand-authored rows — in particular `expression` rows, which
 * auto-map cannot regenerate because it only ever binds a source column.
 *
 * `onError` is always `'fail'`. §6.2 refuses `'null'` where the sink column is
 * `nullable: false`, so it is the only value that is correct unattended; an
 * author who wants the opt-out sets it on the row.
 */
export function autoMapMapping(
  sourceColumns: readonly DatasetColumn[],
  sinkColumns: readonly DatasetColumn[],
  mappedSinks: readonly string[],
): AutoMapResult {
  const index = indexSourceColumns(sourceColumns.map((c) => c.name));
  // FOLDED, not exact. `refineMapping` dedupes sinks by exact string, but the
  // store resolves them folded and refuses the collision ("each sink column may
  // be written by one mapping row"). An exact-only skip list would add a second
  // row for `ID` beside the author's `id`, pass every save-time check, and fail
  // `permanent` at dispatch.
  const claimed = new Set(mappedSinks.map(nocaseFold));
  const rows: AutoMapRow[] = [];
  const ambiguous: string[] = [];
  const unmatched: string[] = [];
  const alreadyMapped: string[] = [];
  const duplicateDeclared: string[] = [];
  /** Folds bound by THIS pass — what separates a declared duplicate from an author's row. */
  const declaredFolds = new Set<string>();

  for (const column of sinkColumns) {
    const fold = nocaseFold(column.name);
    // Two DECLARED sink columns can fold together — `columns` has no uniqueness
    // refine, so a declared list really can carry `id` and `ID` — and emitting
    // both would author the collision the store refuses. FIRST DECLARED WINS,
    // which is deterministic for a given dataset but is still arbitrary between
    // two columns whose `type`/`nullable` disagree; the loser is reported rather
    // than dropped, because the real defect is the declared list.
    if (claimed.has(fold)) {
      if (declaredFolds.has(fold)) duplicateDeclared.push(column.name);
      else alreadyMapped.push(column.name);
      continue;
    }
    declaredFolds.add(fold);
    const resolved = resolveSourceColumn({ source: column.name, onError: 'fail' }, index);
    if (resolved.kind === 'bound') {
      claimed.add(fold);
      rows.push({ source: resolved.key, sink: column.name, type: column.type, onError: 'fail' });
    } else if (resolved.kind === 'ambiguous') {
      ambiguous.push(column.name);
    } else {
      // `missing`. The `'null'` resolution cannot arise: it is reachable only
      // through `onError: 'null'`, and the probe above always passes `'fail'`.
      unmatched.push(column.name);
    }
  }

  return { rows, ambiguous, unmatched, alreadyMapped, duplicateDeclared };
}

export interface SinkCoverage {
  /**
   * Declared sink columns no row writes — §13's *unmapped* state. The whole
   * column, not its name: a `nullable: false` column nothing writes is a copy
   * that cannot succeed, and the caller must be able to say so apart from a
   * column deliberately left alone.
   */
  readonly notWritten: readonly DatasetColumn[];
  /**
   * Rows naming a sink column the dataset does not declare. This is the state
   * the ADDITIVE rule creates: auto-map against one sink dataset, re-bind to
   * another, and the earlier rows stay — naming columns the bound sink no
   * longer declares, with nothing on screen to say so.
   */
  readonly undeclared: readonly string[];
  /**
   * Pairs of rows whose `sink` names differ only by ASCII case, so both write the
   * SAME store column.
   *
   * This is the hazard auto-map's own fold-dedupe cannot reach, because the
   * author can type it directly. `refineMapping` dedupes sinks by EXACT string
   * and so accepts `id` beside `ID`; the store then refuses the pair
   * (`resolveSinkColumns` — "each sink column may be written by one mapping
   * row") at DISPATCH, on a version that is already immutable. Naming it here is
   * the only place an author can still act on it.
   *
   * An EXACT duplicate is deliberately NOT reported: `refineMapping` refuses that
   * one on Apply, in better words, and two advisories for one fault is noise.
   */
  readonly duplicateWrites: readonly { readonly first: string; readonly second: string }[];
}

/**
 * Which declared sink columns the mapping covers, and which rows point nowhere.
 *
 * Takes only `sink`, so both a committed mapping entry and a projected draft row
 * satisfy it — and so that an `expression`-only row counts as claiming its
 * column, which it does: it produces the value without reading a source.
 *
 * Advisory, per the module docblock: a declared list can be stale, so an
 * `undeclared` row may still run against a store that has the column.
 */
export function checkSinkCoverage(
  mapping: readonly { readonly sink: string }[],
  sinkColumns: readonly DatasetColumn[],
): SinkCoverage {
  const declared = new Set(sinkColumns.map((c) => nocaseFold(c.name)));
  /** The first row to write each fold, so a collision can name BOTH spellings. */
  const writtenBy = new Map<string, string>();
  const undeclared: string[] = [];
  const duplicateWrites: { first: string; second: string }[] = [];

  for (const entry of mapping) {
    const fold = nocaseFold(entry.sink);
    if (!declared.has(fold)) {
      undeclared.push(entry.sink);
      continue;
    }
    const first = writtenBy.get(fold);
    if (first === undefined) writtenBy.set(fold, entry.sink);
    else if (first !== entry.sink) duplicateWrites.push({ first, second: entry.sink });
  }

  return {
    notWritten: sinkColumns.filter((c) => !writtenBy.has(nocaseFold(c.name))),
    undeclared,
    duplicateWrites,
  };
}
