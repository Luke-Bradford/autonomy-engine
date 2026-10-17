import type { Stats } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { z } from 'zod';
import {
  GET_METADATA_FIELD_TITLES,
  emptyGetMetadataFields,
  type GetMetadataConfig,
  type GetMetadataField,
} from '@autonomy-studio/shared';
import { failed, notYet } from './activity-events.js';
import {
  CONFINED_READ_FLAGS,
  isMissingErrno,
  resolveWithinRoots,
  resolveWithinRootsOrMissing,
} from './confine.js';
import type { fsConnectionConfigSchema } from './fs-connection.js';
import {
  DEFAULT_MAX_LIST_ENTRIES,
  direntType,
  modifiedWindow,
  wildcardMatcher,
} from './fs-select.js';
import { DatasetIoError } from './dataset-io-error.js';
import { walkFolder } from './fs-walk.js';
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

const emptyFields = (): FieldValues => emptyGetMetadataFields();

/** C8d — whether a folder holds at least one entry, reading only the first. */
async function hasEntry(path: string): Promise<boolean> {
  const dir = await opendir(path);
  try {
    return (await dir.read()) !== null;
  } finally {
    await dir.close().catch(() => undefined);
  }
}

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
  try {
    const walked = await walkFolder(folder, {
      recursive: input.recursive,
      maxEntries,
      matches,
      signal,
      aborted: 'file activity aborted',
    });
    if (!walked.ok) return walked.event;
    for (const { name, base, type, st } of walked.entries) {
      if (!matches(base)) continue;
      if (input.childType === 'files' && type !== 'file') continue;
      if (input.childType === 'folders' && type !== 'directory') continue;
      // ADF: with a modified window set, child items hold files only. A
      // `bigint` mtime is whole milliseconds, and the window's bounds are too.
      if (timed && (type !== 'file' || !window.contains(Number(st.mtimeMs)))) continue;
      items.push({
        name,
        type,
        size: type === 'file' ? Number(st.size) : null,
        // Rounded to the millisecond as a number `lstat`'s `mtime` is, where a
        // `bigint` one truncates.
        lastModified: new Date(Math.round(Number(st.mtimeNs) / 1e6)).toISOString(),
      });
    }
  } catch (err) {
    return failFromError(err, signal);
  }
  return items.sort(byTreeOrder);
}

const isEvent = (v: unknown): v is ActivityEvent =>
  typeof v === 'object' && v !== null && 'type' in v && !Array.isArray(v);

/**
 * #1600 OR41 C8c-2 — a delimited or Excel dataset's columns, each `{name, type}`,
 * read by the dataset's own reader (`fs.ts`), for Structure and Column count.
 */
export type FileColumnsReader = () => Promise<
  readonly { readonly name: string; readonly type: string }[]
>;

/**
 * C8d — the Wait until condition on a path that exists: `null` when it holds,
 * else `notReady`, or a permanent failure for a condition the item can never
 * meet (a size on a folder). Before any field is read, so nothing slow runs on
 * a check that will be repeated.
 */
async function waitUntilUnmet(
  input: GetMetadataConfig & { readonly path: string },
  path: string,
  st: Stats,
  type: string,
): Promise<ActivityEvent | null> {
  switch (input.waitUntil) {
    case 'exists':
    case 'off':
      return null;
    case 'nonEmpty':
      if (type === 'file') return st.size > 0 ? null : notYet(input, `'${input.path}' is empty`);
      if (type === 'directory') {
        return (await hasEntry(path)) ? null : notYet(input, `'${input.path}' is an empty folder`);
      }
      return failed(
        'permanent',
        `It is not empty needs a file or folder, and '${input.path}' is a ${type}`,
      );
    case 'minimumSize': {
      if (type !== 'file') {
        return failed(
          'permanent',
          `It is at least N bytes needs a file, and '${input.path}' is a ${type}`,
        );
      }
      // The config refuses this choice without a size; 1 only satisfies the type.
      const min = input.minimumSize ?? 1;
      return st.size >= min
        ? null
        : notYet(input, `'${input.path}' is ${st.size} bytes, waiting for ${min}`);
    }
  }
}

