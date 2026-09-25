import { describe, expect, it } from 'vitest';
import type { ConnectionPublic, Dataset } from '@autonomy-studio/shared';
import {
  addableKeys,
  coerceOverride,
  connectionOverrideResource,
  datasetOverrideResource,
  overrideNote,
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
  it('offers only declared keys the kind has and allows, minus ones already set', () => {
    const r = connectionOverrideResource(fsConnection(['maxBytes', 'roots', 'nope']));
    expect(addableKeys(r, {})).toEqual(expect.arrayContaining(['maxBytes']));
    expect(addableKeys(r, {})).not.toContain('nope');
    expect(addableKeys(r, { maxBytes: 5 })).not.toContain('maxBytes');
  });

  it('never offers a non-overridable key, even when the allowlist names it', () => {
    const r = datasetOverrideResource(dataset('table', { table: 't' }, ['table', 'schema']));
    expect(addableKeys(r, {})).toEqual([]);
    // …and says the KIND has none, not that the allowlist is empty.
    expect(overrideNote(r, {})).toMatch(/has no settings a node can override/);
  });

  it('tells an empty allowlist apart from a kind with nothing overridable', () => {
    const r = connectionOverrideResource(fsConnection([]));
    expect(overrideNote(r, {})).toMatch(/Files declares no overridable settings/);
    const some = connectionOverrideResource(fsConnection(['maxBytes']));
    expect(overrideNote(some, {})).toBeNull();
    // Every usable key already set: nothing to add, and nothing to explain.
    expect(overrideNote(some, { maxBytes: 5 })).toBeNull();
    const junk = connectionOverrideResource(fsConnection(['nope']));
    expect(overrideNote(junk, {})).toMatch(/name no setting/);
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
    expect(addableKeys(r, {})).toEqual(['parameters']);
    const field = r.fields.find((f) => f.name === 'parameters');
    expect(coerceOverride(field, '{"a":1}')).toEqual({ a: 1 });
  });

  it('flags each refusal dispatch would make, in the gate’s words', () => {
    const r = connectionOverrideResource(fsConnection(['maxBytes']));
    expect(overrideRowProblem(r, 'maxBytes', 5)).toBeNull();
    expect(overrideRowProblem(r, 'maxBytes', '${params.n}')).toBeNull();
    expect(overrideRowProblem(r, 'maxBytes', '4x')).toMatch(/number/);
    expect(overrideRowProblem(r, 'maxEntries', 5)).toMatch(/does not declare/);
    expect(overrideRowProblem(r, 'roots', ['/x'])).toMatch(/can never be overridden/);
    expect(overrideRowProblem(r, 'maxBytes', { $secret: 'k' })).toMatch(/secret/);
    const t = datasetOverrideResource(dataset('table', { table: 't' }, ['table']));
    expect(overrideRowProblem(t, 'table', 'x')).toMatch(/can never be overridden/);
    const u = connectionOverrideResource(fsConnection(['ghost']));
    expect(overrideRowProblem(u, 'ghost', 'x')).toMatch(/has no `ghost` setting, so a run ignores/);
    const d = datasetOverrideResource(dataset('delimited', { path: 'a' }, ['ghost']));
    expect(overrideRowProblem(d, 'ghost', 'x')).toMatch(
      /has no `ghost` setting, so a run will refuse/,
    );
  });

  it('flags an empty text override, which replaces the setting rather than unsetting it', () => {
    const r = datasetOverrideResource(dataset('delimited', { path: 'in.csv' }, ['path']));
    expect(overrideRowProblem(r, 'path', '')).toMatch(/empty/);
    expect(overrideRowProblem(r, 'path', 'other.csv')).toBeNull();
  });
});
