import { describe, expect, it } from 'vitest';
import type { InlineDataset } from '@autonomy-studio/shared';
import {
  bindNameProblem,
  bindTypeOf,
  bindValueFor,
  bindValueText,
  dynamicBindNames,
  freshBindName,
  previewBindValue,
  previewInline,
  reconcileKeyOrder,
  renameKey,
  sqlDialectOf,
  statementBindNames,
  withImportedBindNames,
} from './inlineSource';

describe('inline source bind values (#1600 C1q-b)', () => {
  it('refuses a name that cannot be a key the statement binds', () => {
    expect(bindNameProblem('', [])).toMatch(/Name it/);
    expect(bindNameProblem(':wm', [])).toMatch(/leading :/);
    expect(bindNameProblem('a b', [])).toMatch(/no spaces/);
    expect(bindNameProblem('wm', ['wm'])).toMatch(/already bound/);
    // #1600 C10c — a name is literal: a `${` in it can never be a :name.
    expect(bindNameProblem('${x}', [])).toMatch(/literal/);
    expect(bindNameProblem('wm', ['n'])).toBeNull();
  });

  it("stores what the row's type says, and holds a Number that is not one yet", () => {
    expect(bindValueFor('text', '150')).toEqual({ value: '150' });
    expect(bindValueFor('number', '150')).toEqual({ value: 150 });
    expect(bindValueFor('number', ' -1.5 ')).toEqual({ value: -1.5 });
    for (const t of ['', '150.', '0x10', '1e3', 'abc', 'Infinity', '1e999']) {
      expect(bindValueFor('number', t)).toEqual({
        problem: 'Not saved: enter a number, or a ${} value.',
      });
    }
    // A stored number's own text reads back as itself, so it loads without a problem.
    expect(bindValueFor('number', bindValueText(1e-7))).toEqual({ value: 1e-7 });
    expect(bindValueFor('number', bindValueText(1e21))).toEqual({ value: 1e21 });
    // Stored rounded, it would be a different value than the one typed.
    expect(bindValueFor('number', '12345678901234567890')).toEqual({
      problem: 'Not saved: too large to store exactly. Choose Text to keep every digit.',
    });
    expect(bindValueFor('number', '9007199254740991')).toEqual({ value: 9007199254740991 });
    // A `${}` is stored as typed whatever the type: the run keeps what it resolves to.
    expect(bindValueFor('number', '${params.wm}')).toEqual({ value: '${params.wm}' });
    expect(bindValueFor('number', '$${literal}')).toEqual({
      problem: 'Not saved: enter a number, or a ${} value.',
    });
    expect(bindValueFor('null', 'anything')).toEqual({ value: null });
    expect(bindTypeOf(7)).toBe('number');
    expect(bindTypeOf(null)).toBe('null');
    expect(bindTypeOf('7')).toBe('text');
    expect(bindTypeOf(undefined)).toBe('text');
    expect(bindValueText(null)).toBe('');
    expect(bindValueText(7)).toBe('7');
    expect(bindValueText({ a: 1 })).toBe('');
  });

  it('imports a blank text row for each statement name not yet stored, after the stored rows', () => {
    const inline: InlineDataset = {
      kind: 'query',
      config: { sql: 'select * from t where a = :b and c = @a and d = :__proto__', parameters: {} },
    };
    const names = statementBindNames(inline, 'sqlite');
    expect(names).toEqual(['b', 'a', '__proto__']);
    // `@a` is a sqlite spelling only: on postgres `@` is an operator.
    expect(statementBindNames(inline, 'postgres')).toEqual(['b', '__proto__']);
    const next = withImportedBindNames({ z: 1, a: 2 }, names);
    expect(Object.entries(next)).toEqual([
      ['z', 1],
      ['a', 2],
      ['b', ''],
      ['__proto__', ''],
    ]);
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
    expect(sqlDialectOf('sqlite')).toBe('sqlite');
    expect(sqlDialectOf('postgres')).toBe('postgres');
    expect(sqlDialectOf('fs')).toBeUndefined();
    expect(sqlDialectOf(undefined)).toBeUndefined();
  });

  it('renames in place, keeps every value, and defines __proto__ as an own key', () => {
    expect(Object.keys(renameKey({ a: 1, b: 2, c: 3 }, 'b', 'x'))).toEqual(['a', 'x', 'c']);
    const odd = renameKey({ p1: 'v' }, 'p1', '__proto__');
    expect(Object.keys(odd)).toEqual(['__proto__']);
    expect(Object.getOwnPropertyDescriptor(odd, '__proto__')?.value).toBe('v');
    expect(freshBindName(['p1', 'p3'])).toBe('p2');
  });

  // #1725: a record lists integer-like keys first, so the rows hold their own order.
  it('keeps the rows in their own order when a name becomes integer-like, and undoes in place', () => {
    expect(Object.keys(renameKey({ p2: 1, a: 2 }, 'a', '1'))).toEqual(['1', 'p2']);
    expect(reconcileKeyOrder(['p2', 'a'], ['1', 'p2'])).toEqual(['p2', '1']);
    expect(reconcileKeyOrder(['p2', '1'], ['10', 'p2'])).toEqual(['p2', '10']);
    expect(reconcileKeyOrder(['a', 'b', 'c'], ['1', 'a', 'c'])).toEqual(['a', '1', 'c']);
    expect(reconcileKeyOrder(['a', '1', 'c'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('drops a removed name, puts new ones where the record lists them, and keeps the array when nothing moved', () => {
    expect(reconcileKeyOrder(['b', 'a', 'c'], ['b', 'c'])).toEqual(['b', 'c']);
    // An undone Remove returns to its slot, the first row's included.
    expect(reconcileKeyOrder(['a', 'c'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(reconcileKeyOrder(['b', 'c'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    // Add and Import append to the record, so their rows go last.
    expect(reconcileKeyOrder(['z', 'a'], ['a', 'z', 'x', 'y'])).toEqual(['z', 'a', 'x', 'y']);
    expect(reconcileKeyOrder(['p2', '10'], ['10', 'p2', 'p1'])).toEqual(['p2', '10', 'p1']);
    expect(reconcileKeyOrder([], ['x', 'y'])).toEqual(['x', 'y']);
    // Two gone and two new is not one rename.
    expect(reconcileKeyOrder(['a', 'b', 'c'], ['c', 'x', 'y'])).toEqual(['c', 'x', 'y']);
    const same = ['z', '1'];
    expect(reconcileKeyOrder(same, ['1', 'z'])).toBe(same);
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

  it('with the dialect known, asks only for the names the statement uses', () => {
    const both = q({ wm: '${params.a}', gone: '${params.b}' });
    expect(dynamicBindNames(both)).toEqual(['wm', 'gone']);
    expect(dynamicBindNames(both, 'sqlite')).toEqual(['wm']);
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
