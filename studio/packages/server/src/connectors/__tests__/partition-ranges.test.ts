import { describe, expect, it } from 'vitest';
import { dynamicRanges, rangePredicate } from '../partition-ranges.js';

/** #1600 OR41 C6f-3 — Dynamic range's stride: every value lands in exactly one range. */
describe('dynamicRanges', () => {
  const owner = (ranges: ReturnType<typeof dynamicRanges>, v: bigint | null) =>
    ranges.filter((r) =>
      v === null
        ? r.nulls
        : (r.from === null || v >= r.from) && (r.to === null || v < r.to),
    ).length;

  it("splits ADF's documented example into its four ranges", () => {
    // ADF: lower 1, upper 80, parallelCopies 4 => [1,20], [21,40], [41,60], [61,80].
    expect(dynamicRanges(1n, 80n, 4)).toEqual([
      { from: null, to: 21n, nulls: true },
      { from: 21n, to: 41n, nulls: false },
      { from: 41n, to: 61n, nulls: false },
      { from: 61n, to: null, nulls: false },
    ]);
  });

  it('is a stride, not a filter: values outside the bounds and NULL still land once', () => {
    const ranges = dynamicRanges(10n, 19n, 3);
    for (const v of [null, -5n, 9n, 10n, 13n, 16n, 19n, 20n, 10_000n]) {
      expect(owner(ranges, v)).toBe(1);
    }
  });

  it('caps the ranges at the values in the span, and reads whole at a degree of 1', () => {
    expect(dynamicRanges(5n, 6n, 8)).toHaveLength(2);
    expect(dynamicRanges(5n, 5n, 8)).toEqual([{ from: null, to: null, nulls: true }]);
    expect(dynamicRanges(1n, 100n, 1)).toEqual([{ from: null, to: null, nulls: true }]);
  });

  it('reads whole when the bounds cross, as an authored lower bound above the maximum makes them', () => {
    expect(dynamicRanges(50n, 10n, 4)).toEqual([{ from: null, to: null, nulls: true }]);
  });

  it('works past the 2^53 a number can hold', () => {
    const lo = 9_007_199_254_740_993n;
    const ranges = dynamicRanges(lo, lo + 99n, 2);
    expect(ranges[1]?.from).toBe(lo + 50n);
  });
});

describe('rangePredicate', () => {
  it('binds every bound as a bigint parameter and keeps NULLs in the first range', () => {
    const [first, middle, last] = dynamicRanges(1n, 30n, 3);
    expect(rangePredicate('"id"', first!)).toEqual({
      sql: '("id" < $1::bigint OR "id" IS NULL)',
      values: ['11'],
    });
    expect(rangePredicate('"id"', middle!)).toEqual({
      sql: '"id" >= $1::bigint AND "id" < $2::bigint',
      values: ['11', '21'],
    });
    expect(rangePredicate('"id"', last!)).toEqual({ sql: '"id" >= $1::bigint', values: ['21'] });
  });

  it('has no predicate for a whole read', () => {
    expect(rangePredicate('"id"', { from: null, to: null, nulls: true })).toBeNull();
  });
});
