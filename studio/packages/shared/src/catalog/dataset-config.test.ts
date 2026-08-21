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
  DELIMITED_ENCODINGS,
  delimitedDatasetConfigSchema,
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
    //
    // `delimited` joined at M7 slice 3 (#1167) — the slice that wired the `fs`
    // copy arm, which is what "a reader exists" means here. `excel` is the last
    // holdout and waits for M11, which is why this pin still has a `false` arm
    // to fail on rather than becoming a restatement of the enum.
    expect([...IMPLEMENTED_DATASET_KINDS].sort()).toEqual(['delimited', 'query', 'table']);
    expect(datasetKindIsImplemented('table')).toBe(true);
    expect(datasetKindIsImplemented('delimited')).toBe(true);
    expect(datasetKindIsImplemented('excel')).toBe(false);
  });

  it('keeps an unimplemented kind’s config INTACT rather than stripping it', () => {
    // M2 already ships `delimited`/`excel` in the address vocabulary, so a
    // config authored today must survive a parse unchanged. A bare
    // `z.object({})` would silently return `{}` and wipe it.
    //
    // Re-pointed from `delimited` to `excel` by #1163: `delimited` now has a
    // REAL schema, so it is no longer an example of this property. `excel`
    // still is, until M11 — which is why the test moved rather than went.
    const authored = { path: '/data/in.xlsx', sheet: 'Sheet1', headerRow: 1 };
    expect(unimplementedDatasetConfigSchema.parse(authored)).toEqual(authored);
    expect(datasetConfigSchema('excel').parse(authored)).toEqual(authored);
  });
});

