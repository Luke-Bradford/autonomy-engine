/**
 * #1600 OR41 C9a — the folder walk Get metadata's Child items (C8a, C8e) and
 * Delete (C9a) share, lifted out of `fs-metadata.ts` so Delete does not write a
 * third (Copy · Files as-is keeps its own, dirent-typed walk: #1691).
 *
 * Every entry is typed by an `lstat`, never by its dirent, and a link is never
 * followed. The entry cap counts every entry VISITED, matched or not, so a huge
 * folder with no matches is still bounded.
 */
import type { BigIntStats } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { failed } from './activity-events.js';
import { isMissingErrno } from './confine.js';
import { direntType } from './fs-select.js';
import type { ActivityEvent } from './types.js';

export interface WalkedEntry {
  /** Relative to the folder walked, `/`-separated on every host. */
  readonly name: string;
  /** The entry's own name, which a wildcard is matched against. */
  readonly base: string;
  /** The host path of the entry. */
  readonly abs: string;
  readonly type: ReturnType<typeof direntType>;
  /** `bigint`, so a device or inode number is compared exactly (`lstatOrNull`). */
  readonly st: BigIntStats;
}

export interface WalkOptions {
  readonly recursive: boolean;
  readonly maxEntries: number;
  /**
   * Without `recursive` only an entry whose name matches is `lstat`ed and
   * returned; with it every entry is, because a folder is walked whether or
   * not it matches. The caller still filters by the match.
   */
  readonly matches: (base: string) => boolean;
  readonly signal: AbortSignal;
  /** The failure message when the walk sees the abort. */
  readonly aborted: string;
}

/**
 * Walk `folder`, which the caller has confined and `lstat`ed as a folder. A
 * subfolder or entry removed while the walk runs is skipped. The cap and the
 * abort are failure events; any other error is thrown, the top folder's
 * included, for the caller to classify.
 */
export async function walkFolder(
  folder: string,
  opts: WalkOptions,
): Promise<{ ok: true; entries: WalkedEntry[] } | { ok: false; event: ActivityEvent }> {
  const entries: WalkedEntry[] = [];
  let visited = 0;
  const pending: string[] = [''];
  while (pending.length > 0) {
    const rel = pending.pop()!;
    const at = rel === '' ? folder : join(folder, ...rel.split('/'));
    let dir: Awaited<ReturnType<typeof opendir>>;
    try {
      // `opendir` has no `O_NOFOLLOW`. The top folder was confined and
      // `lstat`ed just before this; a subfolder is `lstat`ed again here, so
      // one swapped for a link while it waited on the stack is skipped. The
      // residual is the gap between this `lstat` and the `opendir`, as in
      // `file_list` and Copy's walk. A destructive caller re-checks each
      // entry's containment before acting on it (Delete, `fs-delete.ts`).
      if (rel !== '' && !(await lstat(at)).isDirectory()) continue;
      dir = await opendir(at);
    } catch (err) {
      // A subfolder removed since it was listed is skipped. The top folder's
      // errors are the caller's.
      if (rel !== '' && isMissingErrno(err)) continue;
      throw err;
    }
    try {
      for (;;) {
        if (opts.signal.aborted) return { ok: false, event: failed('cancelled', opts.aborted) };
        const dirent = await dir.read();
        if (dirent === null) break;
        visited += 1;
        if (visited > opts.maxEntries) {
          return {
            ok: false,
            event: failed(
              'permanent',
              opts.recursive
                ? `the folder and its subfolders have more than the ${opts.maxEntries}-entry list limit`
                : `folder has more than the ${opts.maxEntries}-entry list limit`,
            ),
          };
        }
        const name = rel === '' ? dirent.name : `${rel}/${dirent.name}`;
        if (!opts.recursive && !opts.matches(dirent.name)) continue;
        const abs = join(dir.path, dirent.name);
        let st: BigIntStats;
        try {
          st = await lstat(abs, { bigint: true });
        } catch (err) {
          if (isMissingErrno(err)) continue; // removed since it was listed
          throw err;
        }
        // Typed from the `lstat`, not the dirent: a file system that does not
        // report a dirent's type would otherwise list everything as `other`.
        const type = direntType(st);
        // A link is never followed, to a folder or anywhere else.
        if (opts.recursive && type === 'directory') pending.push(name);
        entries.push({ name, base: dirent.name, abs, type, st });
      }
    } finally {
      try {
        await dir.close();
      } catch {
        // Already closed by a finished iteration.
      }
    }
  }
  return { ok: true, entries };
}
