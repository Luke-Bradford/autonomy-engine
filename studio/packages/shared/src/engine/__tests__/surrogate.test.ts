import { describe, expect, it } from 'vitest';
import { isHighSurrogate, surrogateSafeCut } from '../surrogate.js';

describe('surrogateSafeCut', () => {
  it('keeps `max` when the cut falls between whole characters', () => {
    expect(surrogateSafeCut('abcdef', 3)).toBe(3);
  });

  it('steps back one unit rather than keep a lone high surrogate', () => {
    // 'a' + U+1F600 (two UTF-16 units) + 'b': a cut at 2 would split the pair.
    const text = 'a\u{1F600}b';
    expect(isHighSurrogate(text.charCodeAt(1))).toBe(true);
    expect(surrogateSafeCut(text, 2)).toBe(1);
    expect(surrogateSafeCut(text, 3)).toBe(3);
  });
});
