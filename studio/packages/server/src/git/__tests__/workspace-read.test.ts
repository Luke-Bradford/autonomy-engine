import { describe, expect, it } from 'vitest';
import { readWorkspaceFilesAtRef } from '../workspace-read.js';
import { GitOperationError, GitUnavailableError } from '../provider.js';

/**
 * #3 G4 — the git reader glue. The provider's real ls-tree/show behaviour is
 * covered in `provider.test.ts` against real git; here a stub isolates the
 * reader's own logic: it filters to `.json`, reads each surviving path at the
 * given ref, and (#664) tolerates a per-blob read failure by routing that path
 * to `unreadable` instead of rejecting the whole read.
 */

function stubProvider(tree: Record<string, string>) {
  return {
    lsTreeManaged: async () => Object.keys(tree),
    showBlob: async (_dir: string, _ref: string, path: string) => tree[path]!,
  };
}

/** A provider whose `showBlob` throws `err` for `failPath` and returns the tree
 * contents otherwise — models one over-cap / failing blob among readable ones. */
function stubProviderFailing(tree: Record<string, string>, failPath: string, err: Error) {
  return {
    lsTreeManaged: async () => Object.keys(tree),
    showBlob: async (_dir: string, _ref: string, path: string) => {
      if (path === failPath) throw err;
      return tree[path]!;
    },
  };
}

describe('readWorkspaceFilesAtRef', () => {
  it('reads every .json blob and IGNORES non-json files in a managed dir', async () => {
    const provider = stubProvider({
      'pipelines/a.json': '{"a":1}',
      'connections/b.json': '{"b":2}',
      'pipelines/keep.gitkeep': '',
      'pipelines/README': 'notes',
    });

    const result = await readWorkspaceFilesAtRef(provider, '/checkout', 'deadbeef', [
      'pipelines',
      'connections',
    ]);

    expect(result).toEqual({
      files: [
        { path: 'pipelines/a.json', contents: '{"a":1}' },
        { path: 'connections/b.json', contents: '{"b":2}' },
      ],
      unreadable: [],
    });
  });

  it('returns no files when the tree has no managed files', async () => {
    const result = await readWorkspaceFilesAtRef(stubProvider({}), '/checkout', 'deadbeef', [
      'pipelines',
    ]);
    expect(result).toEqual({ files: [], unreadable: [] });
  });

  it('#664 — routes a per-blob GitOperationError (e.g. over the output cap) to `unreadable`, keeps the rest', async () => {
    const provider = stubProviderFailing(
      { 'pipelines/ok.json': '{"a":1}', 'pipelines/huge.json': '(never returned)' },
      'pipelines/huge.json',
      new GitOperationError('show', 'output exceeded the cap'),
    );

    const result = await readWorkspaceFilesAtRef(provider, '/checkout', 'deadbeef', ['pipelines']);

    expect(result).toEqual({
      files: [{ path: 'pipelines/ok.json', contents: '{"a":1}' }],
      unreadable: ['pipelines/huge.json'],
    });
  });

  it('#664 — RETHROWS a systemic GitUnavailableError (never folds it into `unreadable`)', async () => {
    const provider = stubProviderFailing(
      { 'pipelines/ok.json': '{"a":1}' },
      'pipelines/ok.json',
      new GitUnavailableError('git'),
    );

    await expect(
      readWorkspaceFilesAtRef(provider, '/checkout', 'deadbeef', ['pipelines']),
    ).rejects.toThrow(GitUnavailableError);
  });
});
