import { describe, expect, it } from 'vitest';
import {
  canonicalGridHidden,
  parseGridHidden,
  parseGridWidths,
  visibleGridColumns,
  withGridWidth,
  type GridColumnSpec,
} from './gridColumns';

type Id = 'a' | 'b' | 'c';
const SPEC: GridColumnSpec<Id> = {
  columns: ['a', 'b', 'c'],
  required: ['a'],
  defaultHidden: ['c'],
  widths: {
    a: { min: 50, default: 100 },
    b: { min: 40, default: 80 },
    c: { min: 40, default: 60 },
  },
  maxWidth: 300,
  step: 16,
};

describe('grid column rules (#1569 OR37)', () => {
  it('keeps a hidden set canonical: known, not required, once, in column order', () => {
    expect(canonicalGridHidden(SPEC, ['c', 'a', 'x', 'c', 'b', 7])).toEqual(['b', 'c']);
  });

  it('draws every column not hidden, and a pinned one whatever the choice', () => {
    expect(visibleGridColumns(SPEC, ['b', 'c'], () => false)).toEqual(['a']);
    expect(visibleGridColumns(SPEC, ['b', 'c'], (c) => c === 'c')).toEqual(['a', 'c']);
  });

  it('sets, clamps and forgets widths without touching the others', () => {
    const once = withGridWidth(SPEC, {}, 'b', 10);
    expect(once).toEqual({ b: 40 });
    expect(withGridWidth(SPEC, once, 'c', 999.6)).toEqual({ b: 40, c: 300 });
    expect(withGridWidth(SPEC, { b: 90, c: 70 }, 'b', null)).toEqual({ c: 70 });
    expect(withGridWidth(SPEC, { b: 90 }, 'b', Number.NaN)).toEqual({});
  });

  it('reads stored text fail-closed: garbage is absent, bad entries are dropped', () => {
    for (const raw of ['', 'b', '{"b":true}', 'null', '"b"']) {
      expect(parseGridHidden(SPEC, raw)).toBeUndefined();
    }
    expect(parseGridHidden(SPEC, '["b","a","zz"]')).toEqual(['b']);
    for (const raw of ['', '[]', '7', 'null']) {
      expect(parseGridWidths(SPEC, raw)).toBeUndefined();
    }
    expect(parseGridWidths(SPEC, '{"a":10,"b":"wide","zz":90,"c":120}')).toEqual({ a: 50, c: 120 });
  });
});
