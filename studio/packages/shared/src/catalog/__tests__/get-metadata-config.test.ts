import { describe, expect, it } from 'vitest';
import {
  GET_METADATA_ACTIVITY_TYPE,
  GET_METADATA_FIELDS,
  GET_METADATA_FIELDS_BY_CONNECTION_KIND,
  GET_METADATA_FS_FIELDS,
  GET_METADATA_TABLE_FIELDS,
  getMetadataKindIssue,
  getActivity,
  getMetadataConfigSchema,
} from '../../index.js';
import { enumSetValuesOf } from '../../schemas/field-presentation.js';

const ok = (cfg: Record<string, unknown>) => getMetadataConfigSchema.safeParse(cfg).success;
const issuesOf = (cfg: Record<string, unknown>) => {
  const r = getMetadataConfigSchema.safeParse(cfg);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('get_metadata config (#1600 OR41 C8a)', () => {
  it('needs a path and at least one field', () => {
    expect(ok({ path: '/d', fieldList: ['exists'] })).toBe(true);
    expect(issuesOf({ path: '/d', fieldList: [] })).toEqual(['fieldList: tick at least one field']);
    expect(ok({ path: '', fieldList: ['exists'] })).toBe(false);
  });

  it('takes only the known fields, each once', () => {
    expect(ok({ path: '/d', fieldList: [...GET_METADATA_FS_FIELDS] })).toBe(true);
    expect(ok({ fieldList: [...GET_METADATA_TABLE_FIELDS] })).toBe(true);
    expect(ok({ path: '/d', fieldList: ['rowCounts'] })).toBe(false);
    expect(issuesOf({ path: '/d', fieldList: ['size', 'size'] })).toEqual([
      'fieldList: Size is ticked twice',
    ]);
  });

  it('reads the child item settings only with Child items ticked', () => {
    // Left at their defaults they are accepted either way.
    expect(ok({ path: '/d', fieldList: ['size'], childFilter: '*', childType: 'all' })).toBe(true);
    expect(ok({ path: '/d', fieldList: ['size'], recursive: false })).toBe(true);
    for (const extra of [
      { childFilter: '*.csv' },
      { childType: 'files' },
      { modifiedStart: '2026-10-01T00:00:00Z' },
      { modifiedEnd: '2026-10-01T00:00:00Z' },
      { recursive: true },
    ]) {
      const [key] = Object.keys(extra);
      expect(issuesOf({ path: '/d', fieldList: ['size'], ...extra })).toEqual([
        `${key}: only read when Child items is ticked`,
      ]);
      expect(ok({ path: '/d', fieldList: ['childItems'], ...extra })).toBe(true);
    }
  });

  it('lists the top level only unless Include subfolders is ticked (C8e)', () => {
    const parsed = getMetadataConfigSchema.parse({ path: '/d', fieldList: ['childItems'] });
    expect(parsed.recursive).toBe(false);
    expect(ok({ path: '/d', fieldList: ['childItems'], recursive: 'yes' })).toBe(false);
  });

  it('refuses a separator in the filter and an empty modified window', () => {
    expect(issuesOf({ path: '/d', fieldList: ['childItems'], childFilter: 'a/*.csv' })).toEqual([
      'childFilter: a wildcard matches file names only, so it cannot hold a folder separator',
    ]);
    expect(
      issuesOf({
        path: '/d',
        fieldList: ['childItems'],
        modifiedStart: '2026-10-02T00:00:00Z',
        modifiedEnd: '2026-10-01T00:00:00Z',
      }),
    ).toEqual(['modifiedEnd: Modified before must be later than Modified from']);
    // A `${}` is decided at dispatch.
    expect(ok({ path: '/d', fieldList: ['childItems'], childFilter: '${pipeline().x}' })).toBe(
      true,
    );
  });

  it('is catalogued: an fs execution activity whose every field output is optional', () => {
    const entry = getActivity(GET_METADATA_ACTIVITY_TYPE);
    expect(entry?.title).toBe('Get metadata');
    expect(entry?.kind).toBe('execution');
    expect(entry?.connectionKinds).toEqual(['fs', 'sqlite', 'postgres']);
    // C8c — a table only through a dataset, which a path does not need.
    expect(entry?.datasetKinds).toEqual({ source: ['table'], optionalOn: ['fs'] });
    expect(entry?.inPalette).not.toBe(false);
    const outputs = entry?.outputs ?? [];
    expect(outputs.find((o) => o.name === 'path')?.optional).toBeUndefined();
    for (const field of GET_METADATA_FIELDS) {
      expect(outputs.find((o) => o.name === field)?.optional, field).toBe(true);
    }
    expect(outputs.map((o) => o.name)).toEqual(['path', ...GET_METADATA_FIELDS]);
    expect(entry?.outputElements?.structure?.map((o) => o.name)).toEqual(['name', 'type']);
    // A node saved under C8a (and the C8b lowering) holds the nine.
    expect(entry?.formerOutputs?.[0]?.map((o) => o.name)).toEqual([
      'path',
      ...GET_METADATA_FS_FIELDS,
    ]);
    expect(entry?.outputElements?.childItems?.map((o) => o.name)).toEqual([
      'name',
      'type',
      'size',
      'lastModified',
    ]);
    // A new node starts with no field ticked, as ADF's does.
    expect(entry?.newNodeConfig).toBeUndefined();
  });

  it('reads the field list as a set of choices', () => {
    const shape = (getMetadataConfigSchema as unknown as { shape: Record<string, unknown> }).shape;
    expect(enumSetValuesOf(shape.fieldList)).toEqual([...GET_METADATA_FIELDS]);
    expect(enumSetValuesOf(shape.childType)).toBeUndefined();
  });

  it('C8c: a path is optional in the config, so a table node needs none', () => {
    expect(ok({ fieldList: ['exists', 'rowCount'] })).toBe(true);
    expect(ok({ path: '', fieldList: ['exists'] })).toBe(false);
  });
});

describe('getMetadataKindIssue (#1600 OR41 C8c)', () => {
  const cfg = (c: Record<string, unknown>) => getMetadataConfigSchema.parse(c);

  it('takes a path and its fields on a file system connection', () => {
    expect(
      getMetadataKindIssue(cfg({ path: '/d', fieldList: [...GET_METADATA_FS_FIELDS] }), 'fs'),
    ).toBeUndefined();
    expect(getMetadataKindIssue(cfg({ fieldList: ['exists'] }), 'fs')).toBe(
      'File or folder path is required on a file system connection',
    );
    expect(
      getMetadataKindIssue(
        cfg({ path: '/d', fieldList: ['exists', 'structure', 'rowCount'] }),
        'fs',
      ),
    ).toBe('Structure, Row count read a database table, not a file system path');
  });

  it.each(['sqlite', 'postgres'] as const)("takes no path and a table's fields on %s", (kind) => {
    expect(
      getMetadataKindIssue(cfg({ fieldList: [...GET_METADATA_TABLE_FIELDS] }), kind),
    ).toBeUndefined();
    expect(getMetadataKindIssue(cfg({ path: 'orders', fieldList: ['exists'] }), kind)).toBe(
      'a table is chosen on the Source tab; clear File or folder path',
    );
    expect(getMetadataKindIssue(cfg({ fieldList: ['exists', 'size', 'childItems'] }), kind)).toBe(
      'Size, Child items read a file system path, not a table',
    );
  });

  it('offers each kind exactly its own fields', () => {
    expect(GET_METADATA_FIELDS_BY_CONNECTION_KIND.fs).toEqual(GET_METADATA_FS_FIELDS);
    expect(GET_METADATA_FIELDS_BY_CONNECTION_KIND.sqlite).toEqual([
      'exists',
      'structure',
      'columnCount',
      'rowCount',
    ]);
    expect(GET_METADATA_FIELDS_BY_CONNECTION_KIND.postgres).toEqual(GET_METADATA_TABLE_FIELDS);
  });
});
