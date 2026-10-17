/**
 * #1600 OR41 C9a — Delete on a file system connection (catalogue §4.4, ADF's
 * https://learn.microsoft.com/azure/data-factory/delete-activity).
 *
 * One file, or a folder's files that match the wildcard and the modified
 * window, with Include subfolders; then, with Delete empty folders, every
 * subfolder left empty. Everything is chosen BEFORE anything is deleted, so the
 * entry cap, a bad window or Fail if nothing matched fail the node with every
 * file still there.
 *
 * Deliberate differences from ADF, recorded in the catalogue spec:
 *  - The folder at the path is never removed. ADF's recursive delete of a
 *    folder with no file name removes the folder too; here that is Delete
 *    empty folders, and it stops at the path.
 *  - Only regular files are deleted. A link is left in place and never
 *    followed, and so is an entry of any other type.
 *  - A missing path matches nothing, rather than failing. Fail if nothing
 *    matched makes it fail.
 *
 * Containment on a destructive walk. The walk's `opendir` follows a folder
 * swapped for a link after its `lstat` (`fs-walk.ts`), so before each `unlink`
 * and `rmdir` the entry's folder is resolved again and must still be the
 * folder at the path or under it, and the entry must still be the one planned
 * (device and inode, as `bigint`) and still in the window. The residual is the
 * gap between that check and the call, which Node cannot close without
 * `unlinkat`; it is the same gap Copy · Files as-is's delete-source has.
 */
