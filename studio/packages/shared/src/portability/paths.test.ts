import { describe, expect, it } from 'vitest';
import {
  MANAGED_DIRS,
  RESOURCE_KIND_DIRS,
  RESOURCE_KINDS,
  kindForDir,
  resourceSlug,
  resourceFilePaths,
} from './paths.js';

describe('dir↔kind SSOT', () => {
  it('MANAGED_DIRS is exactly the kind dirs in RESOURCE_KINDS order', () => {
    expect(MANAGED_DIRS).toEqual(RESOURCE_KINDS.map((k) => RESOURCE_KIND_DIRS[k]));
    expect(MANAGED_DIRS).toEqual(['pipelines', 'connections', 'triggers']);
  });

  it('kindForDir is the exact inverse of RESOURCE_KIND_DIRS', () => {
    for (const kind of RESOURCE_KINDS) {
      expect(kindForDir(RESOURCE_KIND_DIRS[kind])).toBe(kind);
    }
  });

  it('kindForDir returns null for a non-managed directory', () => {
    expect(kindForDir('runs')).toBeNull();
    expect(kindForDir('')).toBeNull();
    expect(kindForDir('pipelines/nested')).toBeNull();
  });
});

describe('resourceSlug', () => {
  it('lowercases and collapses non-alphanumeric runs to a single dash', () => {
    expect(resourceSlug('My Pipeline')).toBe('my-pipeline');
    expect(resourceSlug('Weekly  Report!!')).toBe('weekly-report');
    expect(resourceSlug('a/b\\c')).toBe('a-b-c');
  });

  it('trims leading and trailing dashes', () => {
    expect(resourceSlug('  spaced  ')).toBe('spaced');
    expect(resourceSlug('...dots...')).toBe('dots');
  });

  it('neutralizes path-traversal characters (dots and slashes become dashes)', () => {
    // A hostile name cannot climb out of its kind dir — every `.` and `/` is a
    // non-alphanumeric, so `..` and `/` collapse to a dash.
    expect(resourceSlug('../../etc/passwd')).toBe('etc-passwd');
    expect(resourceSlug('..')).toBe('');
  });

  it('returns empty string when the name has no alphanumerics', () => {
    expect(resourceSlug('!!!')).toBe('');
    expect(resourceSlug('')).toBe('');
  });
});

describe('resourceFilePaths', () => {
  it('maps each resource to <dir>/<slug>.json under its kind directory', () => {
    const paths = resourceFilePaths('pipeline', [
      { resourceId: 'res_a', name: 'My Pipeline' },
      { resourceId: 'res_b', name: 'Other' },
    ]);
    expect(paths.get('res_a')).toBe('pipelines/my-pipeline.json');
    expect(paths.get('res_b')).toBe('pipelines/other.json');
  });

  it('uses the kind directory for connections and triggers', () => {
    expect(resourceFilePaths('connection', [{ resourceId: 'r', name: 'X' }]).get('r')).toBe(
      'connections/x.json',
    );
    expect(resourceFilePaths('trigger', [{ resourceId: 'r', name: 'X' }]).get('r')).toBe(
      'triggers/x.json',
    );
  });

  it('suffixes ALL colliding resources with their resourceId — never just the loser', () => {
    const paths = resourceFilePaths('pipeline', [
      { resourceId: 'res_1', name: 'Report' },
      { resourceId: 'res_2', name: 'Report' },
    ]);
    // Both get suffixed (a content-decided rule, so the assignment can't flip
    // with iteration order); neither keeps the bare `report.json`.
    expect(paths.get('res_1')).toBe('pipelines/report-res_1.json');
    expect(paths.get('res_2')).toBe('pipelines/report-res_2.json');
  });

  it('is order-independent: reversing the input yields the identical path set', () => {
    const forward = resourceFilePaths('pipeline', [
      { resourceId: 'res_1', name: 'Report' },
      { resourceId: 'res_2', name: 'Report' },
      { resourceId: 'res_3', name: 'Solo' },
    ]);
    const reversed = resourceFilePaths('pipeline', [
      { resourceId: 'res_3', name: 'Solo' },
      { resourceId: 'res_2', name: 'Report' },
      { resourceId: 'res_1', name: 'Report' },
    ]);
    expect(Object.fromEntries(reversed)).toEqual(Object.fromEntries(forward));
  });

  it('falls back to the resourceId as the slug when the name has no alphanumerics', () => {
    // An empty base slug would produce `pipelines/.json`; the stable, unique
    // resourceId stands in (identity is the resourceId, the path is cosmetic).
    const paths = resourceFilePaths('pipeline', [{ resourceId: 'res_z', name: '!!!' }]);
    expect(paths.get('res_z')).toBe('pipelines/res_z.json');
  });
});
