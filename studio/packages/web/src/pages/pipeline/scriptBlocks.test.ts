import { describe, expect, it } from 'vitest';
import {
  addBlockParam,
  blockParamDirection,
  blockParamNames,
  blockParamValue,
  importBlockParams,
  readBlockParams,
  removeBlockParam,
  renameBlockParam,
  setBlockParamDirection,
  setBlockParamValue,
  unboundBlockNames,
  writeBlockParams,
  type ScriptBlockParams,
} from './scriptBlocks';

const json = (v: unknown) => JSON.stringify(v, null, 2);
const none: ScriptBlockParams = { parameters: {}, directions: {} };

describe('#1600 C10c — a Script block’s parameters, read from and written to its JSON cells', () => {
  it('reads both cells, and an empty cell is none', () => {
    expect(
      readBlockParams({ type: 'query', sql: 'x', parameters: '', parameterDirections: '' }),
    ).toEqual(none);
    expect(readBlockParams({ type: 'query', sql: 'x' })).toEqual(none);
    expect(
      readBlockParams({
        parameters: json({ a: '1', b: '${x}' }),
        parameterDirections: json({ b: 'inOut', total: 'out' }),
      }),
    ).toEqual({ parameters: { a: '1', b: '${x}' }, directions: { b: 'inOut', total: 'out' } });
  });

  it('refuses a cell it cannot show as rows, so the block keeps its JSON cells', () => {
    expect(readBlockParams({ parameters: '{"a": ' })).toBeNull();
    expect(readBlockParams({ parameters: '[1]' })).toBeNull();
    expect(readBlockParams({ parameters: json({ a: 1 }) })).toBeNull();
    expect(readBlockParams({ parameterDirections: json({ a: 'output' }) })).toBeNull();
    expect(readBlockParams({ parameterDirections: 'null' })).toBeNull();
  });

  it('writes back in the form’s own JSON text, and none as a blank cell so the key is omitted', () => {
    const row = { type: 'nonQuery', sql: 'CALL p(:a, :t)' };
    const written = writeBlockParams(row, {
      parameters: { a: '1' },
      directions: { t: 'out' },
    });
    expect(written).toEqual({
      ...row,
      parameters: json({ a: '1' }),
      parameterDirections: json({ t: 'out' }),
    });
    expect(writeBlockParams(written, none)).toEqual({
      ...row,
      parameters: '',
      parameterDirections: '',
    });
  });

  it('lists the parameters, then a name with only a direction', () => {
    expect(
      blockParamNames({ parameters: { a: '', b: '' }, directions: { total: 'out', b: 'inOut' } }),
    ).toEqual(['a', 'b', 'total']);
  });

  it('renames a name in both records, in place', () => {
    const p = { parameters: { a: '1', b: '2' }, directions: { b: 'inOut' as const } };
    const next = renameBlockParam(p, 'b', 'c');
    expect(next).toEqual({ parameters: { a: '1', c: '2' }, directions: { c: 'inOut' } });
    expect(Object.keys(next.parameters)).toEqual(['a', 'c']);
  });

  it('keeps __proto__ as a name, never as the prototype', () => {
    const next = setBlockParamValue(addBlockParam(none, '__proto__'), '__proto__', 'v');
    expect(Object.prototype.hasOwnProperty.call(next.parameters, '__proto__')).toBe(true);
    expect(blockParamNames(next)).toEqual(['__proto__']);
    const dir = setBlockParamDirection(next, '__proto__', 'out');
    expect(Object.prototype.hasOwnProperty.call(dir.directions, '__proto__')).toBe(true);
  });

  it('sets a value for a name that had only a direction, keeping its direction', () => {
    const p = { parameters: {}, directions: { total: 'inOut' as const } };
    expect(setBlockParamValue(p, 'total', '0')).toEqual({
      parameters: { total: '0' },
      directions: { total: 'inOut' },
    });
  });

  it('In clears a direction, Out keeps a stored value (losslessly), and a stored In is untouched', () => {
    const p = { parameters: { a: '' }, directions: { a: 'out' as const, b: 'in' as const } };
    expect(setBlockParamDirection(p, 'a', 'in')).toEqual({
      parameters: { a: '' },
      directions: { b: 'in' },
    });
    expect(setBlockParamDirection(p, 'a', 'inOut').parameters).toEqual({ a: '' });
    expect(setBlockParamDirection(p, 'a', 'inOut').directions).toEqual({ a: 'inOut', b: 'in' });
  });

  it('removes a name from both records', () => {
    const p = { parameters: { a: '1', b: '2' }, directions: { a: 'inOut' as const } };
    expect(removeBlockParam(p, 'a')).toEqual({ parameters: { b: '2' }, directions: {} });
  });

  it('counts a name with only a direction as bound, and imports the rest as blank values', () => {
    const p = { parameters: { a: '1' }, directions: { total: 'out' as const } };
    const unbound = unboundBlockNames(p, ['a', 'total', 'x', 'y']);
    expect(unbound).toEqual(['x', 'y']);
    expect(importBlockParams(p, unbound)).toEqual({
      parameters: { a: '1', x: '', y: '' },
      directions: { total: 'out' },
    });
  });

  it('reads a value and a direction as own keys, so __proto__ never reads the prototype', () => {
    const p = { parameters: { __proto__: 'x' }, directions: {} } as unknown as ScriptBlockParams;
    const own = readBlockParams({ parameters: '{"__proto__": "x"}' })!;
    expect(blockParamDirection(own, '__proto__')).toBe('in');
    expect(
      blockParamValue(
        readBlockParams({ parameterDirections: '{"__proto__": "out"}' })!,
        '__proto__',
      ),
    ).toBeUndefined();
    expect(blockParamValue(p, 'missing')).toBeUndefined();
  });

  it('keeps a name with no value as an explicit In, so its row does not vanish', () => {
    const p = { parameters: {}, directions: { total: 'out' as const } };
    const next = setBlockParamDirection(p, 'total', 'in');
    expect(next.directions).toEqual({ total: 'in' });
    expect(blockParamNames(next)).toEqual(['total']);
  });

  it('round-trips what it writes, and reads a blank-looking cell as none', () => {
    const p = { parameters: { a: '1', '10': '${x}' }, directions: { t: 'inOut' as const } };
    expect(readBlockParams(writeBlockParams({ type: 'query', sql: 's' }, p))).toEqual(p);
    expect(readBlockParams({ parameters: '  \n ', parameterDirections: ' ' })).toEqual(none);
  });
});