import { realpath, rmdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { z } from 'zod';
import type { DeleteConfig } from '@autonomy-studio/shared';
import { failed } from './activity-events.js';
import { isMissingErrno, resolveWithinRootsOrMissing } from './confine.js';
import type { fsConnectionConfigSchema } from './fs-connection.js';
import {
  DEFAULT_MAX_LIST_ENTRIES,
  direntType,
  lstatOrNull,
  modifiedWindow,
  wildcardMatcher,
  within,
} from './fs-select.js';
import { walkFolder, type WalkedEntry } from './fs-walk.js';
import { failFromError } from './fs-write.js';
import type { ActivityEvent } from './types.js';

type FsConfig = z.infer<typeof fsConnectionConfigSchema>;

export const DELETE_ABORTED = 'file delete aborted';

/** The planned entry a delete acts on: its path and the identity it was seen with. */
type Planned = Pick<WalkedEntry, 'abs' | 'st'>;

/**
 * `rmdir` answers that leave a folder in place without failing the node: not
 * empty, gone, no longer a folder, or a mount point (`EBUSY`, which no retry
 * would change).
 */
const KEPT_FOLDER = new Set(['ENOTEMPTY', 'EEXIST', 'ENOENT', 'ENOTDIR', 'EBUSY']);

export async function* runDelete(
  cfg: FsConfig,
  input: DeleteConfig,
  signal: AbortSignal,
): AsyncGenerator<ActivityEvent> {
  if (cfg.writable !== true) {
    yield failed(
      'permanent',
      'the connection does not allow writes; turn on Allow writes on that connection',
    );
    return;
  }
  const window = modifiedWindow(input.modifiedStart, input.modifiedEnd);
  if (!window.ok) {
    yield failed('permanent', window.error);
    return;
  }
  const inWindow = (st: Planned['st']) => window.contains(Number(st.mtimeMs));
  const counts = { filesDeleted: 0, foldersDeleted: 0 };
  let path = input.path;
  const outputs = () => ({ path, ...counts });
  const nothing = (why: string): ActivityEvent =>
    input.failIfNothingMatched
      ? failed('permanent', `nothing to delete: ${why}`)
      : { type: 'succeeded', outputs: outputs() };

  let files: Planned[] = [];
  let folders: WalkedEntry[] = [];
  // The folder every deleted entry must still be in when it is deleted.
  let base: string;
  try {
    const resolved = await resolveWithinRootsOrMissing(cfg.roots, input.path, 'fs');
    if (!resolved.ok) {
      yield failed('permanent', resolved.error);
      return;
    }
    path = resolved.path;
    const st = await lstatOrNull(path);
    if (st === null) {
      yield nothing(`'${input.path}' does not exist`);
      return;
    }
    const type = direntType(st);
    if (input.pathType === 'file') {
      if (type !== 'file') {
        yield failed('permanent', `'${input.path}' is not a file, and the path type is File`);
        return;
      }
      base = dirname(path);
      if (inWindow(st)) files = [{ abs: path, st }];
    } else {
      if (type !== 'directory') {
        yield failed('permanent', `'${input.path}' is not a folder, and the path type is Folder`);
        return;
      }
      // Canonical: `resolveWithinRoots` keeps the last name as typed, and on a
      // case-insensitive file system `out` would never contain `Out`'s files.
      // Not a link, by the `lstat` above.
      base = await realpath(path);
      const matches = wildcardMatcher(input.wildcard);
      let walked: Awaited<ReturnType<typeof walkFolder>>;
      try {
        walked = await walkFolder(path, {
          recursive: input.recursive,
          maxEntries: cfg.maxEntries ?? DEFAULT_MAX_LIST_ENTRIES,
          matches,
          signal,
          aborted: DELETE_ABORTED,
        });
      } catch (err) {
        // The folder went between its `lstat` and the walk: as if missing.
        if (isMissingErrno(err) && !signal.aborted) {
          yield nothing(`'${input.path}' does not exist`);
          return;
        }
        throw err;
      }
      if (!walked.ok) {
        yield walked.event;
        return;
      }
      // In name order, so the deletes run in the same order on every host (a
      // folder read's order is the OS's).
      files = walked.entries
        .filter((e) => e.type === 'file' && matches(e.base) && inWindow(e.st))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      if (input.deleteEmptyFolders) {
        // Deepest first, so a folder emptied by removing its own subfolder goes
        // too: a folder's name is a prefix of its contents', so a plain
        // descending sort puts every subfolder before its parent.
        folders = walked.entries
          .filter((e) => e.type === 'directory')
          .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
      }
    }
  } catch (err) {
    yield signal.aborted ? failed('cancelled', DELETE_ABORTED) : failFromError(err, signal);
    return;
  }
  if (files.length === 0 && input.failIfNothingMatched) {
    yield failed(
      'permanent',
      input.pathType === 'file'
        ? `nothing to delete: '${input.path}' was last modified outside the window`
        : `nothing to delete: no file in '${input.path}' matches`,
    );
    return;
  }

  /**
   * The entry is still the one planned (an inode keeps its type, so the same
   * device and inode is the same file or folder), a file still in the window,
   * and still inside `base`.
   */
  const stillPlanned = async (e: Planned, kind: 'file' | 'directory'): Promise<boolean> => {
    const now = await lstatOrNull(e.abs);
    if (now === null || now.dev !== e.st.dev || now.ino !== e.st.ino) return false;
    if (kind === 'file' && !inWindow(now)) return false;
    return within(base, await realpath(dirname(e.abs)));
  };

  let failure: unknown;
  try {
    // Max concurrent deletes: that many workers take the next file in turn.
    // The first error stops every worker taking another; the deletes already
    // under way finish and are counted.
    let next = 0;
    const worker = async () => {
      while (failure === undefined && !signal.aborted && next < files.length) {
        const e = files[next]!;
        next += 1;
        try {
          if (!(await stillPlanned(e, 'file'))) continue;
          await unlink(e.abs);
          counts.filesDeleted += 1;
        } catch (err) {
          // Gone since it was planned: someone else deleted it.
          if (isMissingErrno(err)) continue;
          failure ??= err;
        }
      }
    };
    const width = Math.min(input.maxConcurrentConnections, Math.max(files.length, 1));
    await Promise.all(Array.from({ length: width }, worker));
    if (failure !== undefined) throw failure;
    for (const f of folders) {
      if (signal.aborted) break;
      try {
        if (!(await stillPlanned(f, 'directory'))) continue;
        await rmdir(f.abs);
        counts.foldersDeleted += 1;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== undefined && KEPT_FOLDER.has(code)) continue;
        throw err;
      }
    }
  } catch (err) {
    for (const [name, value] of Object.entries(outputs())) yield { type: 'output', name, value };
    yield signal.aborted ? failed('cancelled', DELETE_ABORTED) : failFromError(err, signal);
    return;
  }
  if (signal.aborted) {
    for (const [name, value] of Object.entries(outputs())) yield { type: 'output', name, value };
    yield failed('cancelled', DELETE_ABORTED);
    return;
  }
  yield { type: 'succeeded', outputs: outputs() };
}
