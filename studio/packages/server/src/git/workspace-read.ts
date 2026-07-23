import type { WorkspaceFile } from '../portability/workspace-serialize.js';
import type { GitProvider } from './provider.js';

/**
 * #3 G4 — read the studio-managed files committed at `ref` into the
 * `WorkspaceFile[]` the pure parser (`portability/workspace-parse.ts`) consumes.
 * Reads straight from the git object store (`ls-tree` + `show`) — no working-tree
 * checkout, so it is safe alongside the Commit path in the same `KeyedQueue`.
 *
 * Only `*.json` blobs are read: studio only ever serializes `.json`, so a
 * `.gitkeep`/`README` a human dropped into a managed dir is IGNORED here rather
 * than surfacing as a spurious "unparseable" diagnostic downstream. `ref` must
 * be a resolved sha so every blob is read from ONE immutable snapshot.
 */
export async function readWorkspaceFilesAtRef(
  provider: Pick<GitProvider, 'lsTreeManaged' | 'showBlob'>,
  checkout: string,
  ref: string,
  dirs: readonly string[],
): Promise<WorkspaceFile[]> {
  const paths = (await provider.lsTreeManaged(checkout, ref, dirs)).filter((path) =>
    path.endsWith('.json'),
  );
  // Object-store reads are read-only and concurrency-safe; `Promise.all` over
  // `map` preserves `paths` order so the returned `WorkspaceFile[]` stays stable.
  return Promise.all(
    paths.map(async (path) => ({ path, contents: await provider.showBlob(checkout, ref, path) })),
  );
}
