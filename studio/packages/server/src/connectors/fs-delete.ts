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
 *
 * C9c — the session log (`SessionLog`, catalogue §4.4, §5). Each file and
 * folder deleted is an Info line; each skipped or kept, a Warning (a folder
 * kept because it still holds files is Info); the failure, an Error. The log
 * folder is checked before anything is planned, and refused before anything is
 * deleted when this Delete could remove it or its file. From then on every
 * terminal keeps the log: the lines go to the run log ahead of the terminal, or
 * the CSV file is written and its path is `logPath`. The lines are held in
 * memory until then, bounded by the connection's entry limit; a server that
 * dies mid-delete loses them (ADF's Reliable mode is not built).
 */
import { constants as fsConstants } from 'node:fs';
import { access, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { z } from 'zod';
import { SessionLog, type DeleteConfig } from '@autonomy-studio/shared';
import { failed, REMOVED_BY_SOMEONE_ELSE, sessionLogRunEvents } from './activity-events.js';
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
import { runPool } from './run-pool.js';
import { sessionLogFileName, writeSessionLogFile } from './session-log-file.js';
import type { ActivityEvent } from './types.js';

type FsConfig = z.infer<typeof fsConnectionConfigSchema>;

export const DELETE_ABORTED = 'file delete aborted';

/**
 * The planned entry a delete acts on: its path, the identity it was seen with,
 * and its name relative to the path, which the session log names it by.
 */
type Planned = Pick<WalkedEntry, 'name' | 'abs' | 'st'>;

/**
 * `rmdir` answers that leave a folder in place without failing the node: not
 * empty, gone, no longer a folder, or a mount point (`EBUSY`, which no retry
 * would change). Each with its session log message.
 */
const KEPT_FOLDER: Readonly<Record<string, string>> = {
  ENOTEMPTY: 'kept: not empty',
  EEXIST: 'kept: not empty',
  ENOENT: `skipped: ${REMOVED_BY_SOMEONE_ELSE}`,
  ENOTDIR: 'skipped: no longer a folder',
  EBUSY: 'kept: a mount point',
};

/** Ascending by the entry's name relative to the path, the same on every host. */
const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * @param tmpSuffix `makeTmpSuffix`'s per-attempt suffix, which names the
 *   session log file.
 */
export async function* runDelete(
  cfg: FsConfig,
  input: DeleteConfig,
  signal: AbortSignal,
  tmpSuffix: string,
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
  let logPath: string | null = null;
  const outputs = () => ({ path, ...counts, logPath });
  const nothing = (why: string): ActivityEvent =>
    input.failIfNothingMatched
      ? failed('permanent', `nothing to delete: ${why}`)
      : { type: 'succeeded', outputs: outputs() };

  const log = new SessionLog(input.logLevel);
  // The log folder, canonical, when the log is written to one. Checked before
  // anything is planned, so a bad one fails the node with every file there.
  let logDir: string | undefined;
  if (input.logLevel !== 'off' && input.logTo === 'folder') {
    const folder = input.logFolder ?? '';
    try {
      const resolved = await resolveWithinRootsOrMissing(cfg.roots, folder, 'fs');
      if (!resolved.ok) {
        yield failed('permanent', `the log folder: ${resolved.error}`);
        return;
      }
      const st = await lstatOrNull(resolved.path);
      if (st === null || direntType(st) !== 'directory') {
        yield failed(
          'permanent',
          `the log folder '${folder}' ${st === null ? 'does not exist' : 'is not a folder'}`,
        );
        return;
      }
      // Written to only after the deletes, so a folder it cannot write to is
      // refused now, with every file still there.
      try {
        await access(resolved.path, fsConstants.W_OK);
      } catch {
        yield failed('permanent', `the log folder '${folder}' is not writable`);
        return;
      }
      logDir = await realpath(resolved.path);
    } catch (err) {
      yield signal.aborted ? failed('cancelled', DELETE_ABORTED) : failFromError(err, signal);
      return;
    }
  }
  // The item the delete failed on, for the log's Error line.
  let failedItem = '';
  let failedOperation = 'FileDelete';
  // Its own error, which a cancel that follows it would otherwise replace.
  let failedMessage = '';
  // Whether a failure reports the outputs so far: once deleting has begun.
  let reportOutputs = false;

  /**
   * The attempt's last events: the run log's lines, or the folder log written,
   * and then `terminal`. A failure reports the outputs so far first, as
   * before C9c; a success is rebuilt so it carries `logPath`. A log that cannot
   * be written fails a success; a failure keeps its own error.
   */
  async function* finish(terminal: ActivityEvent): AsyncGenerator<ActivityEvent> {
    // An Error line for the item a delete failed on. A failure before any
    // item (a refusal, the entry limit) is the node's error alone.
    if (terminal.type === 'failed' && failedItem !== '') {
      log.add('Error', failedOperation, failedItem, failedMessage);
    }
    if (logDir !== undefined) {
      const written = await writeSessionLogFile(
        logDir,
        sessionLogFileName(tmpSuffix),
        tmpSuffix,
        log.lines,
      );
      if (written.ok) logPath = written.path;
      else if (terminal.type === 'succeeded') {
        const deleted = `deleted ${counts.filesDeleted} file(s) and ${counts.foldersDeleted} folder(s)`;
        terminal = failed(
          'permanent',
          `${deleted}, but the session log could not be written: ${written.error}`,
        );
      }
    } else {
      yield* sessionLogRunEvents(log);
    }
    if (terminal.type === 'succeeded') {
      yield { type: 'succeeded', outputs: outputs() };
      return;
    }
    if (terminal.type === 'failed' && reportOutputs) {
      for (const [name, value] of Object.entries(outputs())) yield { type: 'output', name, value };
    }
    yield terminal;
  }

  let files: Planned[] = [];
  let folders: WalkedEntry[] = [];
  // The folder every deleted entry must still be in when it is deleted.
  let base: string;
  try {
    const resolved = await resolveWithinRootsOrMissing(cfg.roots, input.path, 'fs');
    if (!resolved.ok) {
      yield* finish(failed('permanent', resolved.error));
      return;
    }
    path = resolved.path;
    const st = await lstatOrNull(path);
    if (st === null) {
      yield* finish(nothing(`'${input.path}' does not exist`));
      return;
    }
    const type = direntType(st);
    if (input.pathType === 'file') {
      if (type !== 'file') {
        yield* finish(
          failed('permanent', `'${input.path}' is not a file, and the path type is File`),
        );
        return;
      }
      base = dirname(path);
      if (inWindow(st)) files = [{ name: basename(path), abs: path, st }];
    } else {
      if (type !== 'directory') {
        yield* finish(
          failed('permanent', `'${input.path}' is not a folder, and the path type is Folder`),
        );
        return;
      }
      // Canonical: `resolveWithinRoots` keeps the last name as typed, and on a
      // case-insensitive file system `out` would never contain `Out`'s files.
      // Not a link, by the `lstat` above.
      base = await realpath(path);
      // Refused before the walk, and without writing the log: this Delete
      // could remove the log folder (Delete empty folders) or a later run's log
      // file (its wildcard), so the log would not survive.
      if (logDir !== undefined && (logDir === base || (input.recursive && within(base, logDir)))) {
        const where = logDir === base ? 'the folder' : 'inside the folder';
        yield failed(
          'permanent',
          `the log folder is ${where} this Delete deletes from; pick one outside it`,
        );
        return;
      }
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
          yield* finish(nothing(`'${input.path}' does not exist`));
          return;
        }
        throw err;
      }
      if (!walked.ok) {
        yield* finish(walked.event);
        return;
      }
      // In name order, so the deletes run in the same order on every host (a
      // folder read's order is the OS's).
      files = walked.entries
        .filter((e) => e.type === 'file' && matches(e.base) && inWindow(e.st))
        .sort(byName);
      // A link, or an entry of another type, is left in place: say so, in
      // name order too, so the log reads the same on every host.
      for (const e of walked.entries
        .filter(
          (e) => e.type !== 'file' && e.type !== 'directory' && matches(e.base) && inWindow(e.st),
        )
        .sort(byName)) {
        log.add('Warning', 'FileSkip', e.name, 'skipped: not a regular file, so left in place');
      }
      if (input.deleteEmptyFolders) {
        // Deepest first, so a folder emptied by removing its own subfolder goes
        // too: a folder's name is a prefix of its contents', so a plain
        // descending sort puts every subfolder before its parent.
        folders = walked.entries.filter((e) => e.type === 'directory').sort((a, b) => byName(b, a));
      }
    }
  } catch (err) {
    yield* finish(
      signal.aborted ? failed('cancelled', DELETE_ABORTED) : failFromError(err, signal),
    );
    return;
  }
  if (files.length === 0 && input.failIfNothingMatched) {
    yield* finish(
      failed(
        'permanent',
        input.pathType === 'file'
          ? `nothing to delete: '${input.path}' was last modified outside the window`
          : `nothing to delete: no file in '${input.path}' matches`,
      ),
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

  reportOutputs = true;
  try {
    // Max concurrent deletes: that many workers take the next file in turn
    // (`runPool`, #1782). The first error stops every worker taking another;
    // the deletes already under way finish and are counted. An abort stops
    // the taking and is reported below, after the pool.
    const deleteFile = async (e: Planned): Promise<void> => {
      try {
        if (!(await stillPlanned(e, 'file'))) {
          log.add('Warning', 'FileSkip', e.name, 'skipped: no longer the file chosen');
          return;
        }
        await unlink(e.abs);
        counts.filesDeleted += 1;
        log.add('Info', 'FileDelete', e.name, 'deleted');
      } catch (err) {
        // Gone since it was planned: someone else deleted it.
        if (isMissingErrno(err)) {
          log.add('Warning', 'FileSkip', e.name, `skipped: ${REMOVED_BY_SOMEONE_ELSE}`);
          return;
        }
        throw err;
      }
    };
    const width = Math.min(input.maxConcurrentConnections, Math.max(files.length, 1));
    const failure = await runPool(files, width, deleteFile, () => signal.aborted);
    if (failure !== undefined) {
      failedItem = failure.item.name;
      failedMessage = errorText(failure.err);
      throw failure.err;
    }
    for (const f of folders) {
      if (signal.aborted) break;
      try {
        if (!(await stillPlanned(f, 'directory'))) {
          log.add('Warning', 'FolderSkip', f.name, 'skipped: no longer the folder chosen');
          continue;
        }
        await rmdir(f.abs);
        counts.foldersDeleted += 1;
        log.add('Info', 'FolderDelete', f.name, 'deleted');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== undefined && Object.hasOwn(KEPT_FOLDER, code)) {
          // Holding files is the usual reason, so only Everything logs it.
          const notEmpty = code === 'ENOTEMPTY' || code === 'EEXIST';
          log.add(notEmpty ? 'Info' : 'Warning', 'FolderSkip', f.name, KEPT_FOLDER[code]!);
          continue;
        }
        failedItem = f.name;
        failedOperation = 'FolderDelete';
        failedMessage = errorText(err);
        throw err;
      }
    }
  } catch (err) {
    yield* finish(
      signal.aborted ? failed('cancelled', DELETE_ABORTED) : failFromError(err, signal),
    );
    return;
  }
  if (signal.aborted) {
    yield* finish(failed('cancelled', DELETE_ABORTED));
    return;
  }
  yield* finish({ type: 'succeeded', outputs: outputs() });
}
