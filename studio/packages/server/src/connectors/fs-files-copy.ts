import { constants as fsConstants, type BigIntStats, type Dir } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { z } from 'zod';
import {
  copyFilesConfigSchema,
  copyMeasure,
  counted,
  formatZodIssues,
  SESSION_LOG_RUN_MAX_LINES,
  SessionLog,
  type CopyConsistencyResult,
  type CopyFilesConfig,
  type CopyMeasure,
} from '@autonomy-studio/shared';
import { failed, REMOVED_BY_SOMEONE_ELSE, sessionLogRunEvents } from './activity-events.js';
import { O_NOFOLLOW, isMissingErrno, resolveWithinRoots } from './confine.js';
import { fsConnectionConfigSchema } from './fs-connection.js';
import {
  DEFAULT_MAX_LIST_ENTRIES,
  DEFAULT_MAX_READ_BYTES,
  escapes,
  lstatOrNull,
  modifiedWindow,
  wildcardMatcher,
  within,
} from './fs-select.js';
import {
  LINK_UNSUPPORTED,
  TARGET_EXISTS,
  atomicReplace,
  closeQuietly,
  failFromError,
  makeTmpSuffix,
  streamInto,
} from './fs-write.js';
import { runPool } from './run-pool.js';
import { storeWatermark } from './copy-watermark-store.js';
import {
  checkLogConnectionFolder,
  sessionLogFileName,
  sessionLogIncomplete,
  SessionLogWriter,
  sessionLogWriterOptions,
  writableFs,
} from './session-log-file.js';
import type { ActivityContext, ActivityEvent } from './types.js';
import { FS_STREAM_CHUNK_BYTES } from '../limits.js';

/**
 * #1600 OR41 C5b — how far behind the clock Load Incremental's cutoff is taken.
 * A file's times come from its file system's clock, which can trail the
 * server's: FAT and exFAT store modified times rounded to 2 seconds, and a
 * kernel's file timestamps can lag its clock by a tick. A file written just
 * after the listing could otherwise carry a time below the cutoff and never be
 * copied. A file changed within the margin is copied by the next run.
 */
export const COPY_FILES_SETTLE_MS = 2000;

/**
 * #1600 OR41 C5b — the window Load Incremental selects: files whose later of
 * modified and status-change time is in [old, cutoff). The status-change time
 * is read because a rename or a move into the folder keeps the modified time:
 * a file written as `x.tmp` and renamed `x.csv`, or moved in from elsewhere,
 * would otherwise sit below the last cutoff for good. It may copy a file again
 * whose permissions or links changed; it never misses one. Successive runs'
 * windows meet with no gap and no overlap, and the cutoff is taken before the
 * listing, so a file written while it runs falls in the next window.
 */
interface IncrementalWindow {
  readonly old: string | null;
  /** The stored time after this run: the cutoff, or `old` if that is later. */
  readonly next: string | null;
  readonly contains: (st: BigIntStats) => boolean;
}

/** A file's time in milliseconds, from a `bigint` stat's nanoseconds. */
const msOf = (ns: bigint): number => Number(ns) / 1e6;

function incrementalWindow(
  stored: unknown,
): { ok: true; window: IncrementalWindow } | { ok: false; error: string } {
  const oldMs = typeof stored === 'string' ? Date.parse(stored) : Number.NaN;
  if (stored !== null && !Number.isFinite(oldMs)) {
    return {
      ok: false,
      error: `the stored watermark ${JSON.stringify(stored)} is not a time; Load Incremental cannot tell which files are new`,
    };
  }
  const old = stored as string | null;
  const cutoffMs = Date.now() - COPY_FILES_SETTLE_MS;
  // A clock set back since the last run: nothing is new, and the stored time stays.
  if (old !== null && oldMs >= cutoffMs) {
    return { ok: true, window: { old, next: old, contains: () => false } };
  }
  // Modified between's own window, read against the later of the two times.
  const next = new Date(cutoffMs).toISOString();
  const between = modifiedWindow(old ?? undefined, next);
  if (!between.ok) return between;
  return {
    ok: true,
    window: {
      old,
      next,
      contains: (st) => between.contains(Math.max(msOf(st.mtimeNs), msOf(st.ctimeNs))),
    },
  };
}

/**
 * #1600 OR41 C1a — Copy · Files as-is (activity catalogue §4.1): copy files
 * byte for byte from the SOURCE `fs` connection (the one this adapter runs on)
 * to the SINK `fs` connection (`ctx.sink`).
 *
 * PLAN FIRST, WRITE SECOND. Every file is selected and every target worked out
 * before the first byte is written, so each refusal below is made with nothing
 * written, deleted or moved:
 *  - two sources would land on one target (Flatten, or names that differ only
 *    in case: refused on every sink, because a case-insensitive disk would make
 *    them one file and nothing here can tell which kind of disk a sink is);
 *  - a file or symlink stands where a sink or *Move to* folder must be made,
 *    or a target is itself a folder (#1685);
 *  - a target IS a source, by device and inode, so a hardlink or a case-only
 *    difference cannot hide it. Overwriting a source, or deleting one after
 *    "copying" it onto itself, destroys the only copy;
 *  - *If file exists* is Fail and a target exists;
 *  - a *Move to* target already exists (a move never replaces a file),
 *    unless it is the source itself, linked there by an attempt that failed
 *    before removing the original: that move is finished, not refused.
 * A folder made or replaced by someone else after the plan is still caught as
 * each folder is created, and fails the copy there.
 *
 * CONFINEMENT. Every path resolves inside its own connection's roots through
 * `resolveWithinRoots`, symlinks are never followed (a walk skips them, a
 * named path that is one is refused), a file-list line may not leave the
 * source path, and directories are created one segment at a time, each
 * checked to be a real directory, so a symlink planted in the sink cannot
 * redirect a write outside it.
 *
 * A SOURCE IS ONLY REMOVED UNCHANGED. Before After copy deletes or moves a
 * file, it must still be the same file, with the size and modified time it had
 * when it was read, and every byte of it must have been copied; otherwise the
 * copy fails and the file stays, so a write that lands mid-copy is never lost.
 * Each copy keeps its source's permission bits (a merge, the bits all share).
 *
 * A RETRY CONVERGES UNDER SKIP. With *If file exists* = Skip, a target that
 * already holds exactly its source's bytes is reported skipped, and After copy
 * still removes the source: an attempt that failed between writing a copy and
 * removing its source is finished by the next one. A target with other bytes,
 * or that is not a regular file, is skipped and its source kept, and so is a
 * Merge target (it has no one source to compare). Under Fail, a retry refuses
 * on the files the failed attempt wrote; that is what Fail asks for.
 *
 * PERMISSION. The sink connection must allow writes, and so must the source
 * when After copy deletes or moves (the fs `writable` flag, fail-closed).
 *
 * NOT ATOMIC ACROSS FILES, as in ADF: each file lands atomically (temp, fsync,
 * rename), and a failure part-way leaves the files already copied in place.
 * The counters are emitted as outputs before the failure, so the run says what
 * it had done.
 *
 * SESSION LOG (#1600 OR41 C6b, catalogue §4.1, §5): to the run log, ADF's copy
 * log operations. Everything logs a `FileRead` per source and a `FileWrite` per
 * file written, added once the write has landed, beside the counters they
 * match; Warnings logs each `FileSkip`, with why. The After copy delete or move
 * is not an operation of ADF's copy log, and the counters report it. No Error
 * line: the node's error names the file a copy failed on.
 *
 * FAULT TOLERANCE (#1600 OR41 C6d-2, catalogue §4.1; ADF's `skipErrorFile`).
 * On a source of several files (a folder or a file list), *Skip missing files*
 * (on by default) skips a file or subfolder removed by someone else during the
 * copy, and *Skip forbidden files* (off by default) one the connection may not
 * read or list. Each is a `FileSkip` line, and a skipped file is counted in
 * `filesSkipped`; a skipped subfolder is not, since its files were never seen.
 * A skipped source is never written, deleted or moved. One file always fails,
 * as in ADF, and so does a file-list line naming a file that is not there (the
 * author's mistake, not a race). Only the source's own open, listing or stat is
 * skipped: a sink failure, a source replaced by another file, and an abort fail.
 */

