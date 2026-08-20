import { describe, expect, it } from 'vitest';
import {
  checkSourceDrift,
  indexSourceColumns,
  nocaseFold,
  resolveSourceColumn,
} from './schema-drift.js';
import type { CopyPumpMappingEntry } from './pump.js';

const entry = (over: Partial<CopyPumpMappingEntry>): CopyPumpMappingEntry => ({
  sink: 'out',
  type: 'string',
  onError: 'fail',
  ...over,
});

describe('nocaseFold', () => {
  it('folds ASCII only, the way SQLite NOCASE does', () => {
    expect(nocaseFold('ID')).toBe('id');
    // KELVIN SIGN: `toLowerCase()` would fold it to 'k'; SQLite does not.
    expect(nocaseFold('K')).toBe('K');
  });
});

describe('resolveSourceColumn', () => {
  it('binds an exact match in preference to a case variant', () => {
    const index = indexSourceColumns(['Name', 'name']);
    expect(resolveSourceColumn(entry({ source: 'name' }), index)).toEqual({
      kind: 'bound',
      key: 'name',
    });
  });

  it('binds a lone case variant', () => {
    const index = indexSourceColumns(['Name']);
    expect(resolveSourceColumn(entry({ source: 'name' }), index)).toEqual({
      kind: 'bound',
      key: 'Name',
    });
  });

  it('refuses a name that matches two columns case-insensitively and neither exactly', () => {
    const index = indexSourceColumns(['Name', 'NAME']);
    expect(resolveSourceColumn(entry({ source: 'name' }), index)).toEqual({ kind: 'ambiguous' });
  });

  it('reports an absent column as missing', () => {
    expect(resolveSourceColumn(entry({ source: 'nope' }), indexSourceColumns(['a']))).toEqual({
      kind: 'missing',
    });
  });

  it("absorbs an absent column into a null when the entry opts out with onError:'null'", () => {
    const index = indexSourceColumns(['a']);
    expect(resolveSourceColumn(entry({ source: 'nope', onError: 'null' }), index)).toEqual({
      kind: 'null',
    });
  });
});

describe('checkSourceDrift', () => {
  it('names every missing column at once, rather than the first', () => {
    const drift = checkSourceDrift(
      [entry({ source: 'a' }), entry({ source: 'b', sink: 'o2' }), entry({ source: 'c', sink: 'o3' })],
      ['a'],
    );
    expect(drift.missing).toEqual(['b', 'c']);
    expect(drift.ambiguous).toEqual([]);
  });

  it('reports a source column the mapping does not mention (§7 row 4)', () => {
    const drift = checkSourceDrift([entry({ source: 'a' })], ['a', 'extra', 'another']);
    expect(drift.unmapped).toEqual(['extra', 'another']);
  });

  it('does not report a column the mapping mentions by a case variant as unmapped', () => {
    expect(checkSourceDrift([entry({ source: 'ID' })], ['id']).unmapped).toEqual([]);
  });

  it('reports nothing unmapped for an empty mapping, which the pump refuses on its own', () => {
    expect(checkSourceDrift([], ['a', 'b'])).toEqual({ missing: [], ambiguous: [], unmapped: [] });
  });

  it('ignores expression-only entries, which read no source column', () => {
    const drift = checkSourceDrift([entry({ expression: 'k' })], ['a']);
    expect(drift.missing).toEqual([]);
    expect(drift.unmapped).toEqual(['a']);
  });

  it('collapses a duplicated result column, mirroring the row-object key set the pump binds against', () => {
    // `SELECT i, i` reports `['i','i']` from `Statement.columns()` but yields a
    // row with ONE key. Left uncollapsed this reads as an ambiguity that the
    // pump never sees, and would refuse a copy that works.
    const drift = checkSourceDrift([entry({ source: 'I' })], ['i', 'i']);
    expect(drift.ambiguous).toEqual([]);
    expect(drift.missing).toEqual([]);
    expect(drift.unmapped).toEqual([]);
  });
});
