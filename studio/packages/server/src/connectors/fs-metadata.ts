import type { Stats } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import type { z } from 'zod';
import type { GetMetadataConfig, GetMetadataField } from '@autonomy-studio/shared';
import { failed } from './activity-events.js';
import { CONFINED_READ_FLAGS, missingWithinRoots, resolveWithinRoots } from './confine.js';
import type { fsConnectionConfigSchema } from './fs-connection.js';
import {
  DEFAULT_MAX_LIST_ENTRIES,
  direntType,
  modifiedWindow,
  wildcardMatcher,
} from './fs-select.js';
import { closeQuietly, failFromError } from './fs-write.js';
import type { ActivityEvent } from './types.js';

/**
 * #1600 OR41 C8a — Get metadata on a file system connection (catalogue §4.3).
 *
 * Every field the node does not tick is output as `null`; the catalog declares
 * them all optional, so the output contract does not depend on the ticks.
 *
 * Deliberate differences from ADF, recorded in the catalogue spec:
 * - `itemType` and a child item's `type` are `file_list`'s words (`file`,
 *   `directory`, `symlink`, `other`), not ADF's `File`/`Folder`, so C8b's
 *   lowering of `file_list` keeps a `type == 'directory'` test working.
 * - Content MD5 is a studio addition (ADF has none for a file system). It is
 *   base64, the Content-MD5 form, and reads the whole file with no size cap,
 *   checking for cancel between chunks.
 * - Child items are sorted by name (code-unit order, not the host's locale),
 *   where a directory read's order depends on the OS; with Include subfolders,
 *   by path in tree order. Each carries its size and last-modified time.
 * - Include subfolders (C8e) is a studio addition: ADF's Child items lists one
 *   level. Each item is then named by its `/`-separated path below the folder.
 *   The walk is Copy · Files as-is's shape (`fs-files-copy.ts`), typed by
 *   `lstat` and in tree order where Copy types by dirent and sorts plainly.
 * - Child items on a file FAIL rather than come back null, so a lowered
 *   `file_list` on a file still fails as it did. Size and Content MD5 on a
 *   folder are null.
 * - A symlink at the path is refused even with Exists ticked: the connector
 *   never follows one, so it cannot say whether its target exists.
 */

type FsConfig = z.infer<typeof fsConnectionConfigSchema>;
type FieldValues = Record<GetMetadataField, unknown>;

const MD5_CHUNK_BYTES = 1 << 16;

function emptyFields(): FieldValues {
  return {
    exists: null,
    itemName: null,
    itemType: null,
    size: null,
    created: null,
    lastModified: null,
    contentMD5: null,
    childItems: null,
    structure: null,
    columnCount: null,
    rowCount: null,
  };
}

const isMissing = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/** What Exists ticked answers for a missing path. */
function notThere(path: string): ActivityEvent {
  return { type: 'succeeded', outputs: { path, ...emptyFields(), exists: false } };
}

/** `birthtime` where the file system records one; `0` means it does not. */
function createdOf(st: Stats): string | null {
  return st.birthtimeMs > 0 ? st.birthtime.toISOString() : null;
}

async function md5Of(path: string, signal: AbortSignal): Promise<string | ActivityEvent> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(path, CONFINED_READ_FLAGS);
    const hash = createHash('md5');
    const buffer = Buffer.allocUnsafe(MD5_CHUNK_BYTES);
    for (;;) {
      if (signal.aborted) return failed('cancelled', 'file activity aborted');
      const { bytesRead } = await fh.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('base64');
  } catch (err) {
    return failFromError(err, signal);
  } finally {
    await closeQuietly(fh);
  }
}

interface ChildItem {
  name: string;
  type: ReturnType<typeof direntType>;
  size: number | null;
  lastModified: string;
}

/**
 * Tree order: compare with `/` as the lowest code unit, so a folder's contents
 * follow it (`a`, `a/x`, `a-b`) where a plain code-unit sort would put `a-b`
 * between them. NUL can never be in a file name, so it is a safe stand-in.
 */
