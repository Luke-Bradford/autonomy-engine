import { describe, expect, it } from 'vitest';
import type { ConnectionPublic, Dataset } from '@autonomy-studio/shared';
import {
  coerceOverride,
  connectionOverrideResource,
  datasetOverrideResource,
  declaredOverrideKeys,
  overrideNote,
  overrideRowKeys,
  overrideRowProblem,
} from './paramOverrides';

const fsConnection = (parameters: string[]): ConnectionPublic =>
  ({
    id: 'c1',
    ownerId: 'o',
    name: 'Files',
    kind: 'fs',
    config: { roots: ['/data'], maxBytes: 1000 },
    parameters,
  }) as unknown as ConnectionPublic;

const dataset = (kind: string, config: Record<string, unknown>, parameters: string[]): Dataset =>
  ({
    id: 'd1',
    ownerId: 'o',
    name: 'Rows',
    connectionId: 'c1',
    kind,
    config,
    columns: [],
    parameters,
  }) as unknown as Dataset;

describe('paramOverrides (#1304)', () => {
  it('lists only declared keys the kind has and allows, in the owner’s order', () => {
    const r = connectionOverrideResource(fsConnection(['nope', 'maxBytes', 'roots']));
    expect(declaredOverrideKeys(r)).toEqual(['maxBytes']);
  });

  it('never lists a non-overridable key, even when the allowlist names it', () => {
    const r = datasetOverrideResource(dataset('table', { table: 't' }, ['table', 'schema']));
    expect(declaredOverrideKeys(r)).toEqual([]);
  });

  it('#1694 — rows: every declared key, set or not, then each stray stored key', () => {
    const r = connectionOverrideResource(fsConnection(['maxBytes']));
    expect(overrideRowKeys(r, {})).toEqual(['maxBytes']);
    expect(overrideRowKeys(r, { maxBytes: 5 })).toEqual(['maxBytes']);
    // A key the resource does not declare is still a row, so it can be seen and removed.
    expect(overrideRowKeys(r, { roots: ['/x'], maxBytes: 5 })).toEqual(['maxBytes', 'roots']);
    // No resource to read: the stored keys alone.
    expect(overrideRowKeys(null, { a: 1 })).toEqual(['a']);
    expect(overrideRowKeys(null, {})).toEqual([]);
  });

  it('#1694 — notes only a declaration that has no effect', () => {
    // Nothing declared: no table, no note.
    expect(overrideNote(connectionOverrideResource(fsConnection([])))).toBeNull();
    expect(overrideNote(datasetOverrideResource(dataset('table', { table: 't' }, [])))).toBeNull();
    // Declared, but nothing a node may override on the kind: the declaration is dead.
    expect(
      overrideNote(datasetOverrideResource(dataset('table', { table: 't' }, ['table']))),
    ).toMatch(/name no setting/);
    expect(overrideNote(connectionOverrideResource(fsConnection(['maxBytes'])))).toBeNull();
    expect(overrideNote(connectionOverrideResource(fsConnection(['nope'])))).toMatch(
      /name no setting/,
    );
  });

  it('coerces a literal to the field type, and keeps a whole ${} verbatim', () => {
    const r = connectionOverrideResource(fsConnection(['maxBytes']));
    const maxBytes = r.fields.find((f) => f.name === 'maxBytes');
    expect(coerceOverride(maxBytes, '42')).toBe(42);
    expect(coerceOverride(maxBytes, ' ${params.n} ')).toBe('${params.n}');
    // Not yet a number: kept as typed, so the row can flag it and the draft survives.
    expect(coerceOverride(maxBytes, '4x')).toBe('4x');
    expect(coerceOverride(undefined, 'raw')).toBe('raw');
  });

  it('coerces a json-kind key (a query dataset’s bind parameters)', () => {
    const r = datasetOverrideResource(dataset('query', { sql: 'select 1' }, ['parameters']));
    expect(declaredOverrideKeys(r)).toEqual(['parameters']);
    const field = r.fields.find((f) => f.name === 'parameters');
    expect(coerceOverride(field, '{"a":1}')).toEqual({ a: 1 });
  });

  it('flags each refusal dispatch would make, in the gate’s words', () => {
    const r = connectionOverrideResource(fsConnection(['maxBytes']));
    expect(overrideRowProblem(r, 'maxBytes', 5)).toBeNull();
    expect(overrideRowProblem(r, 'maxBytes', '${params.n}')).toBeNull();
    // A SPLICE of two refs resolves to a string, so it is not a whole value (#1307 review).
    expect(overrideRowProblem(r, 'maxBytes', '${a}5${b}')).toMatch(/number/);
    expect(overrideRowProblem(r, 'maxBytes', '4x')).toMatch(/number/);
    expect(overrideRowProblem(r, 'maxEntries', 5)).toMatch(/does not declare/);
    expect(overrideRowProblem(r, 'roots', ['/x'])).toMatch(/can never be overridden/);
    expect(overrideRowProblem(r, 'maxBytes', { $secret: 'k' })).toMatch(/secret/);
    const t = datasetOverrideResource(dataset('table', { table: 't' }, ['table']));
    expect(overrideRowProblem(t, 'table', 'x')).toBe(
      '`table` can never be overridden on Database table datasets. Remove this override.',
    );
    const u = connectionOverrideResource(fsConnection(['ghost']));
    expect(overrideRowProblem(u, 'ghost', 'x')).toBe(
      'File system connections have no `ghost` setting, so a run will refuse it.',
    );
    const d = datasetOverrideResource(dataset('delimited', { path: 'a' }, ['ghost']));
    expect(overrideRowProblem(d, 'ghost', 'x')).toBe(
      'Delimited text (CSV) datasets have no `ghost` setting, so a run will refuse it.',
    );
  });

  it('flags an empty text override, which replaces the setting rather than unsetting it', () => {
    const r = datasetOverrideResource(dataset('delimited', { path: 'in.csv' }, ['path']));
    expect(overrideRowProblem(r, 'path', '')).toMatch(/empty/);
    expect(overrideRowProblem(r, 'path', 'other.csv')).toBeNull();
  });
});
