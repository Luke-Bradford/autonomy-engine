/**
 * #1600 OR41 C6f-3 — Dynamic range's partitions, as ADF draws them: the span
 * from the lower to the upper bound is cut into `degree` equal ranges ("lower
 * bound 1, upper bound 80, parallel copy 4 … [1,20], [21,40], [41,60], [61,80]").
 *
 * The bounds set the STRIDE, never a filter (ADF: "to decide the partition
 * stride, not as data filter"). So the first range is open below and holds the
 * NULLs, and the last is open above: every row of the table lands in exactly
 * one range, and a bound authored inside the data loses nothing. BigInt
 * throughout, because a bigint column holds values a number cannot.
 */
export interface PartitionRange {
  /** Inclusive lower edge, or `null` for open below. */
  readonly from: bigint | null;
  /** Exclusive upper edge, or `null` for open above. */
  readonly to: bigint | null;
  /** Whether the range also holds the column's NULLs (the first one does). */
  readonly nulls: boolean;
}

const WHOLE: PartitionRange = { from: null, to: null, nulls: true };

/**
 * At most `degree` ranges, and no more than the span holds values, so none is
 * empty by construction. Crossed bounds (an authored lower bound above the
 * column's highest value) read whole: there is no stride to cut.
 */
export function dynamicRanges(
  lower: bigint,
  upper: bigint,
  degree: number,
): readonly PartitionRange[] {
  if (degree <= 1 || upper <= lower) return [WHOLE];
  const span = upper - lower + 1n;
  const n = BigInt(degree) < span ? BigInt(degree) : span;
  const cuts: bigint[] = [];
  for (let i = 1n; i < n; i += 1n) cuts.push(lower + (span * i) / n);
  return cuts
    .map((to, i): PartitionRange => ({ from: i === 0 ? null : cuts[i - 1]!, to, nulls: i === 0 }))
    .concat([{ from: cuts[cuts.length - 1]!, to: null, nulls: false }]);
}

/**
 * The WHERE a range reads, or `null` for a whole read. `column` is already a
 * quoted identifier. The edges are bound, never spelled into the SQL, and cast
 * to bigint so an edge past a smallint or integer column's range compares
 * rather than raising "out of range" for the column's own type.
 */
export function rangePredicate(
  column: string,
  range: PartitionRange,
): { readonly sql: string; readonly values: readonly string[] } | null {
  if (range.from === null && range.to === null) return null;
  if (range.from === null) {
    return { sql: `(${column} < $1::bigint OR ${column} IS NULL)`, values: [String(range.to)] };
  }
  if (range.to === null) return { sql: `${column} >= $1::bigint`, values: [String(range.from)] };
  return {
    sql: `${column} >= $1::bigint AND ${column} < $2::bigint`,
    values: [String(range.from), String(range.to)],
  };
}