type FsConfig = z.infer<typeof fsConnectionConfigSchema>;

/** One selected source file. `rel` is its path under the source path. */
export interface SourceFile {
  readonly abs: string;
  readonly rel: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: number;
}

/** What a source looked like when it was read, to check before removing it. */
export interface ReadStamp {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly read: number;
}

/** A directory that may not exist yet: its deepest existing, confined ancestor plus the rest. */
interface PlannedDir {
  readonly base: string;
  readonly missing: readonly string[];
  readonly path: string;
}

class Refusal extends Error {}

/** #1600 C6d-2 — why a source is skipped rather than failing the copy. */
type SkipWhy = 'missing' | 'forbidden';
/** Classifies a source's open, listing or stat error: a skip, or `undefined` to fail. */
type Skips = (err: unknown) => SkipWhy | undefined;

const FORBIDDEN_ERRNOS: ReadonlySet<string> = new Set(['EACCES', 'EPERM']);

/** The `FileSkip` message's reason. The missing one is Delete's. */
const SKIP_WHY: Record<SkipWhy, string> = {
  missing: `${REMOVED_BY_SOMEONE_ELSE} and Skip missing files is on`,
  forbidden: 'permission denied and Skip forbidden files is on',
};

/** ADF's rule: only a source of several files skips one; one file fails. */
function skipsFor(cfg: CopyFilesConfig, signal: AbortSignal): Skips {
  return (err) => {
    if (cfg.pathType === 'file' || signal.aborted) return undefined;
    if (cfg.skipMissingFiles && isMissingErrno(err)) return 'missing';
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (cfg.skipForbiddenFiles && code !== undefined && FORBIDDEN_ERRNOS.has(code)) {
      return 'forbidden';
    }
    return undefined;
  };
}

/** Logs a skip, counting it when it is a file. */
type OnSkip = (rel: string, why: SkipWhy, folder: boolean) => void;

function refuse(message: string): never {
  throw new Refusal(message);
}

const COUNTERS = [
  'filesRead',
  'filesWritten',
  'filesSkipped',
  'filesDeleted',
  'filesMoved',
  'bytesRead',
  'bytesWritten',
] as const;
type Counters = Record<(typeof COUNTERS)[number], number>;

/**
 * #1600 C1b — where the copy read from and wrote to, canonical: the source
 * file or folder, and the file written (one file or a merge) or the sink
 * folder. The retired `file_copy`/`file_move` outputs of the same names.
 */
interface CopyPaths {
  source: string;
  dest: string;
}

function outputsOf(
  c: Counters,
  paths: CopyPaths | undefined,
  measure: CopyMeasure,
  usedParallelCopies: number,
  logPath: string | null,
  watermark: { old: string | null; new: string | null } | undefined,
): Record<string, unknown> {
  // No row outputs: a files copy moves no rows, and a `rowsWritten` of 0 would
  // read as "wrote nothing" in the runs list's rows total. #1600 OR41 C6f-1 —
  // the run's measures last, in the catalog entry's order (C6f-2's degree, then
  // C6c-1a's log file, then C5b's watermark, under Load Incremental only).
  return {
    ...c,
    ...paths,
    ...measure,
    usedParallelCopies,
    logPath,
    ...(watermark === undefined ? {} : { watermark }),
  };
}

type OpenedLog = { ok: true; writer: SessionLogWriter } | { ok: false; error: string };

/**
 * #1600 OR41 C6c-1a — Write to Folder: the log connection and its folder are
 * checked (`checkLogConnectionFolder`, shared with a rows Copy). Then the
 * attempt's file is created, so every terminal after this keeps a log.
 *
 * A Folder source is listed after this, so a log folder that is the source
 * folder, or under it with Include subfolders on, is refused: the copy would
 * copy its own log, and After copy would delete or move it. Delete refuses the
 * same overlap (C9c).
 */
async function openFolderLog(
  ctx: ActivityContext,
  cfg: CopyFilesConfig,
  source: FsConfig,
): Promise<OpenedLog> {
  const checked = await checkLogConnectionFolder(ctx.logConnection, cfg.logFolder);
  if (!checked.ok) return checked;
  if (cfg.pathType === 'folder') {
    const root = await resolveWithinRoots(source.roots, cfg.sourcePath, 'fs');
    // A source that does not resolve is refused by the plan, with this log kept.
    const base = root.ok ? await realpath(root.path).catch(() => undefined) : undefined;
    if (
      base !== undefined &&
      (checked.dir === base || (cfg.recursive && within(base, checked.dir)))
    ) {
      const where = checked.dir === base ? 'the source folder' : 'inside the source folder';
      return {
        ok: false,
        error: `the log folder is ${where}, so the copy would copy its own log; pick one outside it`,
      };
    }
  }
  return SessionLogWriter.open(
    checked.dir,
    sessionLogFileName(makeTmpSuffix(ctx)),
    sessionLogWriterOptions(cfg.logMode),
  );
}

async function confined(roots: readonly string[], requested: string): Promise<string> {
  const r = await resolveWithinRoots(roots, requested, 'fs');
  return r.ok ? r.path : refuse(r.error);
}

/** The first allowed root that resolves, canonical: `resolveWithinRoots`'s base. */
async function firstRoot(roots: readonly string[]): Promise<string> {
  for (const root of roots) {
    if (!isAbsolute(root)) continue;
    try {
      return await realpath(root);
    } catch {
      // An inaccessible root is skipped, as `resolveWithinRoots` skips it.
    }
  }
  return refuse('no accessible allowed root directory on the fs connection');
}

/**
 * Plan a directory inside `roots` without creating it: walk up to the deepest
 * ancestor that exists, confine THAT, and keep the remaining names. The
 * ancestor must be a real directory; `materialize` creates the rest.
 */
