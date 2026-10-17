import { describe, expect, it } from 'vitest';
import { focusVisible } from './focusVisible';

describe('focusVisible', () => {
  it('answers false where the engine cannot parse the selector', () => {
    const el = document.createElement('button');
    Object.defineProperty(el, 'matches', {
      value: () => {
        throw new SyntaxError("':focus-visible' is not a valid selector");
      },
    });
    expect(focusVisible(el)).toBe(false);
  });

  it('answers what the selector matches', () => {
    const el = document.createElement('button');
    Object.defineProperty(el, 'matches', { value: (s: string) => s === ':focus-visible' });
    expect(focusVisible(el)).toBe(true);
  });
});