export async function doGetMetadata(
  cfg: FsConfig,
  // C8c — the dispatch arm has refused a missing path (`getMetadataKindIssue`).
  // C8c-2 — on a file dataset it is the dataset's own path.
  input: GetMetadataConfig & { readonly path: string },
  signal: AbortSignal,
  // C8c-2 — given only for a file dataset, the one source of a file's columns.
  readColumns?: FileColumnsReader,
): Promise<ActivityEvent> {
  const ticked = new Set<GetMetadataField>(input.fieldList);
  // C8d — while waiting, a missing path is "not yet", whatever Exists says.
  const waiting = input.waitUntil !== 'off';
  const missing = `'${input.path}' does not exist yet`;
  const answersMissing = ticked.has('exists') || waiting;
  const readsColumns = ticked.has('structure') || ticked.has('columnCount');

  let resolved: Awaited<ReturnType<typeof resolveWithinRootsOrMissing>>;
  try {
    // A missing folder is a missing path only where that has an answer, which
    // the `lstat` below then gives; the fallback never answers for a path
    // outside the roots (it rethrows).
    resolved = await (answersMissing ? resolveWithinRootsOrMissing : resolveWithinRoots)(
      cfg.roots,
      input.path,
      'fs',
    );
  } catch (err) {
    return failFromError(err, signal);
  }
  if (!resolved.ok) return failed('permanent', resolved.error);
  const path = resolved.path;

  let st: Stats;
  try {
    st = await lstat(path);
  } catch (err) {
    if (answersMissing && isMissingErrno(err))
      return waiting ? notYet(input, missing) : notThere(path);
    return failFromError(err, signal);
  }

  const type = direntType(st);
  if (waiting) {
    let unmet: ActivityEvent | null;
    try {
      unmet = await waitUntilUnmet(input, path, st, type);
    } catch (err) {
      // A folder removed between the stat and the read is not there yet.
      return isMissingErrno(err) ? notYet(input, missing) : failFromError(err, signal);
    }
    if (unmet !== null) return unmet;
  }
  // Child items read a folder only. Checked before anything slow (Content MD5).
  if (ticked.has('childItems') && type !== 'directory') {
    return failed('permanent', `Child items needs a folder, and '${input.path}' is a ${type}`);
  }
  // C8c-2 — and a file's columns a file only, before its reader is handed a
  // folder to open.
  if (readsColumns && type !== 'file') {
    const named = input.fieldList
      .filter((f) => f === 'structure' || f === 'columnCount')
      .map((f) => GET_METADATA_FIELD_TITLES[f]);
    const verb = named.length === 1 ? 'needs' : 'need';
    return failed(
      'permanent',
      `${named.join(' and ')} ${verb} a file, and '${input.path}' is a ${type}`,
    );
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
  if (readsColumns) {
    // `getMetadataKindIssue` has refused a file's columns on a bare path; never
    // end silently.
    if (readColumns === undefined) {
      return failed(
        'permanent',
        'Structure, Column count read a delimited or Excel dataset chosen on Source, not a path',
      );
    }
    let columns: Awaited<ReturnType<FileColumnsReader>>;
    try {
      columns = await readColumns();
    } catch (err) {
      // The reader's own verdict passes through, as the table's does.
      return err instanceof DatasetIoError
        ? failed(err.kind, err.message)
        : failFromError(err, signal);
    }
    if (ticked.has('structure')) {
      fields.structure = columns.map(({ name, type }) => ({ name, type }));
    }
    if (ticked.has('columnCount')) fields.columnCount = columns.length;
  }
  return { type: 'succeeded', outputs: { path, ...fields } };
}