async function planDir(
  roots: readonly string[],
  requested: string | undefined,
): Promise<PlannedDir> {
  const first = await firstRoot(roots);
  const target = resolve(
    requested === undefined ? first : isAbsolute(requested) ? requested : join(first, requested),
  );
  const missing: string[] = [];
  let cur = target;
  for (;;) {
    const st = await lstatOrNull(cur);
    if (st !== null) {
      if (st.isSymbolicLink())
        refuse(`'${cur}' is a symlink; the fs connector does not follow symlinks`);
      if (!st.isDirectory()) refuse(`'${cur}' is not a folder`);
      break;
    }
    const parent = dirname(cur);
    if (parent === cur) refuse(`no part of '${target}' exists`);
    missing.unshift(basename(cur));
    cur = parent;
  }
  const base = await confined(roots, cur);
  return { base, missing, path: join(base, ...missing) };
}

/**
 * A plan-time check that each of `names`, walked down from `base`, is a real
 * folder where it exists, so a file or symlink standing where the copy must
 * make a folder is refused before anything is written. Memoised across the
 * plan; `materialize` re-checks at write time.
 */
function folderCheck(): (base: string, names: readonly string[]) => Promise<void> {
  const known = new Map<string, 'folder' | 'missing'>();
  return async (base, names) => {
    let cur = base;
    for (const name of names) {
      cur = join(cur, name);
      let kind = known.get(cur);
      if (kind === undefined) {
        const st = await lstatOrNull(cur);
        if (st?.isSymbolicLink() === true) {
          refuse(`'${cur}' is a symlink; the fs connector does not follow symlinks`);
        }
        if (st !== null && !st.isDirectory()) {
          refuse(`'${cur}' is not a folder, and the copy needs one there`);
        }
        kind = st === null ? 'missing' : 'folder';
        known.set(cur, kind);
      }
      if (kind === 'missing') return;
    }
  };
}

/** `link` then `unlink` is a move that never replaces an existing file, as `rename` would. */
async function linkTo(s: SourceFile, dest: string): Promise<void> {
  try {
    await link(s.abs, dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') refuse(`cannot move '${s.rel}': '${dest}' already exists`);
    if (code === 'EXDEV') {
      refuse(`cannot move '${s.rel}' to '${dest}' across file systems; use Delete source instead`);
    }
    if (code !== undefined && LINK_UNSUPPORTED.has(code)) {
      refuse(
        `cannot move '${s.rel}': the file system does not support hard links, which a move needs; use Delete source instead`,
      );
    }
    throw err;
  }
}

/**
 * Every path the plan will create, case-folded as the target clash check is:
 * a file and a folder, or two files, cannot both be made at one path. Catches
 * a sink and a Move to that overlap (the two connections may share a root),
 * where each path alone looks free (#1685).
 */
function plannedPaths() {
  const made = new Map<string, 'file' | 'folder'>();
  const add = (path: string, kind: 'file' | 'folder') => {
    const key = path.toLowerCase();
    const was = made.get(key);
    if (was === undefined) made.set(key, kind);
    else if (was === 'file' || kind === 'file') {
      refuse(`the copy would make two things at '${path}': a file and a folder, or two files`);
    }
  };
  return {
    folders(base: string, names: readonly string[]) {
      let cur = base;
      for (const name of names) add((cur = join(cur, name)), 'folder');
    },
    file(path: string) {
      add(path, 'file');
    },
  };
}

/** Create `names` under the canonical `base` one at a time, each a real directory. */
async function materialize(
  base: string,
  names: readonly string[],
  changed?: Set<string>,
  made?: Map<string, Promise<void>>,
): Promise<string> {
  let cur = base;
  for (const name of names) {
    const next = join(cur, name);
    const parent = cur;
    const create = async () => {
      try {
        await mkdir(next);
        // A new entry in `parent`: flushed before any source is removed.
        changed?.add(parent);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        // #1600 OR41 C6f-2 — marked here too: the folder may be one another
        // copy running at once has just made under a name that differs only
        // in case (one folder on a case-insensitive disk), not yet durable.
        // Once per folder per run (`made`), so it costs at most one more sync.
        if (made !== undefined) changed?.add(parent);
      }
    };
    // C6f-2 — copies running at once share one creation of a folder, so the
    // one that would lose the `mkdir` race waits until the winner has marked
    // its parent for the flush, rather than removing a source before it is.
    // Only the creation is shared: every call still checks the folder below.
    let creating = made?.get(next);
    if (creating === undefined) {
      creating = create();
      made?.set(next, creating);
    }
    await creating;
    const st = await lstat(next);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      refuse(`'${next}' is not a folder the copy can write into`);
    }
    cur = next;
  }
  return cur;
}

/** The segments of a relative path that stays below its base, or a refusal. */
function segmentsBelow(base: string, relPath: string, what: string): string[] {
  if (isAbsolute(relPath)) refuse(`${what} '${relPath}' must be relative`);
  const rel = relative(base, resolve(base, relPath));
  if (rel === '' || escapes(rel)) {
    refuse(`${what} '${relPath}' leaves the folder it is relative to`);
  }
  return rel.split(sep);
}

