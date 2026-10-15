import { describe, expect, it } from 'vitest';
import {
  bindNameProblem,
  bindValueText,
  coerceBindValue,
  freshBindName,
  renameKey,
} from './inlineSource';

describe('inline source bind values (#1600 C1q-b)', () => {
  it('refuses a name that cannot be a key the statement binds', () => {
    expect(bindNameProblem('', [])).toMatch(/Name it/);
    expect(bindNameProblem(':wm', [])).toMatch(/leading :/);
    expect(bindNameProblem('a b', [])).toMatch(/no spaces/);
    expect(bindNameProblem('wm', ['wm'])).toMatch(/already bound/);
    expect(bindNameProblem('wm', ['n'])).toBeNull();
  });

  it('keeps a stored number a number while the text reads as one, and stores other text as typed', () => {
    expect(coerceBindValue(100, '150')).toBe(150);
    expect(coerceBindValue(100, '1.5e2')).toBe(150);
    expect(coerceBindValue(100, '')).toBe('');
    expect(coerceBindValue(100, '${params.wm}')).toBe('${params.wm}');
    expect(coerceBindValue('100', '150')).toBe('150');
    expect(coerceBindValue(null, '7')).toBe('7');
    expect(bindValueText(null)).toBe('');
    expect(bindValueText(7)).toBe('7');
    expect(bindValueText({ a: 1 })).toBe('');
  });

  it('renames in place, keeps every value, and defines __proto__ as an own key', () => {
    expect(Object.keys(renameKey({ a: 1, b: 2, c: 3 }, 'b', 'x'))).toEqual(['a', 'x', 'c']);
    const odd = renameKey({ p1: 'v' }, 'p1', '__proto__');
    expect(Object.keys(odd)).toEqual(['__proto__']);
    expect(Object.getOwnPropertyDescriptor(odd, '__proto__')?.value).toBe('v');
    expect(freshBindName(['p1', 'p3'])).toBe('p2');
  });
});
