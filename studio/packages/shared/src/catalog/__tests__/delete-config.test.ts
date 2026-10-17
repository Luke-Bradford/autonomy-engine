import { describe, expect, it } from 'vitest';
import {
  DELETE_ACTIVITY_TYPE,
  DELETE_MAX_CONCURRENT,
  deleteConfigSchema,
  getActivity,
  type Node,
} from '../../index.js';
import { activityNodeErrors } from '../../engine/activity-config-check.js';

const issuesOf = (cfg: Record<string, unknown>) => {
  const r = deleteConfigSchema.safeParse(cfg);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('delete config (#1600 OR41 C9a)', () => {
  it("defaults to a folder's top-level files, one at a time, as ADF", () => {
    expect(deleteConfigSchema.parse({ path: '/in' })).toEqual({
      pathType: 'folder',
      path: '/in',
      wildcard: '*',
      recursive: false,
      maxConcurrentConnections: 1,
      failIfNothingMatched: false,
      deleteEmptyFolders: false,
      // C9c — §4.1's session log default: warnings, to the run log.
      logLevel: 'warning',
      logTo: 'run',
    });
  });

  it('needs a path', () => {
    expect(issuesOf({})).toHaveLength(1);
    expect(issuesOf({ path: '' })).toHaveLength(1);
  });

  it('refuses a wildcard or Include subfolders on one file, rather than ignore them', () => {
    expect(issuesOf({ pathType: 'file', path: '/a.txt', wildcard: '*.txt' })).toEqual([
      'wildcard: only read when the path type is Folder',
    ]);
    expect(issuesOf({ pathType: 'file', path: '/a.txt', recursive: true })).toEqual([
      'recursive: only read when the path type is Folder',
    ]);
  });

  it('refuses Delete empty folders without Include subfolders', () => {
    expect(issuesOf({ path: '/in', deleteEmptyFolders: true })).toEqual([
      'deleteEmptyFolders: only read when Include subfolders is on',
    ]);
    expect(issuesOf({ path: '/in', recursive: true, deleteEmptyFolders: true })).toEqual([]);
  });

  it('refuses a folder in the wildcard and an empty window, and lets a ${} through', () => {
    expect(issuesOf({ path: '/in', wildcard: 'a/*.txt' })).toHaveLength(1);
    expect(
      issuesOf({
        path: '/in',
        modifiedStart: '2026-02-01T00:00:00Z',
        modifiedEnd: '2026-01-01T00:00:00Z',
      }),
    ).toEqual(['modifiedEnd: Modified before must be later than Modified from']);
    expect(issuesOf({ path: '/in', wildcard: '${pipeline().parameters.w}' })).toEqual([]);
  });

  it('bounds Max concurrent deletes', () => {
    expect(issuesOf({ path: '/in', maxConcurrentConnections: 0 })).toHaveLength(1);
    expect(issuesOf({ path: '/in', maxConcurrentConnections: DELETE_MAX_CONCURRENT })).toEqual([]);
    expect(
      issuesOf({ path: '/in', maxConcurrentConnections: DELETE_MAX_CONCURRENT + 1 }),
    ).toHaveLength(1);
  });

  it('takes dynamic content in its typed fields at save (UI STANDARD rule 4)', () => {
    const node = {
      id: 'd',
      type: DELETE_ACTIVITY_TYPE,
      connectionId: 'c',
      config: {
        path: '${pipeline().parameters.folder}',
        recursive: '${pipeline().parameters.deep}',
        maxConcurrentConnections: '${pipeline().parameters.n}',
        failIfNothingMatched: '${pipeline().parameters.strict}',
      },
    } as unknown as Node;
    expect(activityNodeErrors(node)).toEqual([]);
    // And the same check refuses a literal out of range, so it is not vacuous.
    const literal = { ...node, config: { ...node.config, maxConcurrentConnections: 0 } } as Node;
    expect(activityNodeErrors(literal)).toHaveLength(1);
  });

  it('is a non-idempotent fs activity whose outputs keep file_delete’s path', () => {
    const entry = getActivity(DELETE_ACTIVITY_TYPE)!;
    expect(entry).toMatchObject({ idempotent: false, connectionKinds: ['fs'] });
    expect(entry.outputs.map((o) => [o.name, o.type])).toEqual([
      ['path', 'string'],
      ['filesDeleted', 'number'],
      ['foldersDeleted', 'number'],
      ['logPath', 'string'],
    ]);
    // C9c — present-null when no log file is written, and a node saved before
    // it is re-seeded with it.
    expect(entry.outputs.at(-1)).toEqual({ name: 'logPath', type: 'string', optional: true });
    expect(entry.formerOutputs).toEqual([
      [
        { name: 'path', type: 'string' },
        { name: 'filesDeleted', type: 'number' },
        { name: 'foldersDeleted', type: 'number' },
      ],
    ]);
  });

  it('refuses a session log setting that would be ignored or cannot run (C9c)', () => {
    expect(issuesOf({ path: '/in', logTo: 'folder', logFolder: '/logs' })).toEqual([]);
    expect(issuesOf({ path: '/in', logLevel: 'off', logTo: 'folder', logFolder: '/logs' })).toEqual(
      ['logLevel: the session log is off, but it is set to write to a folder'],
    );
    expect(issuesOf({ path: '/in', logTo: 'folder' })).toEqual([
      'logFolder: needed to write the session log to a folder',
    ]);
    expect(issuesOf({ path: '/in', logFolder: '/logs' })).toEqual([
      'logFolder: only read when the session log is written to a folder',
    ]);
    expect(issuesOf({ path: '/in', logLevel: 'everything' })).toHaveLength(1);
  });
});