async function selectSources(
  cfg: CopyFilesConfig,
  source: FsConfig,
  contains: (st: BigIntStats) => boolean,
  signal: AbortSignal,
  skips: Skips,
  onSkip: OnSkip,
): Promise<{ root: string; files: SourceFile[] }> {
  const cap = source.maxEntries ?? DEFAULT_MAX_LIST_ENTRIES;
  const root = await confined(source.roots, cfg.sourcePath);
  const rootStat = await lstatOrNull(root);
  if (rootStat === null) refuse(`source path '${cfg.sourcePath}' does not exist`);
  const files: SourceFile[] = [];
  const take = (abs: string, rel: string, st: BigIntStats) => {
    if (contains(st)) {
      files.push({ abs, rel, dev: st.dev, ino: st.ino, mode: Number(st.mode) & 0o777 });
    }
  };

  if (cfg.pathType === 'file') {
    if (!rootStat!.isFile()) refuse(`source path '${cfg.sourcePath}' is not a file`);
    take(root, basename(root), rootStat!);
    return { root, files };
  }
  if (!rootStat!.isDirectory()) refuse(`source path '${cfg.sourcePath}' is not a folder`);

  if (cfg.pathType === 'folder') {
    const matches = wildcardMatcher(cfg.wildcard);
    let visited = 0;
    const pending: string[] = [''];
    while (pending.length > 0) {
      const relDir = pending.pop()!;
      let dir: Dir;
      try {
        dir = await opendir(join(root, relDir));
      } catch (err) {
        // A subfolder, never the source path itself, which has nothing to copy.
        const why = relDir === '' ? undefined : skips(err);
        if (why === undefined) throw err;
        onSkip(relDir, why, true);
        continue;
      }
      try {
        for (;;) {
          if (signal.aborted) throw new Error('file copy aborted');
          const d = await dir.read();
          if (d === null) break;
          visited += 1;
          if (visited > cap) {
            refuse(
              `the source has more than the ${cap}-entry limit (Most entries listed on the source connection)`,
            );
          }
          const rel = relDir === '' ? d.name : join(relDir, d.name);
          // A symlink is never followed, as a file or as a folder.
          if (d.isDirectory()) {
            if (cfg.recursive) pending.push(rel);
          } else if (d.isFile() && matches(d.name)) {
            const abs = join(root, rel);
            let st: BigIntStats;
            try {
              st = await lstat(abs, { bigint: true });
            } catch (err) {
              const why = skips(err);
              if (why === undefined) throw err;
              onSkip(rel, why, false);
              continue;
            }
            take(abs, rel, st);
          }
        }
      } finally {
        await dir.close().catch(() => undefined);
      }
    }
  } else {
    // File list: one path per line, relative to the source path. Bounded by the
    // connection's read cap, and by the entry cap like a walk.
    const listPath = await confined(source.roots, cfg.fileListPath!);
    const fh = await open(listPath, fsConstants.O_RDONLY | O_NOFOLLOW);
    let text: string;
    try {
      const st = await fh.stat();
      if (!st.isFile()) refuse(`file list '${cfg.fileListPath}' is not a file`);
      const max = source.maxBytes ?? DEFAULT_MAX_READ_BYTES;
      if (st.size > max) refuse(`file list is ${st.size} bytes, over the ${max}-byte read limit`);
      text = await fh.readFile({ encoding: 'utf8', signal });
    } finally {
      await closeQuietly(fh);
    }
    const lines = [
      ...new Set(
        text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l !== ''),
      ),
    ];
    if (lines.length > cap) refuse(`the file list names more than the ${cap}-entry limit`);
    // Two lines naming one file (`a.txt`, `./a.txt`) copy it once: a merge
    // would write it twice, and a delete after copy would fail on the second.
    const named = new Set<string>();
    const skippedLines = new Set<string>();
    for (const line of lines) {
      const segments = segmentsBelow(root, line, 'file list path');
      let abs: string;
      let st: BigIntStats | null;
      try {
        abs = await confined(source.roots, join(root, ...segments));
        // `resolveWithinRoots` canonicalises the parent, so a symlinked folder in
        // the line could still land elsewhere in the roots. Hold it to the source.
        if (!within(root, abs)) refuse(`file list path '${line}' leaves the source path`);
        st = await lstatOrNull(abs);
      } catch (err) {
        // Only a forbidden line is skipped while planning. A line naming a file
        // that is not there is refused below: it is the author's, not a race.
        if (skips(err) !== 'forbidden') throw err;
        // Two lines naming it (`a/b.txt`, `./a/b.txt`) skip it once, as they
        // would copy it once.
        const rel = join(...segments);
        if (!skippedLines.has(rel)) onSkip(rel, 'forbidden', false);
        skippedLines.add(rel);
        continue;
      }
      if (st === null) refuse(`file list path '${line}' does not exist`);
      if (!st!.isFile()) refuse(`file list path '${line}' is not a file`);
      if (named.has(abs)) continue;
      named.add(abs);
      take(abs, relative(root, abs), st!);
    }
    // A list is copied, and merged, in the author's order.
    return { root, files };
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { root, files };
}

interface Target {
  readonly sources: readonly SourceFile[];
  /** Folder names under the sink base to create, then the file name. */
  readonly dirs: readonly string[];
  readonly name: string;
}

/** The target's path under the sink folder, as the session log names it. */
function sinkRel(t: Target): string {
  return join(...t.dirs, t.name);
}

function planTargets(
  cfg: CopyFilesConfig,
  sinkBase: string,
  files: readonly SourceFile[],
): Target[] {
  const named = (relPath: string, sources: readonly SourceFile[]): Target => {
    const segments = segmentsBelow(sinkBase, relPath, 'sink file');
    return { sources, dirs: segments.slice(0, -1), name: segments[segments.length - 1]! };
  };
  if (cfg.copyBehavior === 'merge') {
    return files.length === 0 ? [] : [named(cfg.sinkFileName!, files)];
  }
  if (cfg.pathType === 'file') {
    return files.map((f) => named(cfg.sinkFileName ?? basename(f.rel), [f]));
  }
  return files.map((f) => named(cfg.copyBehavior === 'flatten' ? basename(f.rel) : f.rel, [f]));
}

/**
 * #1600 C6e-2 — a verified file that changed while it was copied, or whose
 * written file is not the size read. Nothing was landed for it.
 */
interface Inconsistent {
  readonly source: SourceFile;
  readonly reason: string;
}

async function writeTarget(
  target: Target,
  finalPath: string,
  tmpSuffix: string,
  noClobber: boolean,
  signal: AbortSignal,
  c: Counters,
  stamps: Map<string, ReadStamp>,
  log: SessionLog,
  openOrSkip: (s: SourceFile) => Promise<OpenedSource | undefined>,
  verify: boolean,
  probed: readonly SourceFile[] | undefined,
): Promise<'written' | 'exists' | 'skipped' | Inconsistent> {
  let read = 0;
  // Each source's bytes, for its FileRead line.
  const reads: { rel: string; bytes: number }[] = [];
  // #1600 C6d-2 — a merge first opens each source and closes it again, so a
  // skipped one is known before the file's bits are set from the files it
  // holds. One lost to a race after that is skipped too, leaving the merge's
  // bits narrower than they need be, never wider. `probed` is that list when
  // the caller has already made it (#1777).
  let sources = probed ?? target.sources;
  if (probed === undefined && sources.length > 1) sources = await openable(sources, openOrSkip);
  if (sources.length === 0) return 'skipped';
  // Set when every source was skipped mid-write: no file is landed then.
  let nothingRead = false;
  // C6e-2 — set when Verify copied files finds a difference: nor is one landed.
  let inconsistent: Inconsistent | undefined;
  const writeInto = async (dst: Awaited<ReturnType<typeof open>>) => {
    for (const s of sources) {
      const src = await openOrSkip(s);
      if (src === undefined) continue;
      try {
        const bytes = await streamInto(src.fh, dst, signal);
        read += bytes;
        reads.push({ rel: s.rel, bytes });
        const stamp = stampOf(src.st, bytes);
        stamps.set(s.abs, stamp);
        // The source is judged before the temp is renamed, so a file that
        // changed while it was read never lands, and a target it would have
        // replaced is kept. The same rule After copy applies (`changedSince`).
        const changed = verify ? await changedSince(s, stamp) : undefined;
        if (changed !== undefined) {
          inconsistent = {
            source: s,
            reason: `the source changed while it was copied: ${changed}`,
          };
          throw new Error('the source changed while it was copied');
        }
      } finally {
        await closeQuietly(src.fh);
      }
    }
    if (reads.length === 0) {
      // Thrown so `atomicReplace` removes the temp rather than land an empty file.
      nothingRead = true;
      throw new Error('every source was skipped');
    }
    // ADF's size check of the file written, on the handle it was written through.
    // A verified copy preserves the hierarchy, so its target has one source.
    if (verify) {
      const written = (await dst.stat({ bigint: true })).size;
      if (written !== BigInt(read)) {
        inconsistent = {
          source: sources[0]!,
          reason: `the file written holds ${counted(Number(written), 'byte')}, not the ${counted(read, 'byte')} read`,
        };
        throw new Error('the file written is not the size read');
      }
    }
  };
  // The copy keeps its source's permission bits; a merge keeps the bits every
  // source shares, so it is never more open than any file it holds.
  const mode = sources.reduce((m, s) => m & s.mode, 0o777);
  const result = await atomicReplace(finalPath, tmpSuffix, signal, writeInto, {
    noClobber,
    mode,
  });
  if (nothingRead) return 'skipped';
  if (inconsistent !== undefined) return inconsistent;
  if (result === TARGET_EXISTS) return 'exists';
  if (result !== undefined) throw new EventFailure(result);
  c.filesRead += reads.length;
  c.bytesRead += read;
  c.bytesWritten += read;
  c.filesWritten += 1;
  // Logged beside the counters, once the write has landed, so a line never
  // claims a file the counters do not.
  for (const r of reads) log.add('Info', 'FileRead', r.rel, `read ${counted(r.bytes, 'byte')}`);
  const [only] = target.sources;
  log.add(
    'Info',
    'FileWrite',
    sinkRel(target),
    target.sources.length === 1 && only !== undefined
      ? `wrote ${counted(read, 'byte')} from '${only.rel}'`
      : `wrote ${counted(read, 'byte')} merged from ${counted(reads.length, 'file')}`,
  );
  return 'written';
}