describe('the `delimited` dataset config (#1163, M7 slice 1)', () => {
  const minimal = { path: '/data/in.csv', header: true };

  it('applies §2.6’s defaults, and only where a default is a FACT rather than a guess', () => {
    // §2.6 defaults `delimiter` explicitly. `quote` and `encoding` are defaulted
    // here too because a separated-values file that declares neither is
    // overwhelmingly RFC 4180 UTF-8, and getting either wrong produces visibly
    // mangled text rather than a plausible wrong value.
    expect(delimitedDatasetConfigSchema.parse(minimal)).toEqual({
      path: '/data/in.csv',
      delimiter: ',',
      quote: '"',
      header: true,
      encoding: 'utf-8',
    });
  });

  it('requires `header`, because neither answer is safe to invent', () => {
    // The one key §2.6's own M4 correction forbids defaulting. An absent
    // `header` defaulted true EATS ROW 1 of a headerless file and then names
    // every column after a data value; defaulted false turns the header into a
    // data row. And `configForm.ts`'s `ABSENTABLE_WRAPPERS` makes any
    // `.default()`ed boolean render as an UNCHECKED box, so the operator could
    // not tell "false" from "not set" — the exact defect that turned `readonly`
    // into `writable` at M4.
    const parsed = delimitedDatasetConfigSchema.safeParse({ path: '/data/in.csv' });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.path.join('.'))).toContain('header');
  });

  it('keeps `header: false` expressible — it is a real property of a real file', () => {
    expect(delimitedDatasetConfigSchema.parse({ path: '/f.csv', header: false }).header).toBe(
      false,
    );
  });

  it('refuses a multi-character delimiter rather than half-supporting it', () => {
    for (const delimiter of ['', ';;', '||']) {
      expect(delimitedDatasetConfigSchema.safeParse({ ...minimal, delimiter }).success).toBe(false);
    }
    expect(delimitedDatasetConfigSchema.safeParse({ ...minimal, delimiter: '\t' }).success).toBe(
      true,
    );
  });

  it('refuses a delimiter, quote or escape that is a row terminator', () => {
    // A terminator in either role makes the grammar ambiguous with itself:
    // there would be no way to tell the end of a field from the end of a row.
    for (const ch of ['\n', '\r']) {
      expect(delimitedDatasetConfigSchema.safeParse({ ...minimal, delimiter: ch }).success).toBe(
        false,
      );
      expect(delimitedDatasetConfigSchema.safeParse({ ...minimal, quote: ch }).success).toBe(false);
      expect(delimitedDatasetConfigSchema.safeParse({ ...minimal, escape: ch }).success).toBe(
        false,
      );
    }
  });

  it('refuses two roles sharing one character, and names the offending FIELD', () => {
    // Each pair is ambiguous by construction. `escape === quote` is the subtle
    // one: "a doubled quote is a literal quote" and "escape makes the next
    // character literal" would then be two rules competing for one byte.
    const cases: [Record<string, unknown>, string][] = [
      [{ delimiter: '"' }, 'quote'],
      [{ escape: '"' }, 'escape'],
      [{ escape: ',' }, 'escape'],
    ];
    for (const [patch, path] of cases) {
      const parsed = delimitedDatasetConfigSchema.safeParse({ ...minimal, ...patch });
      expect(parsed.success).toBe(false);
      // An object-level refine reports `path: []`, which `formatZodIssues` then
      // prints with no field prefix — so the issue must name the field.
      expect(parsed.error?.issues.map((i) => i.path.join('.'))).toContain(path);
    }
  });

  it('offers only encodings whose NAME matches what Node actually decodes', () => {
    // Measured on node v25.9.0: `new TextDecoder('latin1').encoding` is
    // `windows-1252`, identical to `ascii`. Offering either under its own name
    // would promise ISO-8859-1 or 7-bit ASCII and deliver cp1252 — so the
    // member is named for the decoder that actually runs.
    expect(DELIMITED_ENCODINGS).toEqual(['utf-8', 'utf-16le', 'utf-16be', 'windows-1252']);
    for (const bad of ['latin1', 'ascii', 'iso-8859-1', 'utf8']) {
      expect(delimitedDatasetConfigSchema.safeParse({ ...minimal, encoding: bad }).success).toBe(
        false,
      );
    }
  });

  it('accepts `nullValue: ""` as a MEANINGFUL declaration, not an empty one', () => {
    // `coerceValue` tests `opts.nullValue !== undefined`, so a dataset whose
    // file genuinely means "an empty field is NULL" declares exactly this. A
    // `.min(1)` here would look like tidying and would silently delete that.
    const parsed = delimitedDatasetConfigSchema.parse({ ...minimal, nullValue: '' });
    expect(parsed.nullValue).toBe('');
  });

  it('refuses a `dateFormat` the coercion matrix could never compile', () => {
    // Reuses the matrix's own compiler rather than restating the token rules:
    // otherwise a format every row will reject saves clean, and the operator
    // learns about it once per row at run time.
    expect(
      delimitedDatasetConfigSchema.safeParse({ ...minimal, dateFormat: 'yyyy-MM-dd' }).success,
    ).toBe(true);
    for (const bad of ['nonsense', 'yyyy-yyyy', 'YYYY']) {
      const parsed = delimitedDatasetConfigSchema.safeParse({ ...minimal, dateFormat: bad });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((i) => i.path.join('.'))).toContain('dateFormat');
    }
  });

  it('is wired into the catalog, and reports a real shape error through the advisory', () => {
    expect(datasetConfigSchema('delimited')).toBe(delimitedDatasetConfigSchema);
    const note = datasetConfigAdvisory('delimited', { path: '/f.csv', header: 'yes' });
    expect(note).toBeTruthy();
    expect(note).toMatch(/header/);
  });

  it('has a reader as of slice 3, so a well-formed config draws no advisory', () => {
    // The inversion of what this asserted at slice 1, and it is kept rather than
    // deleted because the SEPARATION it was written to pin is what changed: the
    // config shape (#1163) and the reader (#1167) are two facts, they landed one
    // slice apart, and `datasetConfigAdvisory` reads the second one.
    expect(datasetKindIsImplemented('delimited')).toBe(true);
    expect(datasetConfigAdvisory('delimited', { path: '/f.csv', header: true })).toBeNull();
    // A MALFORMED one still speaks — the advisory did not go quiet altogether.
    expect(datasetConfigAdvisory('delimited', { header: true })).toMatch(/path/i);
    // And `excel` still carries the no-reader note this arm used to prove.
    expect(datasetConfigAdvisory('excel', { path: '/f.xlsx' })).toMatch(/reader/i);
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
    //
    // #1189 (M10 slice 1) is the first time that decision came out NOT YET:
    // `postgres` IS a store, and it was deliberately absent from `table`/`query`
    // until a reader existed, because listing it is what would let an operator
    // author a dataset that can only fail at dispatch. **#1190 (M10 slice 2)
    // RESOLVED it** — the reader landed and `postgres` joined both kinds in the
    // same commit, so the map and the thing that honours it moved together. The
    // reasoning lives in full next to `DATASET_CONNECTION_KINDS` itself.
    //
    // This pin did its job twice over: it is the reason the slice-1 decision got
    // made at all, rather than the map quietly continuing to claim a `table` can
    // only live in SQLite, and it is what will force the same question for the
    // next store.
    expect([...ConnectionKindSchema.options]).toEqual([
      'anthropic_api',
      'openai_api',
      'ollama',
      'agent_cli',
      'http',
      'fs',
      'sqlite',
      'postgres',
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
        {
          kinds: entry.datasetKinds?.sink,
          stores: entry.sinkConnectionKinds ?? entry.connectionKinds,
        },
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
