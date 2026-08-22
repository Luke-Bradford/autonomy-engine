/**
 * #1224 — the bound a `lookup` applies to a row BEFORE it copies anything.
 *
 * `LOOKUP_BYTE_CAP` is measured on the row AS SERIALISED, which is the right
 * quantity (see the constant) but was measured at the wrong moment: `lookup.ts`
 * normalised the row and `JSON.stringify`d it, and only then compared. So the
 * cap bounded what was ADMITTED, never what was MATERIALISED — a single sqlite
 * `BLOB` or postgres `bytea` cell was base64'd (a ~1.33x copy) and serialised (a
 * second, larger copy) before the check that threw it away. Peak memory was
 * governed by the largest single ROW in the source, by an unbounded factor.
 *
 * WHY THIS IS A LOWER BOUND AND NOT AN ESTIMATE, which is the whole design. A
 * pre-screen that could ever exceed the true serialised size would truncate a
 * valid row — a silent, wrong answer, and strictly worse than the memory
 * problem it is here to fix. So every arm charges LESS than the serialisation
 * does, and the exact `Buffer.byteLength(JSON.stringify(row))` check in
 * `lookup.ts` is untouched and still governs ADMISSION. This only ever refuses
 * early, never admits early.
 *
 * WHY IT CHARGES ONLY TWO KINDS. #1224 is precise about reachability: the file
 * readers already bound an individual cell (`XLSX_MAX_CELL_CHARS`, and
 * `delimited`'s own bounds), so exactly two value kinds arrive with no ceiling —
 * a string and a byte array. Both report their size from a field, at no cost:
 *
 *  - `Uint8Array.byteLength` is a strict lower bound on its base64 rendering,
 *    which is `ceil(n / 3) * 4` — read WITHOUT calling `Buffer.from`, which is
 *    the copy this module exists to avoid.
 *  - a string's `.length` counts UTF-16 code units, and a UTF-8 encoding is
 *    never shorter: a BMP code point is 1 unit and 1-3 bytes, an astral one is 2
 *    units and 4 bytes. So `.length` is a lower bound on the UTF-8 length, and
 *    unlike `Buffer.byteLength` it is a field read rather than a scan — which
 *    matters, because scanning a 500 MB string is the cost being avoided.
 *
 * Everything else — numbers, booleans, nulls, dates, bigints, the punctuation,
 * and every NESTED key name — is charged NOTHING. (A top-level COLUMN name is
 * charged, because it is a string from the source like any other and is
 * serialised in full; see {@link estimateRowLowerBound}.) That is deliberate
 * slack, not an oversight: those kinds are individually small, and a row made only of them is
 * already bounded by the reader's own row. A ladder mirroring every arm of
 * `logSafe` would be a second spelling of it, and would silently become an
 * OVER-estimate the day the two drifted apart.
 *
 * Deliberately not reusing the two byte helpers that already exist:
 * `shared`'s `byteSizeOf` sizes VALUES and charges a `null` zero, which
 * `LOOKUP_BYTE_CAP`'s docblock already argues does not bound this; and
 * `utf8ByteLength` is not on `@autonomy-studio/shared`'s public surface (the
 * barrel says why) and would in any case scan the string this module refuses to
 * touch.
 */

/**
 * How deep a nested value may be before a walker stops rather than descending.
 *
 * `redact.ts`'s `MAX_REDACT_DEPTH` is the precedent and the number is the same,
 * but the ACTION at the ceiling differs by walker. `logSafe` REFUSES the value —
 * it is establishing that the row can be persisted at all, and substituting a
 * sentinel would answer that question by inventing the data. This module stops
 * counting and returns what it has, which stays a lower bound: an unwalked
 * subtree can only add bytes, never remove them, and a value deep enough to hit
 * the ceiling is one `logSafe` will refuse a moment later anyway.
 *
 * Lives here rather than in `lookup.ts` because both walkers need it and the
 * import may only run one way: `lookup.ts` imports this module, never the
 * reverse.
 */
export const MAX_VALUE_DEPTH = 100;

/**
 * Add `value`'s unbounded-kind bytes to `running`, abandoning the walk as soon
 * as the total passes `budget`.
 *
 * The short-circuit is what keeps the pre-screen from becoming its own O(n)
 * cost: a postgres `jsonb` document holding a million elements must not be
 * fully traversed to establish that its first few already exceed 1 MiB.
 */
function walk(value: unknown, budget: number, running: number, depth: number): number {
  if (running > budget) return running;
  if (typeof value === 'string') return running + value.length;
  // A Node `Buffer` IS a `Uint8Array`, so this arm covers what `better-sqlite3`
  // hands back for a BLOB as well as what `pg` hands back for a `bytea`.
  if (value instanceof Uint8Array) return running + value.byteLength;
  if (value === null || typeof value !== 'object') return running;
  if (depth >= MAX_VALUE_DEPTH) return running;
  if (Array.isArray(value)) {
    let total = running;
    for (const element of value) {
      total = walk(element, budget, total, depth + 1);
      if (total > budget) return total;
    }
    return total;
  }
  let total = running;
  // `Object.entries`, matching `logSafe`'s own rebuild: a class instance that
  // carries its data as own enumerable properties (a `pg` `PostgresInterval`,
  // say) is serialised from exactly these, so its strings are charged too.
  for (const [, nested] of Object.entries(value)) {
    total = walk(nested, budget, total, depth + 1);
    if (total > budget) return total;
  }
  return total;
}

/**
 * A lower bound on the UTF-8 size of `raw` once `logSafeRow` has normalised it
 * and `JSON.stringify` has serialised it, abandoned as soon as it passes
 * `budget`.
 *
 * `nullValue` is consulted for the same reason `logSafeRow` consults it and at
 * the same level — §6.4's sentinel is a fact about how a FILE spells NULL in a
 * FIELD, so it is matched against the column value and never against a string
 * nested inside a `jsonb` document. Skipping it here would not merely be
 * imprecise: a column matching the sentinel serialises as `null`, so charging
 * its full length would be an OVER-estimate, and an over-estimate is the one
 * error this module may not make.
 *
 * A key whose value is `undefined` contributes nothing, because `logSafeRow`
 * omits it entirely — key, value and its comma.
 */
export function estimateRowLowerBound(
  raw: Record<string, unknown>,
  nullValue: string | undefined,
  budget: number,
): number {
  let total = 0;
  for (const [column, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (nullValue !== undefined && value === nullValue) continue;
    // The key name is itself an unbounded string from the source, and it is
    // serialised in full. Charged by the same `.length` rule as any other.
    total += column.length;
    total = walk(value, budget, total, 0);
    if (total > budget) return total;
  }
  return total;
}
