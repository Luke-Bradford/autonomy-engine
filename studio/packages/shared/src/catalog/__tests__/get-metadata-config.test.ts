import { describe, expect, it } from 'vitest';
import {
  GET_METADATA_ACTIVITY_TYPE,
  GET_METADATA_FS_FIELDS,
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

  it('takes only the file system fields, each once', () => {
    expect(ok({ path: '/d', fieldList: [...GET_METADATA_FS_FIELDS] })).toBe(true);
    expect(ok({ path: '/d', fieldList: ['rowCount'] })).toBe(false);
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
    expect(entry?.connectionKinds).toEqual(['fs']);
    expect(entry?.inPalette).not.toBe(false);
    const outputs = entry?.outputs ?? [];
    expect(outputs.find((o) => o.name === 'path')?.optional).toBeUndefined();
    for (const field of GET_METADATA_FS_FIELDS) {
      expect(outputs.find((o) => o.name === field)?.optional, field).toBe(true);
    }
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
    expect(enumSetValuesOf(shape.fieldList)).toEqual([...GET_METADATA_FS_FIELDS]);
    expect(enumSetValuesOf(shape.childType)).toBeUndefined();
  });
});
