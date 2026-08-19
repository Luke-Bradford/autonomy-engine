import { describe, expect, it } from 'vitest';
import { DatasetKindSchema } from '../schemas/dataset.js';
import {
  DATASET_CONFIG_SCHEMAS,
  DATASET_KINDS,
  IMPLEMENTED_DATASET_KINDS,
  datasetConfigSchema,
  datasetKindIsImplemented,
  isSqlIdentifier,
  queryDatasetConfigSchema,
  tableDatasetConfigSchema,
  unimplementedDatasetConfigSchema,
} from './dataset-config.js';

describe('dataset config catalog', () => {
  it('covers every kind, and nothing that is not a kind', () => {
    // The `Record<DatasetKind, …>` type makes a MISSING kind a compile error;
    // this catches the other direction (a stale key left behind when a kind is
    // renamed or removed), exactly as the connection-config catalog does.
    expect(Object.keys(DATASET_CONFIG_SCHEMAS).sort()).toEqual(
      [...DatasetKindSchema.options].sort(),
    );
    expect(DATASET_KINDS).toEqual(DatasetKindSchema.options);
  });

  it('is total over the kind enum', () => {
    for (const kind of DATASET_KINDS) expect(datasetConfigSchema(kind)).toBeDefined();
  });

  it('names the kinds a reader exists for as a POSITIVE fact', () => {
    // Not inferred from "the schema is permissive": a future kind whose real
    // schema happened to be permissive would then become silently readable.
    expect([...IMPLEMENTED_DATASET_KINDS].sort()).toEqual(['query', 'table']);
    expect(datasetKindIsImplemented('table')).toBe(true);
    expect(datasetKindIsImplemented('delimited')).toBe(false);
    expect(datasetKindIsImplemented('excel')).toBe(false);
  });

  it('keeps an unimplemented kind’s config INTACT rather than stripping it', () => {
    // M2 already ships `delimited`/`excel` in the address vocabulary, so a
    // config authored today must survive a parse unchanged. A bare
    // `z.object({})` would silently return `{}` and wipe it.
    const authored = { path: '/data/in.csv', delimiter: ';', header: true };
    expect(unimplementedDatasetConfigSchema.parse(authored)).toEqual(authored);
    expect(datasetConfigSchema('delimited').parse(authored)).toEqual(authored);
  });
});

describe('SQL identifiers are refused, not accommodated', () => {
  it('accepts a bare identifier', () => {
    for (const ok of ['users', '_private', 'Table1', 'a$b']) expect(isSqlIdentifier(ok)).toBe(true);
  });

  it('refuses anything that would need quoting to be legal', () => {
    for (const bad of ['1users', 'my table', 'users;--', 'a"b', 'users)', '', 'sch.tbl']) {
      expect(isSqlIdentifier(bad)).toBe(false);
    }
  });

  it('refuses an injection-shaped table name at the schema boundary', () => {
    expect(tableDatasetConfigSchema.safeParse({ table: 'users' }).success).toBe(true);
    expect(tableDatasetConfigSchema.safeParse({ schema: 'main', table: 'users' }).success).toBe(
      true,
    );
    const attack = tableDatasetConfigSchema.safeParse({ table: 'users; drop table users' });
    expect(attack.success).toBe(false);
    expect(tableDatasetConfigSchema.safeParse({ schema: 'a b', table: 'users' }).success).toBe(
      false,
    );
  });

  it('requires a table', () => {
    expect(tableDatasetConfigSchema.safeParse({ schema: 'main' }).success).toBe(false);
  });
});

describe('query dataset config', () => {
  it('requires a non-empty statement', () => {
    expect(queryDatasetConfigSchema.safeParse({ sql: '' }).success).toBe(false);
    expect(queryDatasetConfigSchema.safeParse({ sql: 'select 1' }).success).toBe(true);
  });

  it('accepts only the value types the driver can bind', () => {
    const ok = queryDatasetConfigSchema.safeParse({
      sql: 'select * from t where a = :a and b = :b and c = :c',
      parameters: { a: 'x', b: 1, c: null },
    });
    expect(ok.success).toBe(true);
    // Measured on better-sqlite3@12.11.1: binding a boolean throws
    // "SQLite3 can only bind numbers, strings, bigints, buffers, and null".
    // Refusing it here turns a mid-scan throw into a config refusal.
    expect(
      queryDatasetConfigSchema.safeParse({ sql: 'select 1', parameters: { a: true } }).success,
    ).toBe(false);
    expect(
      queryDatasetConfigSchema.safeParse({ sql: 'select 1', parameters: { a: { nested: 1 } } })
        .success,
    ).toBe(false);
  });
});