/** The sources that still open, each closed again; a skip is logged and counted by `openOrSkip`. */
async function openable(
  sources: readonly SourceFile[],
  openOrSkip: (s: SourceFile) => Promise<OpenedSource | undefined>,
): Promise<SourceFile[]> {
  const kept: SourceFile[] = [];
  for (const s of sources) {
    const probe = await openOrSkip(s);
    if (probe === undefined) continue;
    await closeQuietly(probe.fh);
    kept.push(s);
  }
  return kept;
}

interface OpenedSource {
  readonly fh: FileHandle;
  readonly st: BigIntStats;
}

/**
 * Open a planned source, refusing one that is no longer the file the plan saw.
 * Only the open's own error can be a skip (C6d-2): `skips` says why, and the
 * reason is returned. A replaced file is refused, never skipped.
 */
async function openSource(s: SourceFile, skips: Skips): Promise<OpenedSource | SkipWhy> {
  let fh: FileHandle;
  try {
    fh = await open(s.abs, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    const why = skips(err);
    if (why === undefined) throw err;
    return why;
  }
  try {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile()) refuse(`source '${s.abs}' is no longer a regular file`);
    if (st.dev !== s.dev || st.ino !== s.ino) {
      refuse(`source '${s.abs}' was replaced after the copy was planned`);
    }
    return { fh, st };
  } catch (err) {
    await closeQuietly(fh);
    throw err;
  }
}

function stampOf(st: BigIntStats, read: number): ReadStamp {
  return { dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs, read };
}

/**
 * True when the regular file at `targetPath` holds exactly the bytes of the
 * source `s`, or why the source was skipped instead (C6d-2). Stamps the
 * source from this read, as a copy would, so After copy can check it is still
 * the file that was compared. Size first; a same-size
 * pair is read in chunks, never whole.
 */
