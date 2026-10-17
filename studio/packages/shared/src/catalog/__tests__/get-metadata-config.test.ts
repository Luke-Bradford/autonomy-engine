import { describe, expect, it } from 'vitest';
import {
  GET_METADATA_ACTIVITY_TYPE,
  GET_METADATA_FIELDS,
  GET_METADATA_FIELDS_BY_CONNECTION_KIND,
  GET_METADATA_FILE_DATASET_FIELDS,
  GET_METADATA_FS_FIELDS,
  GET_METADATA_TABLE_FIELDS,
  getMetadataKindIssue,
  getMetadataNodeIssue,
  getActivity,
  getMetadataConfigSchema,
} from '../../index.js';
import { enumSetValuesOf } from '../../schemas/field-presentation.js';
import { activityNodeErrors } from '../../engine/activity-config-check.js';

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
    // C8c — a table only through a dataset, which a path does not need; C8c-2 —
    // a delimited or Excel file through one too.
    expect(entry?.datasetKinds).toEqual({
      source: ['table', 'delimited', 'excel'],
      optionalOn: ['fs'],
    });
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
      getMetadataKindIssue(
        cfg({ path: '/d', fieldList: [...GET_METADATA_FS_FIELDS] }),
        'fs',
        false,
      ),
    ).toBeUndefined();
    expect(getMetadataKindIssue(cfg({ fieldList: ['exists'] }), 'fs', false)).toBe(
      'File or folder path, or a delimited or Excel dataset chosen on Source, is required on a file system connection',
    );
    expect(
      getMetadataKindIssue(cfg({ path: '/d', fieldList: ['exists', 'rowCount'] }), 'fs', false),
    ).toBe('Row count read a database table, not a file system path');
    // C8c-2 — a file's columns are read through its dataset, not a path.
    expect(
      getMetadataKindIssue(
        cfg({ path: '/d', fieldList: ['exists', 'structure', 'columnCount'] }),
        'fs',
        false,
      ),
    ).toBe('Structure, Column count read a delimited or Excel dataset chosen on Source, not a path');
  });

  it("C8c-2: takes a file dataset and a file's fields on a file system connection", () => {
    expect(
      getMetadataKindIssue(cfg({ fieldList: [...GET_METADATA_FILE_DATASET_FIELDS] }), 'fs', true),
    ).toBeUndefined();
    expect(getMetadataKindIssue(cfg({ fieldList: ['exists', 'childItems'] }), 'fs', true)).toBe(
      'Child items read a folder path, not a dataset',
    );
    expect(getMetadataKindIssue(cfg({ fieldList: ['rowCount'] }), 'fs', true)).toBe(
      'Row count read a database table, not a file',
    );
    expect(getMetadataKindIssue(cfg({ path: '/d', fieldList: ['exists'] }), 'fs', true)).toBe(
      'a dataset chosen on Source names what to read; clear File or folder path',
    );
  });

  it.each(['sqlite', 'postgres'] as const)("takes no path and a table's fields on %s", (kind) => {
    expect(
      getMetadataKindIssue(cfg({ fieldList: [...GET_METADATA_TABLE_FIELDS] }), kind, true),
    ).toBeUndefined();
    expect(getMetadataKindIssue(cfg({ path: 'orders', fieldList: ['exists'] }), kind, true)).toBe(
      'a table is chosen on the Source tab; clear File or folder path',
    );
    expect(getMetadataKindIssue(cfg({ fieldList: ['exists', 'size', 'childItems'] }), kind, true)).toBe(
      'Size, Child items read a file system path, not a table',
    );
  });

  it('offers each kind exactly its own fields', () => {
    // C8c-2 — a path's eight and a file dataset's two column fields.
    expect(GET_METADATA_FIELDS_BY_CONNECTION_KIND.fs).toEqual([
      ...GET_METADATA_FS_FIELDS,
      'structure',
      'columnCount',
    ]);
    expect(GET_METADATA_FILE_DATASET_FIELDS).toEqual([
      'exists',
      'itemName',
      'itemType',
      'size',
      'created',
      'lastModified',
      'contentMD5',
      'structure',
      'columnCount',
    ]);
    expect(GET_METADATA_FIELDS_BY_CONNECTION_KIND.sqlite).toEqual([
      'exists',
      'structure',
      'columnCount',
      'rowCount',
    ]);
    expect(GET_METADATA_FIELDS_BY_CONNECTION_KIND.postgres).toEqual(GET_METADATA_TABLE_FIELDS);
  });
});

describe('getMetadataNodeIssue (#1600 OR41 C8c)', () => {
  it('takes a path or a table, not neither and not both', () => {
    expect(getMetadataNodeIssue({ config: { path: '/d' } })).toBeUndefined();
    expect(getMetadataNodeIssue({ config: {}, datasetIds: { source: 'ds' } })).toBeUndefined();
    expect(
      getMetadataNodeIssue({ config: {}, inlineDatasets: { source: { kind: 'table' } } }),
    ).toBeUndefined();
    expect(getMetadataNodeIssue({ config: {} })).toBe(
      'config.path: required: a file or folder path, or a dataset chosen on Source',
    );
    expect(getMetadataNodeIssue({ config: { path: 't' }, datasetIds: { source: 'ds' } })).toBe(
      'config.path: a dataset chosen on Source names what to read; clear File or folder path',
    );
  });

  it('C8c-2: refuses at save a field that its path or dataset can never answer', () => {
    // A path is a file system item's: its columns come through a dataset.
    expect(
      getMetadataNodeIssue({ config: { path: '/d', fieldList: ['exists', 'structure'] } }),
    ).toBe(
      'config.fieldList: Structure read a delimited or Excel dataset chosen on Source, not a path',
    );
    expect(getMetadataNodeIssue({ config: { path: '/d', fieldList: ['rowCount'] } })).toBe(
      'config.fieldList: Row count read a database table, not a file system path',
    );
    // A dataset, file or table, names one object, never a folder to list.
    expect(
      getMetadataNodeIssue({
        config: { fieldList: ['childItems'] },
        datasetIds: { source: 'ds' },
      }),
    ).toBe('config.fieldList: Child items read a folder path, not a dataset');
    expect(
      getMetadataNodeIssue({
        config: { fieldList: ['structure', 'columnCount'] },
        datasetIds: { source: 'ds' },
      }),
    ).toBeUndefined();
  });

  it('is a save-time refusal of the node', () => {
    const node = (over: Record<string, unknown>) =>
      ({ id: 'm', type: 'get_metadata', position: { x: 0, y: 0 }, ...over }) as never;
    expect(activityNodeErrors(node({ config: { fieldList: ['exists'] } }))).toEqual([
      "node 'm': config.path: required: a file or folder path, or a dataset chosen on Source",
    ]);
    expect(
      activityNodeErrors(node({ config: { fieldList: ['exists'] }, datasetIds: { source: 'd' } })),
    ).toEqual([]);
  });
});