const treeKey = (name: string): string => name.replaceAll('/', '\0');
const byTreeOrder = (a: ChildItem, b: ChildItem): number => {
  const ka = treeKey(a.name);
  const kb = treeKey(b.name);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

async function childItemsOf(
  cfg: FsConfig,
  folder: string,
  input: GetMetadataConfig,
  signal: AbortSignal,
): Promise<ChildItem[] | ActivityEvent> {
  const window = modifiedWindow(input.modifiedStart, input.modifiedEnd);
  if (!window.ok) return failed('permanent', window.error);
  const timed = input.modifiedStart !== undefined || input.modifiedEnd !== undefined;
  const matches = wildcardMatcher(input.childFilter);
  // Counted on every entry VISITED, as `file_list` counts, so a huge folder
  // with no matches is still bounded. With Include subfolders (C8e) the count
  // runs across the whole tree, as Copy · Files as-is's walk does.
  const maxEntries = cfg.maxEntries ?? DEFAULT_MAX_LIST_ENTRIES;
  const items: ChildItem[] = [];
  let visited = 0;
  // Relative names, `/`-separated on every host so the output is the same
  // everywhere; the paths opened are built with the host's `join`.
  const pending: string[] = [''];
  try {
    while (pending.length > 0) {
      const rel = pending.pop()!;
      const at = rel === '' ? folder : join(folder, ...rel.split('/'));
      let dir: Awaited<ReturnType<typeof opendir>>;
      try {
        // `opendir` has no `O_NOFOLLOW`. The top folder was confined and
        // `lstat`ed just before this; a subfolder is `lstat`ed again here, so
        // one swapped for a link while it waited on the stack is skipped. The
        // residual is the gap between this `lstat` and the `opendir`, as in
        // `file_list` and Copy's walk; a swap there would expose names, sizes
        // and times, not contents.
        if (rel !== '' && !(await lstat(at)).isDirectory()) continue;
        dir = await opendir(at);
      } catch (err) {
        // A subfolder removed since it was listed is skipped. The top folder
        // is not a child item, so its errors are the activity's.
        if (rel !== '' && isMissing(err)) continue;
        throw err;
      }
      try {
        for (;;) {
          if (signal.aborted) return failed('cancelled', 'file activity aborted');
          const dirent = await dir.read();
          if (dirent === null) break;
          visited += 1;
          if (visited > maxEntries) {
            return failed(
              'permanent',
              input.recursive
                ? `the folder and its subfolders have more than the ${maxEntries}-entry list limit`
                : `folder has more than the ${maxEntries}-entry list limit`,
            );
          }
          const name = rel === '' ? dirent.name : `${rel}/${dirent.name}`;
          const matched = matches(dirent.name);
          // With Include subfolders every entry is `lstat`ed, one call each,
          // because a folder is walked whether or not it is listed; without it
          // only a match is. The `lstat` rather than the dirent's type, as below.
          if (!input.recursive && !matched) continue;
          let st: Stats;
          try {
            st = await lstat(join(dir.path, dirent.name));
          } catch (err) {
            if (isMissing(err)) continue; // removed since it was listed
            throw err;
          }
          // Typed from the `lstat`, not the dirent: a file system that does not
          // report a dirent's type would otherwise list everything as `other`.
          const type = direntType(st);
          // A link is never followed, to a folder or anywhere else.
          if (input.recursive && type === 'directory') pending.push(name);
          if (!matched) continue;
          if (input.childType === 'files' && type !== 'file') continue;
          if (input.childType === 'folders' && type !== 'directory') continue;
          // ADF: with a modified window set, child items hold files only.
          if (timed && (type !== 'file' || !window.contains(st.mtimeMs))) continue;
          items.push({
            name,
            type,
            size: type === 'file' ? st.size : null,
            lastModified: st.mtime.toISOString(),
          });
        }
      } finally {
        try {
          await dir.close();
        } catch {
          // Already closed by a finished iteration.
        }
      }
    }
  } catch (err) {
    return failFromError(err, signal);
  }
  return items.sort(byTreeOrder);
}

const isEvent = (v: unknown): v is ActivityEvent =>
  typeof v === 'object' && v !== null && 'type' in v && !Array.isArray(v);

export async function doGetMetadata(
  cfg: FsConfig,
  // C8c — the dispatch arm has refused a missing path (`getMetadataKindIssue`).
  input: GetMetadataConfig & { readonly path: string },
  signal: AbortSignal,
): Promise<ActivityEvent> {
  const ticked = new Set<GetMetadataField>(input.fieldList);
  const answersMissing = ticked.has('exists');

  let resolved: Awaited<ReturnType<typeof resolveWithinRoots>>;
  try {
    resolved = await resolveWithinRoots(cfg.roots, input.path, 'fs');
  } catch (err) {
    if (answersMissing && isMissing(err)) {
      try {
        const where = await missingWithinRoots(cfg.roots, input.path);
        if (where !== null) return notThere(where);
      } catch {
        // Report the original error below.
      }
    }
    return failFromError(err, signal);
  }
  if (!resolved.ok) return failed('permanent', resolved.error);
  const path = resolved.path;

  let st: Stats;
  try {
    st = await lstat(path);
  } catch (err) {
    if (answersMissing && isMissing(err)) return notThere(path);
    return failFromError(err, signal);
  }

  const type = direntType(st);
  // Child items read a folder only. Checked before anything slow (Content MD5).
  if (ticked.has('childItems') && type !== 'directory') {
    return failed('permanent', `Child items needs a folder, and '${input.path}' is a ${type}`);
  }
  const fields = emptyFields();
  try {
    if (ticked.has('exists')) fields.exists = true;
    if (ticked.has('itemName')) fields.itemName = basename(path);
    if (ticked.has('itemType')) fields.itemType = type;
    if (ticked.has('size') && type === 'file') fields.size = st.size;
    if (ticked.has('created')) fields.created = createdOf(st);
    // `toISOString` throws on a time outside JavaScript's range; caught below.
    if (ticked.has('lastModified')) fields.lastModified = st.mtime.toISOString();
  } catch (err) {
    return failFromError(err, signal);
  }
  if (ticked.has('contentMD5') && type === 'file') {
    const md5 = await md5Of(path, signal);
    if (isEvent(md5)) return md5;
    fields.contentMD5 = md5;
  }
  if (ticked.has('childItems')) {
    const items = await childItemsOf(cfg, path, input, signal);
    if (isEvent(items)) return items;
    fields.childItems = items;
  }
  return { type: 'succeeded', outputs: { path, ...fields } };
}