async function alreadyCopied(
  s: SourceFile,
  targetPath: string,
  signal: AbortSignal,
  stamps: Map<string, ReadStamp>,
  skips: Skips,
): Promise<boolean | SkipWhy> {
  let dst: FileHandle;
  try {
    // O_NONBLOCK: a FIFO standing at the target must not block the open.
    dst = await open(targetPath, fsConstants.O_RDONLY | O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    // A symlink (ELOOP), an unreadable or vanished target: not a copy of this
    // source, so it is skipped and the source kept, as before #1685.
    if (NOT_COMPARABLE.has((err as NodeJS.ErrnoException).code ?? '')) return false;
    throw err;
  }
  let src: OpenedSource | undefined;
  try {
    const dstSt = await dst.stat({ bigint: true });
    if (!dstSt.isFile()) return false;
    const opened = await openSource(s, skips);
    // C6d-2 — the source went, or cannot be read: not compared, so not removed.
    if (typeof opened === 'string') return opened;
    src = opened;
    if (dstSt.size !== src.st.size) return false;
    const a = Buffer.allocUnsafe(FS_STREAM_CHUNK_BYTES);
    const b = Buffer.allocUnsafe(FS_STREAM_CHUNK_BYTES);
    let read = 0;
    for (;;) {
      if (signal.aborted) throw new Error('file copy aborted');
      const { bytesRead } = await src.fh.read(a, 0, a.length, read);
      if (bytesRead === 0) break;
      const got = await readFully(dst, b, bytesRead, read);
      if (got !== bytesRead || a.compare(b, 0, got, 0, bytesRead) !== 0) return false;
      read += bytesRead;
    }
    // The target may have grown past the source while it was read.
    if ((await readFully(dst, b, 1, read)) !== 0) return false;
    // Nothing proves an earlier attempt's fsync reached this file: flush it
    // before its source can be removed.
    await dst.sync();
    stamps.set(s.abs, stampOf(src.st, read));
    return true;
  } finally {
    await closeQuietly(dst);
    await closeQuietly(src?.fh);
  }
}

const NOT_COMPARABLE: ReadonlySet<string> = new Set([
  'ELOOP',
  'EACCES',
  'EPERM',
  'ENOENT',
  'EISDIR',
  'ENXIO',
]);

/** Read up to `length` bytes at `position`, looping on a short read. */
async function readFully(
  fh: FileHandle,
  buf: Buffer,
  length: number,
  position: number,
): Promise<number> {
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, position + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return got;
}

/**
 * How a source changed since it was read, or `undefined` when it did not:
 * another inode now at the path, a different size or modified time, or a
 * different number of bytes read than it held when opened. One rule for After
 * copy and for Verify copied files (#1600 C6e-2).
 */
async function changedSince(
  s: SourceFile,
  stamp: ReadStamp | undefined,
): Promise<string | undefined> {
  if (stamp === undefined) return 'it was not read';
  const now = await lstatOrNull(s.abs);
  if (now === null) return 'it was removed';
  if (!now.isFile() || now.dev !== stamp.dev || now.ino !== stamp.ino) {
    return 'another file took its place';
  }
  if (BigInt(stamp.read) !== stamp.size) {
    return `it held ${counted(Number(stamp.size), 'byte')} when opened, and the copy read ${counted(stamp.read, 'byte')}`;
  }
  if (now.size !== stamp.size) {
    return `its size went from ${counted(Number(stamp.size), 'byte')} to ${counted(Number(now.size), 'byte')}`;
  }
  if (now.mtimeNs !== stamp.mtimeNs) return 'its modified time changed';
  return undefined;
}

/**
 * Refuse to delete or move a source that changed after it was read
 * (`changedSince`). The copy fails and the file stays where it is.
 * Exported for its unit test; nothing else calls it.
 */
export async function unchangedSince(s: SourceFile, stamp: ReadStamp | undefined): Promise<void> {
  if ((await changedSince(s, stamp)) !== undefined) {
    refuse(`source '${s.rel}' changed while it was copied, so it was left in place`);
  }
}

/**
 * Flush a folder's entries to disk. `atomicReplace` fsyncs the file but not the
 * rename's directory entry; that is fine while the source still exists, and not
 * once After copy is about to remove it, when a power loss could otherwise
 * lose both. So the folder holding the new copy is synced first.
 */
async function syncDir(path: string): Promise<void> {
  const dir = await open(path, fsConstants.O_RDONLY);
  try {
    await dir.sync();
  } finally {
    await closeQuietly(dir);
  }
}

/** Carries an already-built `failed` event (from `atomicReplace`) out of the copy loop. */
class EventFailure extends Error {
  constructor(readonly event: ActivityEvent) {
    super('write failed');
  }
}

export async function* runFilesCopy(
  ctx: ActivityContext,
  source: FsConfig,
): AsyncIterable<ActivityEvent> {
  // #1600 OR41 C6f-1 — the copy's duration runs from here to its terminal.
  const startedMs = performance.now();
  const input = copyFilesConfigSchema.safeParse(ctx.input);
  if (!input.success) {
    yield failed(
      'permanent',
      `invalid copy (files) config: ${formatZodIssues(input.error.issues)}`,
    );
    return;
  }
  const cfg = input.data;
  if (ctx.sink?.kind !== 'fs') {
    yield failed('permanent', 'a files copy writes to a file connection, and the sink is not one');
    return;
  }
  const sinkParsed = writableFs(ctx.sink.connectionConfig, 'sink');
  if (!sinkParsed.ok) {
    yield failed('permanent', sinkParsed.error);
    return;
  }
  const sink = sinkParsed.config;
  if (cfg.afterCopy !== 'keep' && source.writable !== true) {
    yield failed(
      'permanent',
      `After copy is ${cfg.afterCopy === 'delete' ? 'Delete source' : 'Move source to'}, and the source connection does not allow writes; turn on Allow writes on it`,
    );
    return;
  }
  const window = modifiedWindow(cfg.modifiedStart, cfg.modifiedEnd);
  if (!window.ok) {
    yield failed('permanent', window.error);
    return;
  }
  // #1600 OR41 C5b — Load Incremental: the stored time from the executor's
  // lease, and the cutoff, taken here, before anything is listed.
  let incremental: IncrementalWindow | undefined;
  if (cfg.load === 'incremental') {
    if (ctx.copyWatermark === undefined) {
      yield failed('permanent', 'Load Incremental has no stored watermark to read');
      return;
    }
    const planned = incrementalWindow(ctx.copyWatermark.old);
    if (!planned.ok) {
      yield failed('permanent', planned.error);
      return;
    }
    incremental = planned.window;
  }
  const selects = incremental?.contains ?? ((st: BigIntStats) => window.contains(msOf(st.mtimeNs)));
  // C5b — `{old, new}` once every selected file is written and the time stored
  // (or its store failed, which the failure says): never for a window not
  // finished. A window that selected nothing keeps the stored time, as a rows
  // Copy with nothing above its watermark does (C5a): the next run's window
  // starts where this one did, so nothing is lost and nothing is stored.
  let watermark: { old: string | null; new: string | null } | undefined;
  const finishWindow = (selected: boolean): string | null => {
    if (incremental === undefined) return null;
    const next = selected ? incremental.next : incremental.old;
    watermark = { old: incremental.old, new: next };
    return next === incremental.old ? null : storeWatermark(ctx, next, 'files were copied');
  };

  const signal = ctx.signal;
  const c: Counters = Object.fromEntries(COUNTERS.map((k) => [k, 0])) as Counters;
  // #1600 OR41 C6f-1 — what Verify copied files found: a file that failed the
  // copy, or one Skip inconsistent files stepped over (ADF's InconsistentData).
  let inconsistency: CopyConsistencyResult = 'none';
  // #1600 OR41 C6f-2 — how many copies ran at once: 1 until the write starts.
  let width = 1;
  const measured = (): CopyMeasure =>
    copyMeasure(startedMs, performance.now(), c.bytesRead, {
      verified: cfg.validateDataConsistency,
      result: inconsistency,
    });
  // #1600 OR41 C6c-1a — Write to Folder: the log is opened before anything is
  // planned, so a bad log connection or folder fails the copy with nothing done.
  let opened: OpenedLog | undefined;
  if (cfg.logLevel !== 'off' && cfg.logTo === 'folder') {
    try {
      opened = await openFolderLog(ctx, cfg, source);
    } catch (err) {
      yield failFromError(err, signal);
      return;
    }
    if (!opened.ok) {
      yield failed('permanent', opened.error);
      return;
    }
  }
  const logFile = opened?.ok === true ? opened.writer : undefined;
  let logPath: string | null = null;
  // To the run log, capped as it is kept, as a rows Copy's is (C6a): a folder
  // can hold more files than the run log shows lines. To a folder, every line,
  // streamed to the file rather than held.
  const log = new SessionLog(
    cfg.logLevel,
    undefined,
    logFile === undefined
      ? { keepAtMost: SESSION_LOG_RUN_MAX_LINES }
      : { onLine: (line) => logFile.append(line) },
  );
  const bestEffort = cfg.logMode === 'bestEffort';
  /**
   * The log's last act before a terminal: the run log's lines, or the folder
   * log closed and `logPath` set. The folder log's error if it could not be
   * written: a success then fails (Delete's rule, C9c), and a failure keeps
   * its own error. C6c-2 — under Best effort a success warns instead, and
   * `logPath` names the file, which holds the lines written before the error.
   */
  async function* endLog(): AsyncGenerator<ActivityEvent, string | undefined> {
    if (logFile === undefined) {
      yield* sessionLogRunEvents(log);
      return undefined;
    }
    const closed = await logFile.close();
    if (closed.ok || bestEffort) logPath = logFile.path;
    return closed.ok ? undefined : closed.error;
  }
  /** C6c-2 — a success's log error: Best effort warns and goes on (true). */
  function* logErrorWarned(logError: string): Generator<ActivityEvent, boolean> {
    if (!bestEffort) return false;
    yield sessionLogIncomplete(logFile!.path, logError);
    return true;
  }
  // #1600 C6d-2 — the sources skipped as missing or forbidden: never written,
  // deleted, moved or counted again.
  const skips = skipsFor(cfg, signal);
  const gone = new Set<string>();
  const onSkip: OnSkip = (rel, why, folder) => {
    if (!folder) c.filesSkipped += 1;
    log.add('Warning', 'FileSkip', rel, `skipped: ${folder ? 'folder ' : ''}${SKIP_WHY[why]}`);
  };
  const openOrSkip = async (s: SourceFile): Promise<OpenedSource | undefined> => {
    const opened = await openSource(s, skips);
    if (typeof opened !== 'string') return opened;
    gone.add(s.abs);
    onSkip(s.rel, opened, false);
    return undefined;
  };
  let started = false;
  let where: CopyPaths | undefined;
  try {
    // ── Plan ────────────────────────────────────────────────────────────
    const { root, files } = await selectSources(cfg, source, selects, signal, skips, onSkip);
    const sinkDir = await planDir(sink.roots, cfg.sinkFolder);
    const targets = planTargets(cfg, sinkDir.path, files);
    // Named as `planTargets` names them, so `dest` is known when nothing is selected too.
    where = {
      source: root,
      dest:
        cfg.pathType === 'file' || cfg.copyBehavior === 'merge'
          ? join(
              sinkDir.path,
              ...segmentsBelow(sinkDir.path, cfg.sinkFileName ?? basename(root), 'sink file'),
            )
          : sinkDir.path,
    };
    const sourceIds = new Set(files.map((f) => `${f.dev}:${f.ino}`));
    const folders = folderCheck();
    const paths = plannedPaths();
    paths.folders(sinkDir.base, sinkDir.missing);
    const seen = new Map<string, { from: string; path: string }>();
    for (const t of targets) {
      const finalPath = join(sinkDir.path, ...t.dirs, t.name);
      // Case-folded, so two names that one case-insensitive disk would make one
      // file are refused rather than one silently overwriting the other.
      const key = finalPath.toLowerCase();
      const from = t.sources.map((s) => s.rel).join(', ');
      const clash = seen.get(key);
      if (clash !== undefined) {
        refuse(
          `'${clash.from}' and '${from}' would both be written to '${finalPath}'` +
            (clash.path === finalPath
              ? ''
              : '; the names differ only in case, which a case-insensitive disk stores as one file, so the copy refuses rather than let one overwrite the other'),
        );
      }
      seen.set(key, { from, path: finalPath });
      paths.folders(sinkDir.path, t.dirs);
      paths.file(finalPath);
      await folders(sinkDir.path, t.dirs);
      const existing = await lstatOrNull(finalPath);
      if (existing !== null) {
        if (existing.isDirectory()) {
          refuse(`'${finalPath}' is a folder, so a file cannot be written there`);
        }
        if (sourceIds.has(`${existing.dev}:${existing.ino}`)) {
          refuse(
            `'${finalPath}' is one of the files being copied; a copy cannot write over its own source`,
          );
        }
        if (cfg.ifExists === 'fail')
          refuse(`'${finalPath}' already exists and If file exists is Fail`);
      }
    }
    let moveDir: PlannedDir | undefined;
    // Sources a failed attempt had already linked into Move to, but not removed.
    const linked = new Set<string>();
    if (cfg.afterCopy === 'move') {
      moveDir = await planDir(source.roots, cfg.moveTo);
      paths.folders(moveDir.base, moveDir.missing);
      for (const f of files) {
        const dest = join(moveDir.path, f.rel);
        const dirs = f.rel.split(sep).slice(0, -1);
        paths.folders(moveDir.path, dirs);
        paths.file(dest);
        await folders(moveDir.path, dirs);
        const there = await lstatOrNull(dest);
        if (there !== null) {
          if (there.isFile() && there.dev === f.dev && there.ino === f.ino) linked.add(f.abs);
          else refuse(`cannot move '${f.rel}': '${dest}' already exists`);
        }
      }
      // `link` cannot cross file systems: refuse before anything is written.
      const moveDev = (await lstat(moveDir.base, { bigint: true })).dev;
      const away = files.find((f) => f.dev !== moveDev);
      if (away !== undefined) {
        refuse(
          `cannot move '${away.rel}' to '${moveDir.path}' across file systems; use Delete source instead`,
        );
      }
    }
    // Nothing selected: a success that creates no folders. Its lines are the
    // skips made while selecting (C6d-2).
    if (targets.length === 0) {
      // C5b — an empty window keeps the stored time.
      finishWindow(false);
      const logError = yield* endLog();
      if (logError !== undefined && !(yield* logErrorWarned(logError))) {
        yield failed(
          'permanent',
          `nothing to copy, but the session log could not be written: ${logError}`,
        );
        return;
      }
      yield {
        type: 'succeeded',
        outputs: outputsOf(c, where, measured(), width, logPath, watermark),
      };
      return;
    }

    // ── Write ───────────────────────────────────────────────────────────
    started = true;
    const tmpSuffix = makeTmpSuffix(ctx);
    const stamps = new Map<string, ReadStamp>();
    // Folders whose entries changed since the last flush: synced before After
    // copy removes a source, so a power loss cannot lose the copy and the source.
    const changed = new Set<string>();
    // #1600 OR41 C6f-2 — one flush at a time, each syncing what was marked
    // before it began, so a caller's folders are durable when ITS flush
    // resolves. A failed sync leaves the chain rejected: no later flush
    // resolves, so no source is removed after it.
    let flushed: Promise<void> = Promise.resolve();
    const flush = (): Promise<void> =>
      (flushed = flushed.then(async () => {
        const dirs = [...changed];
        changed.clear();
        for (const dir of dirs) await syncDir(dir);
      }));
    const made = new Map<string, Promise<void>>();
    const sinkBase = await materialize(sinkDir.base, sinkDir.missing, changed, made);
    const moveBase =
      moveDir === undefined
        ? undefined
        : await materialize(moveDir.base, moveDir.missing, changed, made);
    const copyTarget = async (t: Target): Promise<void> => {
      if (signal.aborted) throw new Error('file copy aborted');
      // #1777 — when this target's sink folder does not exist yet, its sources
      // are opened first, so one whose every source is skipped as missing or
      // forbidden makes no folder it would leave empty. Only then: a folder
      // already there, or made by this run, costs no second open. A source
      // lost between this open and the copy's own can still leave one.
      const dir = join(sinkBase, ...t.dirs);
      let probed: SourceFile[] | undefined;
      if (t.dirs.length > 0 && !made.has(dir) && (await lstatOrNull(dir)) === null) {
        probed = await openable(t.sources, openOrSkip);
        if (probed.length === 0) return;
      }
      const parent = await materialize(sinkBase, t.dirs, changed, made);
      const finalPath = join(parent, t.name);
      const noClobber = cfg.ifExists !== 'overwrite';
      // A skipped target that already holds its one source's bytes counts as
      // copied, so a retry removes the source an earlier attempt left behind.
      // `why` is how the target came to be there, for the FileSkip lines.
      const skip = async (why: string) => {
        // A merge's sources skipped as missing or forbidden were counted then.
        const left = t.sources.filter((s) => !gone.has(s.abs));
        c.filesSkipped += left.length;
        const skipped = `skipped: '${sinkRel(t)}' ${why} and If file exists is Skip`;
        const [only] = t.sources;
        if (cfg.afterCopy === 'keep' || t.sources.length !== 1 || only === undefined) {
          for (const s of left) {
            log.add(
              'Warning',
              'FileSkip',
              s.rel,
              cfg.afterCopy === 'keep' ? skipped : `${skipped}; the source is kept`,
            );
          }
          return false;
        }
        // Logged even when the comparison throws, so the counted skip has its line.
        let copied: boolean | SkipWhy | undefined;
        try {
          copied = await alreadyCopied(only, finalPath, signal, stamps, skips);
        } finally {
          log.add(
            'Warning',
            'FileSkip',
            only.rel,
            copied === undefined
              ? skipped
              : copied === true
                ? `${skipped}; it holds this file's bytes, so After copy still applies`
                : copied === false
                  ? `${skipped}; the source is kept`
                  : `${skipped}; its source could not be read: ${SKIP_WHY[copied]}`,
          );
        }
        return copied === true;
      };
      if (cfg.ifExists === 'skip' && (await lstatOrNull(finalPath)) !== null) {
        if (!(await skip('already exists'))) return;
      } else {
        const outcome = await writeTarget(
          t,
          finalPath,
          tmpSuffix,
          noClobber,
          signal,
          c,
          stamps,
          log,
          openOrSkip,
          cfg.validateDataConsistency,
          probed,
        );
        if (outcome === 'skipped') return;
        if (typeof outcome === 'object') {
          // An abort during the check is the outcome, never a skip or a refusal.
          if (signal.aborted) throw new Error('file copy aborted');
          // C6e-2 — ADF's `skipErrorFile.dataInconsistency`. Only a source of
          // several files skips one: the schema refuses it on one file. A
          // skipped file is never deleted or moved: `return` passes After copy.
          if (!cfg.skipInconsistentFiles) {
            inconsistency = 'found';
            refuse(`Verify copied files failed for '${outcome.source.rel}': ${outcome.reason}`);
          }
          // C6f-2 — copies at once cannot mix the two verdicts: Skip
          // inconsistent files is one setting for the whole run.
          inconsistency = 'skipped';
          c.filesSkipped += 1;
          log.add(
            'Warning',
            'FileSkip',
            outcome.source.rel,
            `skipped: ${outcome.reason}, and Skip inconsistent files is on`,
          );
          return;
        }
        if (outcome === 'exists') {
          if (cfg.ifExists === 'fail')
            refuse(`'${finalPath}' appeared during the copy and If file exists is Fail`);
          if (!(await skip('appeared during the copy'))) return;
        }
      }
      // After copy, only for a source whose bytes are at the target: a skipped
      // file with other bytes stays put.
      // The copy's folder entry is durable before any source is removed.
      if (cfg.afterCopy !== 'keep') {
        changed.add(parent);
        await flush();
      }
      for (const s of t.sources) {
        // A merge source skipped as missing or forbidden was never copied.
        if (gone.has(s.abs)) continue;
        if (cfg.afterCopy !== 'keep') await unchangedSince(s, stamps.get(s.abs));
        if (cfg.afterCopy === 'delete') {
          await unlink(s.abs);
          c.filesDeleted += 1;
        } else if (cfg.afterCopy === 'move' && moveBase !== undefined) {
          const segments = s.rel.split(sep);
          const dir = await materialize(moveBase, segments.slice(0, -1), changed, made);
          const dest = join(dir, segments[segments.length - 1]!);
          if (linked.has(s.abs)) {
            // Already linked there: only the original name is left to remove,
            // once the link is still this very file.
            const there = await lstatOrNull(dest);
            if (there === null || there.dev !== s.dev || there.ino !== s.ino) {
              refuse(`cannot move '${s.rel}': '${dest}' changed after the copy was planned`);
            }
          } else {
            await linkTo(s, dest);
          }
          // And the moved entry is durable before the original goes.
          changed.add(dir);
          await flush();
          await unlink(s.abs);
          c.filesMoved += 1;
        }
      }
    };
    // #1600 OR41 C6f-2 — Degree of copy parallelism: workers sharing one cursor
    // over the targets (`runPool`, #1782). The first failure stops new work;
    // the copies already under way finish and are counted, then it is rethrown.
    // A merge is one target, so it is one copy. At 1 this is the loop it was.
    width = Math.min(cfg.parallelCopies, targets.length);
    // No `stop`: a target started after an abort throws it from its own
    // check, so an abort is never a quiet end of work. At more than one copy,
    // the failure kept is the first to happen.
    // C6c-1a — after each file, the folder log's buffer is written once full,
    // so a slow log mount holds the copy back rather than the buffer growing.
    // A log that has stopped being written stops the copy, before After copy
    // deletes or moves any more sources the author asked to have logged.
    // C6c-2 — Reliable writes after every file, and only Reliable stops: Best
    // effort keeps copying, and the success warns (`logErrorWarned`).
    const logWorking = () => {
      const failed = logFile?.failure;
      if (failed !== undefined && !bestEffort) {
        refuse(`the session log could not be written: ${failed}`);
      }
    };
    const failure = await runPool(targets, width, async (t) => {
      logWorking();
      await copyTarget(t);
      await logFile?.flushIfFull();
      logWorking();
    });
    if (failure !== undefined) throw failure.err;
    // C5b — stored the moment every file is written, before the log closes, as
    // a rows Copy's is as its sink commits: a log that then fails to close does
    // not leave the time behind, and the next run would copy these files again.
    const storeError = finishWindow(true);
    if (storeError !== null) throw new Refusal(storeError);
    // Nothing that can throw sits between the lines and the success, so they
    // are yielded once (a rows Copy needs a guard for that; this does not):
    // `close` reports a failure rather than throwing it.
    const logError = yield* endLog();
    if (logError !== undefined && !(yield* logErrorWarned(logError))) {
      // The files are copied: the counts are reported, then the failure.
      for (const [name, value] of Object.entries(
        outputsOf(c, where, measured(), width, null, watermark),
      ))
        yield { type: 'output', name, value };
      yield failed(
        'permanent',
        `copied ${counted(c.filesWritten, 'file')}, but the session log '${logFile!.path}' could not be written: ${logError}`,
      );
      return;
    }
    yield {
      type: 'succeeded',
      outputs: outputsOf(c, where, measured(), width, logPath, watermark),
    };
  } catch (err) {
    // Whatever unwound the copy once it was aborted, the outcome is the abort.
    const terminal = signal.aborted
      ? failFromError(err, signal)
      : err instanceof Refusal
        ? failed('permanent', err.message)
        : err instanceof EventFailure
          ? err.event
          : failFromError(err, signal);
    // A folder log ends with why the copy failed, as Delete's does: unlike the
    // run log, the file is read without the node's error beside it.
    if (logFile !== undefined && terminal.type === 'failed') {
      log.add('Error', 'Copy', '', terminal.error);
    }
    // The lines logged so far, ahead of the counters, as a rows Copy's are. A
    // failure keeps its own error, whatever the folder log's close reports.
    yield* endLog();
    // A skip made while selecting is counted, so its line has its counter.
    if (started || c.filesSkipped > 0) {
      for (const [name, value] of Object.entries(
        outputsOf(c, where, measured(), width, logPath, watermark),
      ))
        yield { type: 'output', name, value };
    }
    yield terminal;
  } finally {
    // Closed on every terminal above; this only covers a consumer that stops
    // iterating early. `close` answers a second call with its first.
    void logFile?.close();
  }
}
