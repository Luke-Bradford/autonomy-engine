import { describe, expect, it } from 'vitest';
import {
  DatasetColumnSchema,
  DatasetKindSchema,
  DatasetSchema,
  NewDatasetSchema,
} from './dataset.js';

const validDataset = {
  id: 'ds_1',
  resourceId: 'res_ds1',
  ownerId: null,
  name: 'Customers CSV',
  connectionId: 'conn_1',
  kind: 'delimited',
  config: { path: 'customers.csv', header: true },
  columns: [{ name: 'id', type: 'integer', nullable: false }],
  parameters: [],
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

describe('DatasetKindSchema', () => {
  it.each(['delimited', 'excel', 'table', 'query'])('accepts %s', (kind) => {
    expect(DatasetKindSchema.parse(kind)).toBe(kind);
  });

  it('rejects an unknown kind', () => {
    expect(() => DatasetKindSchema.parse('parquet')).toThrow();
  });
});

describe('DatasetColumnSchema', () => {
  it('round-trips a column', () => {
    expect(DatasetColumnSchema.parse({ name: 'total', type: 'number', nullable: true })).toEqual({
      name: 'total',
      type: 'number',
      nullable: true,
    });
  });

  it('rejects an empty column name', () => {
    expect(() => DatasetColumnSchema.parse({ name: '', type: 'string', nullable: true })).toThrow();
  });

  it('rejects an unknown column type', () => {
    expect(() => DatasetColumnSchema.parse({ name: 'x', type: 'blob', nullable: true })).toThrow();
  });

  // `nullable` is a FACT about the store, and either default would be a wrong
  // answer stated confidently (see the schema's own note) — so an absent one is
  // refused rather than invented.
  it('REJECTS an absent nullable rather than inventing one', () => {
    expect(() => DatasetColumnSchema.parse({ name: 'x', type: 'string' })).toThrow();
  });
});

describe('DatasetSchema', () => {
  it('round-trips a valid dataset', () => {
    expect(DatasetSchema.parse(validDataset)).toEqual(validDataset);
  });

  it('accepts a non-null ownerId', () => {
    const owned = { ...validDataset, ownerId: 'owner_1' };
    expect(DatasetSchema.parse(owned).ownerId).toBe('owner_1');
  });

  // §2.2 — `columns` is REQUIRED with NO `.default([])`. An absent column list
  // must fail loudly at the read boundary, never be manufactured as an empty
  // schema (the #473 lesson): an empty declared schema reads as "this table has
  // no columns", and auto-map (§6.3) would silently produce an empty mapping.
  it('REJECTS an absent columns list rather than manufacturing []', () => {
    const { columns, ...withoutColumns } = validDataset;
    void columns;
    expect(() => DatasetSchema.parse(withoutColumns)).toThrow();
  });

  it('accepts an EXPLICIT empty columns list (declared, not manufactured)', () => {
    expect(DatasetSchema.parse({ ...validDataset, columns: [] }).columns).toEqual([]);
  });

  it('rejects a missing required field', () => {
    const { connectionId, ...withoutConnection } = validDataset;
    void connectionId;
    expect(() => DatasetSchema.parse(withoutConnection)).toThrow();
  });

  it('rejects an empty connectionId', () => {
    expect(() => DatasetSchema.parse({ ...validDataset, connectionId: '' })).toThrow();
  });

  it('rejects a non-record config', () => {
    expect(() => DatasetSchema.parse({ ...validDataset, config: 'path=x.csv' })).toThrow();
  });

  // `parameters` reuses `Connection.parameters` verbatim, INCLUDING its
  // fail-CLOSED `.default([])`: an absent allowlist declares NOTHING
  // overridable. That is the opposite polarity to `columns`, where an absent
  // value would manufacture a FACT — hence one defaults and the other refuses.
  it('defaults an absent parameters to [] (declares nothing overridable — fail-closed)', () => {
    const { parameters, ...withoutParameters } = validDataset;
    void parameters;
    expect(DatasetSchema.parse(withoutParameters).parameters).toEqual([]);
  });

  it('rejects an empty-string parameter name', () => {
    expect(() => DatasetSchema.parse({ ...validDataset, parameters: [''] })).toThrow();
  });
});

describe('NewDatasetSchema', () => {
  it('accepts a payload without server-set fields', () => {
    const parsed = NewDatasetSchema.parse({
      ownerId: null,
      name: 'Orders',
      connectionId: 'conn_1',
      kind: 'table',
      config: { schema: 'public', table: 'orders' },
      columns: [{ name: 'id', type: 'integer', nullable: false }],
    });
    expect(parsed.name).toBe('Orders');
    expect(parsed.parameters).toEqual([]);
  });

  // Extra keys are STRIPPED by zod object parsing rather than refused, so the
  // real contract to assert is that a server-set field can never ride IN on a
  // client payload (`connection.test.ts`'s convention).
  it('strips a client-supplied id / resourceId (server-minted)', () => {
    const parsed = NewDatasetSchema.parse(validDataset);
    expect(parsed).not.toHaveProperty('id');
    expect(parsed).not.toHaveProperty('resourceId');
    expect(parsed).not.toHaveProperty('createdAt');
    expect(parsed).not.toHaveProperty('updatedAt');
  });

  // The same absence rule survives the insert shape — a create with no columns
  // must be refused, not defaulted.
  it('REJECTS an insert with no columns', () => {
    expect(() =>
      NewDatasetSchema.parse({
        ownerId: null,
        name: 'Orders',
        connectionId: 'conn_1',
        kind: 'table',
        config: {},
      }),
    ).toThrow();
  });
});
