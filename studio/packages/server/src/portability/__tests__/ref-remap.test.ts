import { describe, expect, it, vi } from 'vitest';
import { mapLiteralRef } from '../ref-remap.js';

describe('mapLiteralRef (#1106)', () => {
  const map = new Map([
    ['db_1', 'res_1'],
    ['$${x}', 'res_escaped'],
  ]);

  it('maps a literal ref, without consulting onUnmapped', () => {
    const onUnmapped = vi.fn(() => 'fallback');
    expect(mapLiteralRef('db_1', map, onUnmapped)).toBe('res_1');
    expect(onUnmapped).not.toHaveBeenCalled();
  });

  it('hands an unmapped literal to onUnmapped, and returns what it returns', () => {
    const onUnmapped = vi.fn(() => 'fallback');
    expect(mapLiteralRef('db_gone', map, onUnmapped)).toBe('fallback');
    expect(onUnmapped).toHaveBeenCalledOnce();
  });

  it('lets onUnmapped refuse by throwing', () => {
    expect(() =>
      mapLiteralRef('db_gone', map, () => {
        throw new Error('dangling');
      }),
    ).toThrow('dangling');
  });

  // A `${}` ref routes on run values, so it is portable as-is. The map is not
  // consulted even when it happens to hold the same text.
  it.each([
    ['whole', '${params.target}'],
    ['interpolated', 'conn-${params.env}'],
    // An unterminated `${` classifies as interpolated, so it passes through too.
    ['unterminated', 'conn-${params.env'],
  ])('passes a %s dynamic ref through verbatim', (_label, ref) => {
    const onUnmapped = vi.fn(() => 'fallback');
    expect(mapLiteralRef(ref, new Map([[ref, 'res_wrong']]), onUnmapped)).toBe(ref);
    expect(onUnmapped).not.toHaveBeenCalled();
  });

  it('treats a `$$`-escaped ref as a LITERAL, so it is looked up', () => {
    expect(mapLiteralRef('$${x}', map, () => 'fallback')).toBe('res_escaped');
  });
});
