import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, open, opendir, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { z } from 'zod';
import {
  copyFilesConfigSchema,
  formatZodIssues,
  type CopyFilesConfig,
} from '@autonomy-studio/shared';
import { failed } from './activity-events.js';
import { O_NOFOLLOW, resolveWithinRoots } from './confine.js';
import { fsConnectionConfigSchema } from './fs-connection.js';
import {
  DEFAULT_MAX_LIST_ENTRIES,
  DEFAULT_MAX_READ_BYTES,
  modifiedWindow,
  wildcardMatcher,
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
import type { ActivityContext, ActivityEvent } from './types.js';

/**
 * #1600 OR41 C1a — Copy · Files as-is (activity catalogue §4.1): copy files
 * byte for byte from the SOURCE `fs` connection (the one this adapter runs on)
 * to the SINK `fs` connection (`ctx.sink`).
 *
 * PLAN FIRST, WRITE SECOND. Every file is selected and every target worked out
 * before the first byte is written, so each refusal below is made with nothing
 * written, deleted or moved (a file standing where a folder must be created is
 * found only when that folder is made, and fails the copy there):
 *  - two sources would land on one target (Flatten, or a name that differs
 *    only in case on a case-insensitive disk);
 *  - a target IS a source, by device and inode, so a hardlink or a case-only
 *    difference cannot hide it. Overwriting a source, or deleting one after
 *    "copying" it onto itself, destroys the only copy;
 *  - *If file exists* is Fail and a target exists;
 *  - a *Move to* target already exists (a move never replaces a file).
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
 * PERMISSION. The sink connection must allow writes, and so must the source
 * when After copy deletes or moves (the fs `writable` flag, fail-closed).
 *
 * NOT ATOMIC ACROSS FILES, as in ADF: each file lands atomically (temp, fsync,
 * rename), and a failure part-way leaves the files already copied in place.
 * The counters are emitted as outputs before the failure, so the run says what
 * it had done.
 */

type FsConfig = z.infer<typeof fsConnectionConfigSchema>;

/** One selected source file. `rel` is its path under the source path. */
export interface SourceFile {
  readonly abs: string;
  readonly rel: string;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
}

/** What a source looked like when it was read, to check before removing it. */
export interface ReadStamp {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly read: number;
}

/** A directory that may not exist yet: its deepest existing, confined ancestor plus the rest. */
interface PlannedDir {
  readonly base: string;
  readonly missing: readonly string[];
  readonly path: string;
}

class Refusal extends Error {}

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

function outputsOf(c: Counters): Record<string, unknown> {
  // No row outputs: a files copy moves no rows, and a `rowsWritten` of 0 would
  // read as "wrote nothing" in the runs list's rows total.
  return { ...c };
}

async function confined(roots: readonly string[], requested: string): Promise<string> {
  const r = await resolveWithinRoots(roots, requested, 'fs');
  return r.ok ? r.path : refuse(r.error);
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (err) {
    // ENOTDIR: a parent is a file, so nothing can be at this path either.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

/** True when `child` is `parent` or sits under it (both canonical). */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || !escapes(rel);
}

/** A `relative()` result that leaves its base. `..foo` is a name, not an escape. */
function escapes(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
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

/** Create `names` under the canonical `base` one at a time, each a real directory. */
async function materialize(base: string, names: readonly string[]): Promise<string> {
  let cur = base;
  for (const name of names) {
    const next = join(cur, name);
    try {
      await mkdir(next);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
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
  contains: (mtimeMs: number) => boolean,
  signal: AbortSignal,
): Promise<SourceFile[]> {
  const cap = source.maxEntries ?? DEFAULT_MAX_LIST_ENTRIES;
  const root = await confined(source.roots, cfg.sourcePath);
  const rootStat = await lstatOrNull(root);
  if (rootStat === null) refuse(`source path '${cfg.sourcePath}' does not exist`);
  const files: SourceFile[] = [];
  const take = (
    abs: string,
    rel: string,
    st: { dev: number; ino: number; mode: number; mtimeMs: number },
  ) => {
    if (contains(st.mtimeMs)) {
      files.push({ abs, rel, dev: st.dev, ino: st.ino, mode: st.mode & 0o777 });
    }
  };

  if (cfg.pathType === 'file') {
    if (!rootStat!.isFile()) refuse(`source path '${cfg.sourcePath}' is not a file`);
    take(root, basename(root), rootStat!);
    return files;
  }
  if (!rootStat!.isDirectory()) refuse(`source path '${cfg.sourcePath}' is not a folder`);

  if (cfg.pathType === 'folder') {
    const matches = wildcardMatcher(cfg.wildcard);
    let visited = 0;
    const pending: string[] = [''];
    while (pending.length > 0) {
      const relDir = pending.pop()!;
      const dir = await opendir(join(root, relDir));
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
            take(abs, rel, await lstat(abs));
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
    for (const line of lines) {
      const segments = segmentsBelow(root, line, 'file list path');
      const abs = await confined(source.roots, join(root, ...segments));
      // `resolveWithinRoots` canonicalises the parent, so a symlinked folder in
      // the line could still land elsewhere in the roots. Hold it to the source.
      if (!within(root, abs)) refuse(`file list path '${line}' leaves the source path`);
      const st = await lstatOrNull(abs);
      if (st === null) refuse(`file list path '${line}' does not exist`);
      if (!st!.isFile()) refuse(`file list path '${line}' is not a file`);
      if (named.has(abs)) continue;
      named.add(abs);
      take(abs, relative(root, abs), st!);
    }
    // A list is copied, and merged, in the author's order.
    return files;
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return files;
}

interface Target {
  readonly sources: readonly SourceFile[];
  /** Folder names under the sink base to create, then the file name. */
  readonly dirs: readonly string[];
  readonly name: string;
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

async function writeTarget(
  target: Target,
  finalPath: string,
  tmpSuffix: string,
  noClobber: boolean,
  signal: AbortSignal,
  c: Counters,
  stamps: Map<string, ReadStamp>,
): Promise<'written' | 'exists'> {
  let read = 0;
  const writeInto = async (dst: Awaited<ReturnType<typeof open>>) => {
    for (const s of target.sources) {
      const src = await open(s.abs, fsConstants.O_RDONLY | O_NOFOLLOW);
      try {
        const st = await src.stat();
        if (!st.isFile()) refuse(`source '${s.abs}' is no longer a regular file`);
        if (st.dev !== s.dev || st.ino !== s.ino) {
          refuse(`source '${s.abs}' was replaced after the copy was planned`);
        }
        const bytes = await streamInto(src, dst, signal);
        read += bytes;
        stamps.set(s.abs, {
          dev: st.dev,
          ino: st.ino,
          size: st.size,
          mtimeMs: st.mtimeMs,
          read: bytes,
        });
      } finally {
        await closeQuietly(src);
      }
    }
  };
  // The copy keeps its source's permission bits; a merge keeps the bits every
  // source shares, so it is never more open than any file it holds.
  const mode = target.sources.reduce((m, s) => m & s.mode, 0o777);
  const result = await atomicReplace(finalPath, tmpSuffix, signal, writeInto, {
    noClobber,
    mode,
  });
  if (result === TARGET_EXISTS) return 'exists';
  if (result !== undefined) throw new EventFailure(result);
  c.filesRead += target.sources.length;
  c.bytesRead += read;
  c.bytesWritten += read;
  c.filesWritten += 1;
  return 'written';
}

/** Carries an already-built `failed` event (from `atomicReplace`) out of the copy loop. */
/**
 * Refuse to delete or move a source that changed after it was read: another
 * inode now at the path, a different size or modified time, or fewer bytes
 * copied than it held. The copy fails and the file stays where it is.
 * Exported for its unit test; nothing else calls it.
 */
export async function unchangedSince(s: SourceFile, stamp: ReadStamp | undefined): Promise<void> {
  const now = await lstatOrNull(s.abs);
  if (
    stamp === undefined ||
    now === null ||
    !now.isFile() ||
    now.dev !== stamp.dev ||
    now.ino !== stamp.ino ||
    now.size !== stamp.size ||
    now.mtimeMs !== stamp.mtimeMs ||
    stamp.read !== stamp.size
  ) {
    refuse(`source '${s.rel}' changed while it was copied, so it was left in place`);
  }
}

class EventFailure extends Error {
  constructor(readonly event: ActivityEvent) {
    super('write failed');
  }
}

export async function* runFilesCopy(
  ctx: ActivityContext,
  source: FsConfig,
): AsyncIterable<ActivityEvent> {
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
  const sinkParsed = fsConnectionConfigSchema.safeParse(ctx.sink.connectionConfig);
  if (!sinkParsed.success) {
    yield failed(
      'permanent',
      `invalid fs sink connection config: ${formatZodIssues(sinkParsed.error.issues)}`,
    );
    return;
  }
  const sink = sinkParsed.data;
  if (sink.writable !== true) {
    yield failed(
      'permanent',
      'the sink connection does not allow writes; turn on Allow writes on that connection',
    );
    return;
  }
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

  const signal = ctx.signal;
  const c: Counters = Object.fromEntries(COUNTERS.map((k) => [k, 0])) as Counters;
  let started = false;
  try {
    // ── Plan ────────────────────────────────────────────────────────────
    const files = await selectSources(cfg, source, window.contains, signal);
    const sinkDir = await planDir(sink.roots, cfg.sinkFolder);
    const targets = planTargets(cfg, sinkDir.path, files);
    const sourceIds = new Set(files.map((f) => `${f.dev}:${f.ino}`));
    const seen = new Map<string, string>();
    for (const t of targets) {
      const finalPath = join(sinkDir.path, ...t.dirs, t.name);
      // Case-folded, so two names that one case-insensitive disk would make one
      // file are refused rather than one silently overwriting the other.
      const key = finalPath.toLowerCase();
      const from = t.sources.map((s) => s.rel).join(', ');
      const clash = seen.get(key);
      if (clash !== undefined)
        refuse(`'${clash}' and '${from}' would both be written to '${finalPath}'`);
      seen.set(key, from);
      const existing = await lstatOrNull(finalPath);
      if (existing !== null) {
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
    if (cfg.afterCopy === 'move') {
      moveDir = await planDir(source.roots, cfg.moveTo);
      for (const f of files) {
        const dest = join(moveDir.path, f.rel);
        if ((await lstatOrNull(dest)) !== null)
          refuse(`cannot move '${f.rel}': '${dest}' already exists`);
      }
      // `link` cannot cross file systems: refuse before anything is written.
      const moveDev = (await lstat(moveDir.base)).dev;
      const away = files.find((f) => f.dev !== moveDev);
      if (away !== undefined) {
        refuse(
          `cannot move '${away.rel}' to '${moveDir.path}' across file systems; use Delete source instead`,
        );
      }
    }
    // Nothing selected: a success that creates no folders.
    if (targets.length === 0) {
      yield { type: 'succeeded', outputs: outputsOf(c) };
      return;
    }

    // ── Write ───────────────────────────────────────────────────────────
    started = true;
    const tmpSuffix = makeTmpSuffix(ctx);
    const stamps = new Map<string, ReadStamp>();
    const sinkBase = await materialize(sinkDir.base, sinkDir.missing);
    const moveBase =
      moveDir === undefined ? undefined : await materialize(moveDir.base, moveDir.missing);
    for (const t of targets) {
      if (signal.aborted) throw new Error('file copy aborted');
      const parent = await materialize(sinkBase, t.dirs);
      const finalPath = join(parent, t.name);
      const noClobber = cfg.ifExists !== 'overwrite';
      if (cfg.ifExists === 'skip' && (await lstatOrNull(finalPath)) !== null) {
        c.filesSkipped += t.sources.length;
        continue;
      }
      const outcome = await writeTarget(t, finalPath, tmpSuffix, noClobber, signal, c, stamps);
      if (outcome === 'exists') {
        if (cfg.ifExists === 'fail')
          refuse(`'${finalPath}' appeared during the copy and If file exists is Fail`);
        c.filesSkipped += t.sources.length;
        continue;
      }
      // After copy, only for files that were written: a skipped file stays put.
      for (const s of t.sources) {
        if (cfg.afterCopy !== 'keep') await unchangedSince(s, stamps.get(s.abs));
        if (cfg.afterCopy === 'delete') {
          await unlink(s.abs);
          c.filesDeleted += 1;
        } else if (cfg.afterCopy === 'move' && moveBase !== undefined) {
          const segments = s.rel.split(sep);
          const dir = await materialize(moveBase, segments.slice(0, -1));
          const dest = join(dir, segments[segments.length - 1]!);
          try {
            // `link` then `unlink`: never replaces an existing file, as `rename` would.
            await link(s.abs, dest);
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'EEXIST') refuse(`cannot move '${s.rel}': '${dest}' already exists`);
            if (code === 'EXDEV') {
              refuse(
                `cannot move '${s.rel}' to '${dest}' across file systems; use Delete source instead`,
              );
            }
            if (code !== undefined && LINK_UNSUPPORTED.has(code)) {
              refuse(
                `cannot move '${s.rel}': the file system does not support hard links, which a move needs; use Delete source instead`,
              );
            }
            throw err;
          }
          await unlink(s.abs);
          c.filesMoved += 1;
        }
      }
    }
    yield { type: 'succeeded', outputs: outputsOf(c) };
  } catch (err) {
    if (started) {
      for (const [name, value] of Object.entries(outputsOf(c)))
        yield { type: 'output', name, value };
    }
    if (err instanceof Refusal) yield failed('permanent', err.message);
    else if (err instanceof EventFailure) yield err.event;
    else yield failFromError(err, signal);
  }
}
