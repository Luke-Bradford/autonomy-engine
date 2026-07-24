import type { WorkspaceFile } from '../portability/workspace-serialize.js';
import { GitOperationError, GitUnavailableError, type GitProvider } from './provider.js';

/** #3 G4 — the managed files read at a ref, split into the ones read
 * successfully and the paths that could NOT be read (#664 — a blob over the
 * provider's collected-output cap, or a per-blob git failure). `unreadable` is
 * surfaced downstream as `unreadable` parse diagnostics (visible, not dropped)
 * instead of one bad file 502ing the whole preview/import. */
export interface WorkspaceFilesAtRef {
  files: WorkspaceFile[];
  unreadable: string[];
}

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
 *
 * A per-blob read failure is TOLERATED (#664): a `GitOperationError` (the most
 * common cause being a committed blob larger than the provider's 1 MiB
 * collected-output cap) drops that ONE path into `unreadable` for a downstream
 * diagnostic, rather than rejecting and turning the whole preview/import into a
 * 502. A `GitUnavailableError` is SYSTEMIC (git binary gone / a tool-level
 * failure, not this file) and is rethrown, aborting the read — fail-safe, never
 * fold a systemic outage into per-file "unreadable" noise. Any other error is
 * unexpected and rethrown (never swallowed).
 *
 * NOTE (#664, deliberate non-goal): `lsTreeManaged` itself shares the same 1 MiB
 * output cap, so a pathological managed TREE (tens of thousands of files) can
 * still fail the listing wholesale. That is a different, far less likely shape
 * than a single oversized blob and is out of this fix's scope.
 */
export async function readWorkspaceFilesAtRef(
  provider: Pick<GitProvider, 'lsTreeManaged' | 'showBlob'>,
  checkout: string,
  ref: string,
  dirs: readonly string[],
): Promise<WorkspaceFilesAtRef> {
  const entries = (await provider.lsTreeManaged(checkout, ref, dirs)).filter((entry) =>
    entry.path.endsWith('.json'),
  );
  // Object-store reads are read-only and concurrency-safe; `Promise.all` over
  // `map` preserves `entries` order. Each read resolves to its contents or `null`
  // (unreadable); a systemic/unexpected error rejects the whole read. The entry's
  // git blob sha (#3 G6b) rides along so a minted version records its provenance.
  const results = await Promise.all(
    entries.map(
      async (entry): Promise<{ path: string; blobSha: string; contents: string | null }> => {
        try {
          return {
            path: entry.path,
            blobSha: entry.blobSha,
            contents: await provider.showBlob(checkout, ref, entry.path),
          };
        } catch (err) {
          if (err instanceof GitUnavailableError) throw err; // systemic — abort the read
          if (err instanceof GitOperationError)
            return { path: entry.path, blobSha: entry.blobSha, contents: null }; // this file only
          throw err; // unexpected — never swallow
        }
      },
    ),
  );

  const files: WorkspaceFile[] = [];
  const unreadable: string[] = [];
  for (const result of results) {
    if (result.contents === null) unreadable.push(result.path);
    else files.push({ path: result.path, contents: result.contents, blobSha: result.blobSha });
  }
  return { files, unreadable };
}
