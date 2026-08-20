import { describe, expect, it } from 'vitest';
import { ConnectionKindSchema } from '../schemas/connection.js';
import { DatasetKindSchema } from '../schemas/dataset.js';
import { catalog } from './registry.js';
import {
  DATASET_CONFIG_SCHEMAS,
  DATASET_CONNECTION_KINDS,
  datasetConnectionKindAdvisory,
  DATASET_KINDS,
  IMPLEMENTED_DATASET_KINDS,
  datasetConfigAdvisory,
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

describe('datasetConfigAdvisory (#1120)', () => {
  it('says nothing about a well-formed config for a kind with a reader', () => {
    expect(datasetConfigAdvisory('table', { table: 'orders' })).toBeNull();
    expect(datasetConfigAdvisory('query', { sql: 'select 1' })).toBeNull();
  });

  it('names the offending key when the kind’s own schema refuses the config', () => {
    const note = datasetConfigAdvisory('table', {});
    expect(note).not.toBeNull();
    expect(note).toContain('table');

    // The identifier rule is the security-relevant one (§8): a table name cannot
    // be bound as a parameter, so a name needing quoting is refused rather than
    // accommodated. An operator learns that here instead of at dispatch.
    const spaced = datasetConfigAdvisory('table', { table: 'order lines' });
    expect(spaced).toContain('bare SQL identifier');
  });

  it('reports a kind with no reader even though its config parses', () => {
    // `unimplementedDatasetConfigSchema` is a `looseObject`, so this config is
    // VALID — which is exactly why the note has to come from the positive
    // `IMPLEMENTED_DATASET_KINDS` fact rather than from the parse result.
    expect(unimplementedDatasetConfigSchema.safeParse({ path: '/tmp/x.csv' }).success).toBe(true);
    for (const kind of DATASET_KINDS.filter((k) => !IMPLEMENTED_DATASET_KINDS.has(k))) {
      expect(datasetConfigAdvisory(kind, { path: '/tmp/x.csv' })).toContain('no reader exists');
    }
  });

  it('reports BOTH a schema complaint and a missing reader in one sentence', () => {
    // `query` has a reader, so this proves the two notes are independent: swap in
    // a kind that has neither a reader nor a satisfied schema and both appear.
    const note = datasetConfigAdvisory('query', { sql: '' });
    expect(note).not.toBeNull();
    expect(note).not.toContain('no reader exists');
  });

  it('is total over every kind, for any config', () => {
    // A kind added without a `DATASET_CONFIG_SCHEMAS` entry is already a type
    // error; this pins that the advisory itself never throws on one.
    for (const kind of DATASET_KINDS) {
      expect(() => datasetConfigAdvisory(kind, {})).not.toThrow();
    }
  });
});

describe('DATASET_CONNECTION_KINDS (#1145)', () => {
  it('covers every dataset kind, and nothing that is not one', () => {
    // `Record<DatasetKind, …>` makes a MISSING kind a compile error; this
    // catches the other direction — a stale key left behind by a rename.
    expect(Object.keys(DATASET_CONNECTION_KINDS).sort()).toEqual(
      [...DatasetKindSchema.options].sort(),
    );
  });

  it('names only real connection kinds, and never an empty list', () => {
    // An empty list would make EVERY store wrong for that kind — an advisory
    // that can only ever complain is worse than one that stays quiet.
    for (const kind of DATASET_KINDS) {
      const stores = DATASET_CONNECTION_KINDS[kind];
      expect(stores.length).toBeGreaterThan(0);
      for (const store of stores) expect(ConnectionKindSchema.options).toContain(store);
    }
  });

  it('reds this file when a CONNECTION kind is added', () => {
    // The pin `Record<DatasetKind, …>` cannot provide. A new dataset kind is a
    // type error; a new CONNECTION kind is the direction that makes this module
    // LIE — when `postgres` joins the enum, a `table` dataset on a postgres
    // store would be told to expect `sqlite`. So the enum is pinned to a
    // literal: adding a kind fails here, next to the mapping that must widen.
    //
    // Adding a kind? Decide whether it is a STORE. If it is, add it to every
    // dataset kind that can live in it below, then extend this list.
    expect([...ConnectionKindSchema.options]).toEqual([
      'anthropic_api',
      'openai_api',
      'ollama',
      'agent_cli',
      'http',
      'fs',
      'sqlite',
    ]);
  });

  it('agrees with the activity catalog about where a dataset kind lives', () => {
    // `registry.ts` states the same fact one layer up — `copy` couples
    // `connectionKinds` with `datasetKinds` — so two SSOTs now describe "a
    // `table` lives in a SQL store" and they would drift at M7.
    //
    // INTERSECTION, not containment, and that is load-bearing: M7 widens
    // `copy.connectionKinds` to `['sqlite', 'fs']` to admit `delimited`, at
    // which point containment would falsely fail for `table` (whose stores stay
    // `['sqlite']`). What must hold is that every dataset kind an activity
    // accepts has at least one store that activity can also connect to.
    for (const entry of catalog.values()) {
      const sides = [
        { kinds: entry.datasetKinds?.source, stores: entry.connectionKinds },
        { kinds: entry.datasetKinds?.sink, stores: entry.sinkConnectionKinds ?? entry.connectionKinds },
      ];
      for (const side of sides) {
        if (side.kinds === undefined) continue;
        for (const datasetKind of side.kinds) {
          const shared = DATASET_CONNECTION_KINDS[datasetKind].filter((store) =>
            side.stores.includes(store),
          );
          expect(
            shared,
            `${entry.type} accepts a ${datasetKind} dataset but connects to no store one can live in`,
          ).not.toHaveLength(0);
        }
      }
    }
  });
});

describe('datasetConnectionKindAdvisory (#1145)', () => {
  it('says nothing when the kind agrees with the store', () => {
    expect(datasetConnectionKindAdvisory('table', 'sqlite')).toBeNull();
    expect(datasetConnectionKindAdvisory('query', 'sqlite')).toBeNull();
    expect(datasetConnectionKindAdvisory('delimited', 'fs')).toBeNull();
  });

  it('names the dataset kind, the store it needs and the store it got', () => {
    // The ticket's own example: a `table` dataset on an LLM connection, which
    // `routes/datasets.ts` stores today because it checks existence and
    // ownership and nothing else.
    const note = datasetConnectionKindAdvisory('table', 'anthropic_api');
    expect(note).toContain('table');
    expect(note).toContain('sqlite');
    expect(note).toContain('anthropic_api');
  });

  it('says nothing when no connection is resolved', () => {
    // The form owns both of those states already (no connections at all, or a
    // connection that no longer exists) and says so in its own words. A
    // complaint derived from a connection nobody resolved would be invented.
    for (const kind of DATASET_KINDS) {
      expect(datasetConnectionKindAdvisory(kind, null)).toBeNull();
    }
  });

  it('is total over every kind pair, and complains about exactly the mismatches', () => {
    for (const datasetKind of DATASET_KINDS) {
      for (const connectionKind of ConnectionKindSchema.options) {
        const note = datasetConnectionKindAdvisory(datasetKind, connectionKind);
        const agrees = DATASET_CONNECTION_KINDS[datasetKind].includes(connectionKind);
        expect(note === null, `${datasetKind} on ${connectionKind}`).toBe(agrees);
      }
    }
  });
});
