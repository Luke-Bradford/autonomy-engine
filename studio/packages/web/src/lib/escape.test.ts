import { describe, expect, it } from 'vitest';
import { isUnhandledEscape } from './escape';

const key = (k: string, defaultPrevented = false, isComposing = false) => ({
  key: k,
  defaultPrevented,
  nativeEvent: { isComposing },
});

describe('isUnhandledEscape', () => {
  it('is a plain Escape', () => {
    expect(isUnhandledEscape(key('Escape'))).toBe(true);
  });

  it('is not another key', () => {
    expect(isUnhandledEscape(key('Enter'))).toBe(false);
  });

  it('is not an Escape a control inside already handled', () => {
    expect(isUnhandledEscape(key('Escape', true))).toBe(false);
  });

  it('is not the Escape that ends an IME composition', () => {
    expect(isUnhandledEscape(key('Escape', false, true))).toBe(false);
  });
});
