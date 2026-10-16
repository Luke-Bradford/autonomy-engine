import { describe, expect, it } from 'vitest';
import {
  bindNameProblem,
  bindValueText,
  coerceBindValue,
  dynamicBindNames,
  freshBindName,
  previewBindValue,
  previewInline,
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

describe('inline source preview (#1600 C1q-c)', () => {
  const q = (parameters: Record<string, unknown>) => ({
    kind: 'query' as const,
    config: { sql: 'SELECT * FROM t WHERE a > :wm', parameters },
  });

  it('asks for a value only where the run would evaluate one', () => {
    expect(
      dynamicBindNames(
        q({ wm: '${nodes.l.output.rows[0].wm}', lit: 'plain', esc: '$${not}', n: 3, nil: null }),
      ),
    ).toEqual(['wm']);
  });

  it('binds a number as a number and anything else as typed', () => {
    expect(previewBindValue('5')).toBe(5);
    expect(previewBindValue('-2.5')).toBe(-2.5);
    expect(previewBindValue('007')).toBe('007');
    expect(previewBindValue('2026-10-01')).toBe('2026-10-01');
    expect(previewBindValue('')).toBe('');
    // Never a number JSON cannot carry (it would bind NULL), never a trimmed one.
    expect(previewBindValue('NaN')).toBe('NaN');
    expect(previewBindValue('Infinity')).toBe('Infinity');
    expect(previewBindValue(' 5')).toBe(' 5');
  });

  it('sends every value literal: the preview value for a ${}, the escape resolved for text', () => {
    expect(previewInline(q({ wm: '${x}', esc: 'a$${b}', n: 3 }), { wm: '42' })).toEqual(
      q({ wm: 42, esc: 'a${b}', n: 3 }),
    );
    // A dynamic value with nothing typed binds as empty text, never the expression.
    expect(previewInline(q({ wm: '${x}' }), {}).config['parameters']).toEqual({ wm: '' });
    const table = { kind: 'table' as const, config: { table: 't' } };
    expect(previewInline(table, {})).toBe(table);
  });
});
