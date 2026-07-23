import { describe, expect, it } from 'vitest';
import { readWorkspaceFilesAtRef } from '../workspace-read.js';

/**
 * #3 G4 — the git reader glue. The provider's real ls-tree/show behaviour is
 * covered in `provider.test.ts` against real git; here a stub isolates the
 * reader's own logic: it filters to `.json` and reads each surviving path at the
 * given ref.
 */

function stubProvider(tree: Record<string, string>) {
  return {
    lsTreeManaged: async () => Object.keys(tree),
    showBlob: async (_dir: string, _ref: string, path: string) => tree[path]!,
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

    const files = await readWorkspaceFilesAtRef(provider, '/checkout', 'deadbeef', [
      'pipelines',
      'connections',
    ]);

    expect(files).toEqual([
      { path: 'pipelines/a.json', contents: '{"a":1}' },
      { path: 'connections/b.json', contents: '{"b":2}' },
    ]);
  });

  it('returns [] when the tree has no managed files', async () => {
    const files = await readWorkspaceFilesAtRef(stubProvider({}), '/checkout', 'deadbeef', [
      'pipelines',
    ]);
    expect(files).toEqual([]);
  });
});
