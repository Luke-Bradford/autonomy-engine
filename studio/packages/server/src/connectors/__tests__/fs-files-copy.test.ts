import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  appendFile,
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  COPY_FILES_ACTIVITY_TYPE,
  FILE_COPY_ACTIVITY_TYPE,
  FILE_MOVE_ACTIVITY_TYPE,
  getActivity,
  lowerRetiredTypes,
  SESSION_LOG_OUTPUT,
  SESSION_LOG_RUN_MAX_LINES,
  type Node,
} from '@autonomy-studio/shared';
import { fsAdapter } from '../fs.js';
import { COPY_FILES_SETTLE_MS, runFilesCopy, unchangedSince } from '../fs-files-copy.js';
import { SessionLogWriter } from '../session-log-file.js';
import { tmpPathFor } from '../fs-write.js';
import { wildcardMatcher } from '../fs-select.js';
import { cleanupTempRoots, tempRoot } from './temp-roots.js';
import type { ActivityContext, ActivityEvent } from '../types.js';

/**
 * #1600 OR41 C1a — Copy · Files as-is, run through the real `fs` adapter on
 * real temp folders. The source connection's root is `src`, the sink's is
 * `dst`, so every case also proves the two connections are kept apart.
 */

let src: string;
let dst: string;
beforeEach(() => {
  src = tempRoot('copy-files-src-');
  dst = tempRoot('copy-files-dst-');
});
afterEach(cleanupTempRoots);

async function run(
  input: Record<string, unknown>,
  over: {
    sourceWritable?: boolean;
    sinkWritable?: boolean;
    sinkKind?: 'fs' | 'sqlite';
    sinkRoot?: string;
    maxEntries?: number;
    signal?: AbortSignal;
    /** #1600 OR41 C6c-1a — the session log's connection. */
    log?: { root: string; writable?: boolean; kind?: 'fs' | 'sqlite' };
    /** #1600 OR41 C5b — the executor's lease: the stored time and its commit. */
    copyWatermark?: ActivityContext['copyWatermark'];
  } = {},
): Promise<ActivityEvent[]> {
  const c: ActivityContext = {
    runId: 'run_1',
    nodeId: 'n1',
    attemptId: 'n1#0',
    activityType: COPY_FILES_ACTIVITY_TYPE,
    input,
    connectionConfig: {
      roots: [src],
      ...(over.sourceWritable === true && { writable: true }),
      ...(over.maxEntries !== undefined && { maxEntries: over.maxEntries }),
    },
    sink: {
      kind: over.sinkKind ?? 'fs',
      connectionConfig: {
        roots: [over.sinkRoot ?? dst],
        ...(over.sinkWritable !== false && { writable: true }),
      },
    },
    ...(over.log !== undefined && {
      logConnection: {
        kind: over.log.kind ?? 'fs',
        connectionConfig: {
          roots: [over.log.root],
          ...(over.log.writable !== false && { writable: true }),
        },
      },
    }),
    ...(over.copyWatermark !== undefined && { copyWatermark: over.copyWatermark }),
    signal: over.signal ?? new AbortController().signal,
  };
  const out: ActivityEvent[] = [];
  for await (const ev of fsAdapter.runActivity(c, null)) out.push(ev);
  return out;
}

async function put(rel: string, body: string, base = src): Promise<string> {
  const path = join(base, rel);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, body);
  return path;
}

async function tree(base: string): Promise<string[]> {
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(base.length + 1))
    .sort();
}

const last = (events: ActivityEvent[]) => events[events.length - 1]!;
const outputs = (events: ActivityEvent[]) => {
  const ev = last(events);
  if (ev.type !== 'succeeded') throw new Error(`expected succeeded, got ${JSON.stringify(ev)}`);
  return ev.outputs;
};
/** #1600 OR41 C6f-1 — bytes/s over the yielded duration, null for an instant copy. */
const throughputOf = (out: Record<string, unknown>): number | null => {
  const ms = out['durationMs'] as number;
  return ms === 0 ? null : Math.round(((out['bytesRead'] as number) * 1000) / ms);
};
/**
 * The catalog's contract, name for name and in order (C6f-1), under Load Full:
 * C5b's `watermark` is Incremental's only, so a Full copy's outputs are what
 * they were.
 */
const declaredNames = () =>
  getActivity(COPY_FILES_ACTIVITY_TYPE)!
    .outputs.map((o) => o.name)
    .filter((n) => n !== 'watermark');
const failure = (events: ActivityEvent[]) => {
  const ev = last(events);
  if (ev.type !== 'failed') throw new Error(`expected failed, got ${JSON.stringify(ev)}`);
  return ev;
};
/** Each session log line without its timestamp. */
const logLines = (events: ActivityEvent[]) =>
  events.flatMap((e) =>
    e.type === 'output' && e.name === SESSION_LOG_OUTPUT
      ? [String(e.value).replace(/^\S+ /, '')]
      : [],
  );

describe('Copy · Files as-is — selection', () => {
  it('copies a folder by wildcard, into subfolders, preserving the hierarchy', async () => {
    await put('in/a.csv', 'aa');
    await put('in/b.txt', 'b');
    await put('in/sub/c.csv', 'ccc');
    const events = await run({ sourcePath: 'in', wildcard: '*.csv', sinkFolder: 'out' });
    const out = outputs(events);
    expect(out).toEqual({
      filesRead: 2,
      filesWritten: 2,
      filesSkipped: 0,
      filesDeleted: 0,
      filesMoved: 0,
      bytesRead: 5,
      bytesWritten: 5,
      // #1600 C1b — a folder copy names the folders.
      source: join(src, 'in'),
      dest: join(dst, 'out'),
      // #1600 OR41 C6f-1.
      durationMs: expect.any(Number),
      throughput: throughputOf(out),
      consistency: { verified: false, result: 'none' },
      // #1600 OR41 C6f-2 — Degree of copy parallelism defaults to 1.
      usedParallelCopies: 1,
      // #1600 OR41 C6c-1a — the session log went to the run log, not a file.
      logPath: null,
    });
    expect(Object.keys(out)).toEqual(declaredNames());
    expect(await tree(dst)).toEqual(['out/a.csv', 'out/sub/c.csv']);
    expect(await readFile(join(dst, 'out/sub/c.csv'), 'utf8')).toBe('ccc');
    // Keep source is the default.
    expect(await tree(src)).toEqual(['in/a.csv', 'in/b.txt', 'in/sub/c.csv']);
  });

  it('stays in the folder when Include subfolders is off, and ? matches one character', async () => {
    await put('in/a1.csv', '1');
    await put('in/a22.csv', '22');
    await put('in/sub/a3.csv', '3');
    await run({ sourcePath: 'in', wildcard: 'a?.csv', recursive: false });
    expect(await tree(dst)).toEqual(['a1.csv']);
  });

  it('never follows a symlink in the source, as a file or as a folder', async () => {
    const elsewhere = tempRoot('copy-files-else-');
    await put('secret.txt', 'secret', elsewhere);
    await put('in/a.txt', 'a');
    await symlink(join(elsewhere, 'secret.txt'), join(src, 'in/link.txt'));
    await symlink(elsewhere, join(src, 'in/linkdir'));
    await run({ sourcePath: 'in' });
    expect(await tree(dst)).toEqual(['a.txt']);
  });

  it('copies one file, under a new name that may include subfolders', async () => {
    await put('in/a.txt', 'hello');
    const events = await run({
      pathType: 'file',
      sourcePath: 'in/a.txt',
      sinkFolder: 'out',
      sinkFileName: 'x/renamed.txt',
    });
    expect(outputs(events)).toMatchObject({ filesWritten: 1, bytesWritten: 5 });
    expect(await tree(dst)).toEqual(['out/x/renamed.txt']);
  });

  it('copies the files a list names, relative to the source path', async () => {
    await put('in/a.txt', 'a');
    await put('in/sub/b.txt', 'b');
    await put('in/c.txt', 'c');
    await put('list.txt', 'a.txt\r\n\r\nsub/b.txt\na.txt\n');
    await run({ pathType: 'list', sourcePath: 'in', fileListPath: 'list.txt' });
    expect(await tree(dst)).toEqual(['a.txt', 'sub/b.txt']);
  });

  it.each([['../outside.txt'], ['/etc/hosts']])(
    'refuses a file-list line that leaves the source path (%s)',
    async (line) => {
      await put('outside.txt', 'x');
      await put('in/a.txt', 'a');
      await put('list.txt', `a.txt\n${line}\n`);
      const events = await run({ pathType: 'list', sourcePath: 'in', fileListPath: 'list.txt' });
      expect(failure(events)).toMatchObject({ kind: 'permanent' });
      expect(await tree(dst)).toEqual([]);
    },
  );

  it('refuses a file-list line that reaches outside the source path through a symlinked folder', async () => {
    // `other` is inside the connection's roots, so only the source-path check stops it.
    await put('other/x.txt', 'not in the source path');
    await put('in/a.txt', 'a');
    await symlink(join(src, 'other'), join(src, 'in/linkdir'));
    await put('list.txt', 'linkdir/x.txt\n');
    const events = await run({ pathType: 'list', sourcePath: 'in', fileListPath: 'list.txt' });
    expect(failure(events).error).toContain('leaves the source path');
    expect(await tree(dst)).toEqual([]);
  });

  it('selects by modified time: start inclusive, end exclusive', async () => {
    const at = (iso: string) => new Date(iso);
    for (const [name, iso] of [
      ['old.txt', '2026-01-01T00:00:00Z'],
      ['start.txt', '2026-02-01T00:00:00Z'],
      ['end.txt', '2026-03-01T00:00:00Z'],
    ] as const) {
      const path = await put(`in/${name}`, name);
      await utimes(path, at(iso), at(iso));
    }
    await run({
      sourcePath: 'in',
      modifiedStart: '2026-02-01T00:00:00Z',
      modifiedEnd: '2026-03-01T00:00:00Z',
    });
    expect(await tree(dst)).toEqual(['start.txt']);
  });

  it('refuses a window whose start is not before its end', async () => {
    await put('in/a.txt', 'a');
    const events = await run({
      sourcePath: 'in',
      modifiedStart: '2026-03-01T00:00:00Z',
      modifiedEnd: '2026-03-01T00:00:00Z',
    });
    expect(failure(events).kind).toBe('permanent');
  });

  it('bounds the whole walk, folders included, by the source maxEntries', async () => {
    await mkdir(join(src, 'in/d1'), { recursive: true });
    await mkdir(join(src, 'in/d2'), { recursive: true });
    await mkdir(join(src, 'in/d3'), { recursive: true });
    const events = await run({ sourcePath: 'in' }, { maxEntries: 2 });
    expect(failure(events)).toMatchObject({ kind: 'permanent' });
    expect(failure(events).error).toContain('2-entry limit');
  });

  it('copies nothing, successfully, when nothing matches', async () => {
    await put('in/a.txt', 'a');
    const events = await run({ sourcePath: 'in', wildcard: '*.csv' });
    expect(outputs(events)).toMatchObject({ filesRead: 0, filesWritten: 0 });
    // Its own success site, with the whole contract (C6f-1).
    expect(Object.keys(outputs(events))).toEqual(declaredNames());
  });

  it('refuses a source path outside the connection roots', async () => {
    const events = await run({ sourcePath: dst });
    expect(failure(events)).toMatchObject({ kind: 'permanent' });
  });
});

describe('Copy · Files as-is — sink', () => {
  it('flattens into one folder, and refuses two files that would land on one name', async () => {
    await put('in/a.txt', 'a');
    await put('in/sub/b.txt', 'b');
    await run({ sourcePath: 'in', copyBehavior: 'flatten', sinkFolder: 'out' });
    expect(await tree(dst)).toEqual(['out/a.txt', 'out/b.txt']);

    await put('in/sub/a.txt', 'second a');
    const events = await run({ sourcePath: 'in', copyBehavior: 'flatten', sinkFolder: 'again' });
    expect(failure(events)).toMatchObject({ kind: 'permanent' });
    // Refused while planning: nothing was written, not even the folder.
    expect(existsSync(join(dst, 'again'))).toBe(false);
  });

  it('refuses two names that differ only in case, rather than one overwriting the other', async () => {
    await put('in/A.txt', 'upper');
    await put('in/sub/a.txt', 'lower');
    const events = await run({ sourcePath: 'in', copyBehavior: 'flatten' });
    expect(failure(events).error).toContain('would both be written');
    // #1685 — and says why, since a case-sensitive sink could hold both.
    expect(failure(events).error).toContain('differ only in case');
    expect(await tree(dst)).toEqual([]);
  });

  it('merges every file into one, in path order', async () => {
    await put('in/b.txt', 'B');
    await put('in/a.txt', 'A');
    await put('in/sub/c.txt', 'C');
    const events = await run({ sourcePath: 'in', copyBehavior: 'merge', sinkFileName: 'all.txt' });
    expect(outputs(events)).toMatchObject({ filesRead: 3, filesWritten: 1, bytesWritten: 3 });
    expect(await readFile(join(dst, 'all.txt'), 'utf8')).toBe('ABC');
  });

  it('creates a sink folder that does not exist yet', async () => {
    await put('in/a.txt', 'a');
    await run({ sourcePath: 'in', sinkFolder: 'new/deep/out' });
    expect(await tree(dst)).toEqual(['new/deep/out/a.txt']);
  });

  it('refuses to write through a symlinked folder in the sink', async () => {
    const elsewhere = tempRoot('copy-files-else-');
    await put('in/sub/a.txt', 'a');
    await symlink(elsewhere, join(dst, 'sub'));
    const events = await run({ sourcePath: 'in' });
    expect(failure(events)).toMatchObject({ kind: 'permanent' });
    expect(await tree(elsewhere)).toEqual([]);
  });

  describe('If file exists', () => {
    beforeEach(async () => {
      await put('in/a.txt', 'new a');
      await put('in/b.txt', 'new b');
      // The SECOND file in path order, so a check made only at write time would
      // already have copied `a.txt` by the time it noticed.
      await put('b.txt', 'old b', dst);
    });

    it('Overwrite replaces the file (the default)', async () => {
      await run({ sourcePath: 'in' });
      expect(await readFile(join(dst, 'b.txt'), 'utf8')).toBe('new b');
    });

    it('Skip leaves it, counts it, and keeps its source even when After copy deletes', async () => {
      const events = await run(
        { sourcePath: 'in', ifExists: 'skip', afterCopy: 'delete' },
        { sourceWritable: true },
      );
      expect(outputs(events)).toMatchObject({ filesWritten: 1, filesSkipped: 1, filesDeleted: 1 });
      expect(await readFile(join(dst, 'b.txt'), 'utf8')).toBe('old b');
      expect(await tree(src)).toEqual(['in/b.txt']);
    });

    it('Fail refuses before writing anything', async () => {
      const events = await run({ sourcePath: 'in', ifExists: 'fail' });
      expect(failure(events)).toMatchObject({ kind: 'permanent' });
      expect(await tree(dst)).toEqual(['b.txt']);
    });
  });
});

describe('Copy · Files as-is — after copy', () => {
  it('Delete source removes each copied file', async () => {
    await put('in/a.txt', 'a');
    await put('in/sub/b.txt', 'b');
    const events = await run({ sourcePath: 'in', afterCopy: 'delete' }, { sourceWritable: true });
    expect(outputs(events)).toMatchObject({ filesWritten: 2, filesDeleted: 2 });
    expect(await tree(src)).toEqual([]);
    expect(await tree(dst)).toEqual(['a.txt', 'sub/b.txt']);
  });

  it('Move source to moves each copied file, keeping its subfolders', async () => {
    await put('in/a.txt', 'a');
    await put('in/sub/b.txt', 'b');
    const events = await run(
      { sourcePath: 'in', afterCopy: 'move', moveTo: 'done' },
      { sourceWritable: true },
    );
    expect(outputs(events)).toMatchObject({ filesWritten: 2, filesMoved: 2 });
    expect(await tree(src)).toEqual(['done/a.txt', 'done/sub/b.txt']);
  });

  it('refuses a move onto an existing file before copying anything', async () => {
    await put('in/a.txt', 'a');
    await put('done/a.txt', 'already here');
    const events = await run(
      { sourcePath: 'in', afterCopy: 'move', moveTo: 'done' },
      { sourceWritable: true },
    );
    expect(failure(events)).toMatchObject({ kind: 'permanent' });
    expect(await tree(dst)).toEqual([]);
    expect(await readFile(join(src, 'done/a.txt'), 'utf8')).toBe('already here');
  });
});

describe('Copy · Files as-is — data-loss guards', () => {
  it('refuses to copy a folder onto itself, so Delete source cannot destroy it', async () => {
    await put('in/a.txt', 'only copy');
    // One store on both ends: the sink connection shares the source's root.
    const events = await run(
      { sourcePath: 'in', sinkFolder: 'in', afterCopy: 'delete' },
      { sourceWritable: true, sinkRoot: src },
    );
    expect(failure(events).error).toContain('own source');
    expect(await readFile(join(src, 'in/a.txt'), 'utf8')).toBe('only copy');
  });

  it('refuses a target that is the source under another name (a hardlink)', async () => {
    await put('in/a.txt', 'only copy');
    await link(join(src, 'in/a.txt'), join(dst, 'a.txt'));
    const events = await run({ sourcePath: 'in', afterCopy: 'delete' }, { sourceWritable: true });
    expect(failure(events).error).toContain('own source');
    expect(await readFile(join(src, 'in/a.txt'), 'utf8')).toBe('only copy');
  });
});

describe('Copy · Files as-is — permissions and failures', () => {
  it('refuses a sink connection that does not allow writes', async () => {
    await put('in/a.txt', 'a');
    const events = await run({ sourcePath: 'in' }, { sinkWritable: false });
    expect(failure(events).error).toContain('Allow writes');
    expect(await tree(dst)).toEqual([]);
  });

  it.each([['delete'], ['move']])(
    'refuses After copy %s when the source connection does not allow writes',
    async (afterCopy) => {
      await put('in/a.txt', 'a');
      const events = await run({
        sourcePath: 'in',
        afterCopy,
        ...(afterCopy === 'move' && { moveTo: 'done' }),
      });
      expect(failure(events).error).toContain('source connection does not allow writes');
      expect(await tree(dst)).toEqual([]);
    },
  );

  it('refuses a sink that is not a file connection', async () => {
    await put('in/a.txt', 'a');
    const events = await run({ sourcePath: 'in' }, { sinkKind: 'sqlite' });
    expect(failure(events)).toMatchObject({ kind: 'permanent' });
  });

  it.skipIf(process.getuid?.() === 0)(
    'reports what it had copied before a failure part-way',
    async () => {
      await put('in/a.txt', 'a');
      // The SECOND file cannot be read, which nothing at plan time looks at.
      await chmod(await put('in/b.txt', 'b'), 0o000);
      const events = await run({ sourcePath: 'in' });
      expect(failure(events)).toMatchObject({ kind: 'permanent' });
      expect(events).toContainEqual({ type: 'output', name: 'filesWritten', value: 1 });
      expect(await tree(dst)).toEqual(['a.txt']);
    },
  );

  it('is cancelled by an abort', async () => {
    await put('in/a.txt', 'a');
    const ac = new AbortController();
    ac.abort();
    const events = await run({ sourcePath: 'in' }, { signal: ac.signal });
    expect(failure(events)).toMatchObject({ kind: 'cancelled' });
  });

  it('refuses an invalid config', async () => {
    const events = await run({ sourcePath: 'in', pathType: 'list' });
    expect(failure(events).error).toContain('file list path');
  });

  it('keeps each source’s permission bits; a merge keeps only the bits all share', async () => {
    await chmod(await put('in/secret.txt', 's'), 0o600);
    await chmod(await put('in/open.txt', 'o'), 0o644);
    outputs(await run({ sourcePath: 'in', sinkFolder: 'out' }));
    expect((await stat(join(dst, 'out/secret.txt'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dst, 'out/open.txt'))).mode & 0o777).toBe(0o644);
    outputs(
      await run({ sourcePath: 'in', sinkFolder: 'm', copyBehavior: 'merge', sinkFileName: 'all' }),
    );
    expect((await stat(join(dst, 'm/all'))).mode & 0o777).toBe(0o600);
  });
});

describe('Copy · Files as-is — review fixes (#1600 C1a)', () => {
  it('copies a name that starts with two dots; it is a name, not a way out', async () => {
    await put('in/..backup.txt', 'b');
    await put('in/..d/x.txt', 'x');
    outputs(await run({ sourcePath: 'in' }));
    expect(await tree(dst)).toEqual(['..backup.txt', '..d/x.txt']);
  });

  it('copies a file a list names twice only once, and merges a list in its own order', async () => {
    await put('in/b.txt', 'B');
    await put('in/a.txt', 'A');
    await put('list.txt', 'b.txt\n./b.txt\na.txt\n');
    const events = await run(
      {
        pathType: 'list',
        sourcePath: 'in',
        fileListPath: 'list.txt',
        copyBehavior: 'merge',
        sinkFileName: 'all.txt',
        afterCopy: 'delete',
      },
      { sourceWritable: true },
    );
    expect(outputs(events)).toMatchObject({ filesRead: 2, filesDeleted: 2 });
    expect(await readFile(join(dst, 'all.txt'), 'utf8')).toBe('BA');
  });

  it('creates no sink folder when nothing is selected', async () => {
    await put('in/a.txt', 'a');
    outputs(await run({ sourcePath: 'in', wildcard: '*.csv', sinkFolder: 'out/deep' }));
    expect(existsSync(join(dst, 'out'))).toBe(false);
  });

  it('leaves a source that changed after it was read', async () => {
    const path = await put('in/a.txt', 'aaa');
    const st = await lstat(path, { bigint: true });
    const s = { abs: path, rel: 'a.txt', dev: st.dev, ino: st.ino, mode: 0o644 };
    const stamp = { dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs, read: 3 };
    await expect(unchangedSince(s, stamp)).resolves.toBeUndefined();
    // Fewer bytes copied than the file held.
    await expect(unchangedSince(s, { ...stamp, read: 2 })).rejects.toThrow('left in place');
    // Written to after the read.
    await appendFile(path, 'more');
    await expect(unchangedSince(s, stamp)).rejects.toThrow('changed while it was copied');
    // Never read at all.
    await expect(unchangedSince(s, undefined)).rejects.toThrow('left in place');
  });

  it('matches a wildcard in linear time, where a regex would backtrack for seconds', () => {
    const m = wildcardMatcher('*a*a*a*a*a*a*a*a*a*a*b');
    const t0 = performance.now();
    expect(m('a'.repeat(200))).toBe(false);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(wildcardMatcher('*.csv')('x.csv')).toBe(true);
    expect(wildcardMatcher('*.csv')('x.csvx')).toBe(false);
    expect(wildcardMatcher('a?c*')('abc')).toBe(true);
    expect(wildcardMatcher('a?c')('ac')).toBe(false);
    expect(wildcardMatcher('**')('')).toBe(true);
    expect(wildcardMatcher('a.c')('abc')).toBe(false);
    expect(wildcardMatcher('*b*')('aaa')).toBe(false);
  });
});

describe('Copy · Files as-is — hardening (#1685)', () => {
  it('refuses at plan time a file standing where a sink folder must be made', async () => {
    await put('in/a.txt', 'a');
    await put('in/sub/b.txt', 'b');
    await writeFile(join(dst, 'sub'), 'not a folder');
    const events = await run({ sourcePath: 'in' });
    expect(failure(events)).toMatchObject({ kind: 'permanent' });
    expect(failure(events).error).toContain('is not a folder');
    // Nothing was written: not even `a.txt`, which comes first.
    expect(events.filter((e) => e.type === 'output')).toEqual([]);
    expect(await tree(dst)).toEqual(['sub']);
  });

  it('refuses at plan time a target that is a folder, in every If file exists mode', async () => {
    await put('in/a.txt', 'a');
    await put('in/b.txt', 'b');
    await mkdir(join(dst, 'b.txt'));
    for (const ifExists of ['overwrite', 'skip', 'fail'] as const) {
      const events = await run({ sourcePath: 'in', ifExists });
      expect(failure(events).error).toContain('is a folder');
      expect(await tree(dst)).toEqual([]);
    }
  });

  it('refuses at plan time a file standing where a Move to folder must be made', async () => {
    await put('in/sub/a.txt', 'a');
    await put('done/sub', 'not a folder');
    const events = await run(
      { sourcePath: 'in', afterCopy: 'move', moveTo: 'done' },
      { sourceWritable: true },
    );
    expect(failure(events)).toMatchObject({ kind: 'permanent' });
    expect(await tree(dst)).toEqual([]);
    expect(await tree(src)).toEqual(['done/sub', 'in/sub/a.txt']);
  });

  describe('Skip converges on a retry: an existing identical copy counts as copied', () => {
    beforeEach(async () => {
      await put('in/a.txt', 'new a');
      await put('in/b.txt', 'same b');
      // What an earlier attempt that failed before removing the source left.
      await put('b.txt', 'same b', dst);
    });

    it('Delete source removes a source whose copy is already there', async () => {
      const events = await run(
        { sourcePath: 'in', ifExists: 'skip', afterCopy: 'delete' },
        { sourceWritable: true },
      );
      expect(outputs(events)).toMatchObject({ filesWritten: 1, filesSkipped: 1, filesDeleted: 2 });
      expect(await tree(src)).toEqual([]);
      expect(await readFile(join(dst, 'b.txt'), 'utf8')).toBe('same b');
    });

    it('Move source to moves it', async () => {
      const events = await run(
        { sourcePath: 'in', ifExists: 'skip', afterCopy: 'move', moveTo: 'done' },
        { sourceWritable: true },
      );
      expect(outputs(events)).toMatchObject({ filesWritten: 1, filesSkipped: 1, filesMoved: 2 });
      expect(await tree(src)).toEqual(['done/a.txt', 'done/b.txt']);
    });

    it('keeps a source whose existing target is not a regular readable copy of it', async () => {
      const keeps = async () => {
        const events = await run(
          { sourcePath: 'in', ifExists: 'skip', afterCopy: 'delete' },
          { sourceWritable: true },
        );
        expect(outputs(events)).toMatchObject({ filesSkipped: 1, filesDeleted: 1 });
        expect(await tree(src)).toEqual(['in/b.txt']);
        // Back to the start for the next case: `a.txt` copied afresh.
        await rm(join(dst, 'a.txt'));
        await put('in/a.txt', 'new a');
      };
      // Longer, sharing the source's bytes as a prefix.
      await writeFile(join(dst, 'b.txt'), 'same b and more');
      await keeps();
      // A symlink to an identical file: never followed.
      await rm(join(dst, 'b.txt'));
      await writeFile(join(dst, 'twin'), 'same b');
      await symlink(join(dst, 'twin'), join(dst, 'b.txt'));
      await keeps();
      // A FIFO: must neither block nor fail the copy.
      await rm(join(dst, 'b.txt'));
      execFileSync('mkfifo', [join(dst, 'b.txt')]);
      await keeps();
    });

    it('keeps a source whose existing target has the same size but other bytes', async () => {
      await writeFile(join(dst, 'b.txt'), 'diff b');
      const events = await run(
        { sourcePath: 'in', ifExists: 'skip', afterCopy: 'delete' },
        { sourceWritable: true },
      );
      expect(outputs(events)).toMatchObject({ filesSkipped: 1, filesDeleted: 1 });
      expect(await tree(src)).toEqual(['in/b.txt']);
      expect(await readFile(join(dst, 'b.txt'), 'utf8')).toBe('diff b');
    });
  });

  it('copies a file whose name leaves no room for a temp suffix', async () => {
    const name = `${'x'.repeat(250)}.txt`;
    await put(`in/${name}`, 'long');
    const events = await run({ sourcePath: 'in' });
    expect(outputs(events)).toMatchObject({ filesWritten: 1 });
    expect(await tree(dst)).toEqual([name]);
  });

  it('keeps a readable start of a too-long name in its temp, cut on a character', () => {
    const ascii = basename(tmpPathFor(join(dst, 'x'.repeat(300)), 'run_1.n1.n1_0'));
    expect(ascii).toMatch(/^\.x{100}\.[0-9a-f]{40}\.tmp$/);
    const wide = basename(tmpPathFor(join(dst, 'é'.repeat(200)), 'run_1.n1.n1_0'));
    // Two bytes each: 50 fit in the 100-byte prefix, and none is split.
    expect(wide).toMatch(/^\.é{50}\.[0-9a-f]{40}\.tmp$/);
    expect(Buffer.byteLength(wide)).toBeLessThanOrEqual(255);
    // A name that fits keeps the plain form.
    expect(tmpPathFor(join(dst, 'a.txt'), 's')).toBe(join(dst, 'a.txt.tmp.s'));
  });

  it('reports a refusal made after an abort as cancelled', async () => {
    // Straight to the copy: the adapter answers an abort it sees before the
    // dispatch itself, so only an abort landing mid-plan reaches this path.
    const ac = new AbortController();
    ac.abort();
    const events: ActivityEvent[] = [];
    const ctx: ActivityContext = {
      runId: 'run_1',
      nodeId: 'n1',
      attemptId: 'n1#0',
      activityType: COPY_FILES_ACTIVITY_TYPE,
      input: { sourcePath: 'missing' },
      connectionConfig: {},
      sink: { kind: 'fs', connectionConfig: { roots: [dst], writable: true } },
      signal: ac.signal,
    };
    for await (const ev of runFilesCopy(ctx, { roots: [src] })) events.push(ev);
    expect(failure(events)).toMatchObject({ kind: 'cancelled' });
  });

  it('refuses a sink file and a Move to folder planned at one path', async () => {
    // The two connections share a root, so the copy of `x` and the Move to
    // folder are one path; neither exists yet, so only the plan can see it.
    await put('in/x', 'x');
    const events = await run(
      { sourcePath: 'in', sinkFolder: 'out', afterCopy: 'move', moveTo: 'out/x' },
      { sourceWritable: true, sinkRoot: src },
    );
    expect(failure(events).error).toContain('two things');
    expect(await tree(src)).toEqual(['in/x']);
    expect(existsSync(join(src, 'out'))).toBe(false);
  });

  it('finishes a move a failed attempt had linked but not removed', async () => {
    await put('in/a.txt', 'a');
    await mkdir(join(src, 'done'));
    await link(join(src, 'in/a.txt'), join(src, 'done/a.txt'));
    const events = await run(
      { sourcePath: 'in', afterCopy: 'move', moveTo: 'done' },
      { sourceWritable: true },
    );
    expect(outputs(events)).toMatchObject({ filesWritten: 1, filesMoved: 1 });
    expect(await tree(src)).toEqual(['done/a.txt']);
    expect(await tree(dst)).toEqual(['a.txt']);
  });
});

describe('#1600 C1b — source and dest outputs', () => {
  it('one file names the file read and the file written', async () => {
    await put('in/a.csv', 'aa');
    const events = await run({
      pathType: 'file',
      sourcePath: 'in/a.csv',
      sinkFolder: 'out',
      sinkFileName: 'b/x.csv',
    });
    expect(outputs(events)).toMatchObject({
      source: join(src, 'in/a.csv'),
      dest: join(dst, 'out/b/x.csv'),
    });
  });

  it('a merge names the merged file', async () => {
    await put('in/a.csv', 'a');
    await put('in/b.csv', 'b');
    const events = await run({ sourcePath: 'in', copyBehavior: 'merge', sinkFileName: 'all.csv' });
    expect(outputs(events)).toMatchObject({ source: join(src, 'in'), dest: join(dst, 'all.csv') });
  });

  it('names them when the window selects nothing, so the declared outputs are met', async () => {
    const path = await put('in/a.csv', 'a');
    await utimes(path, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    const events = await run({
      pathType: 'file',
      sourcePath: 'in/a.csv',
      modifiedStart: '2026-01-01T00:00:00Z',
    });
    expect(outputs(events)).toMatchObject({ filesRead: 0, source: path, dest: join(dst, 'a.csv') });
  });
});

/**
 * #1600 C1b — a stored `file_copy`/`file_move` opens in the editor as its
 * lowering and, once saved, runs as `copy_files`. Both run here on one
 * connection that allows writes: the lowered node writes the same bytes to the
 * same file and answers the retired outputs with the same values.
 */
describe('#1600 C1b — a lowered file_copy / file_move runs as the retired type did', () => {
  async function dispatch(
    activityType: string,
    input: Record<string, unknown>,
    writable: boolean,
    paired: boolean,
  ): Promise<ActivityEvent[]> {
    const connectionConfig = { roots: [src], ...(writable && { writable: true }) };
    const c: ActivityContext = {
      runId: 'run_1',
      nodeId: 'n1',
      attemptId: 'n1#0',
      activityType,
      input,
      connectionConfig,
      ...(paired && { sink: { kind: 'fs' as const, connectionConfig } }),
      signal: new AbortController().signal,
    };
    const out: ActivityEvent[] = [];
    for await (const ev of fsAdapter.runActivity(c, null)) out.push(ev);
    return out;
  }
  const lowered = (type: string, config: Record<string, unknown>) => {
    const node = lowerRetiredTypes({
      nodes: [{ id: 'n1', type, config, connectionId: 'c', position: { x: 0, y: 0 } } as Node],
      containers: [],
    }).nodes[0]!;
    expect(node.type).toBe(COPY_FILES_ACTIVITY_TYPE);
    const input = { ...node.config };
    delete input['outputs'];
    return input;
  };

  it.each([
    ['a relative destination', 'out/x.csv'],
    ['an absolute destination', '<root>/out/x.csv'],
  ])('file_copy, %s', async (_why, destTemplate) => {
    await put('in/a.csv', 'payload');
    await mkdir(join(src, 'out'));
    const dest = destTemplate.replace('<root>', src);
    const old = outputs(
      await dispatch(FILE_COPY_ACTIVITY_TYPE, { source: 'in/a.csv', dest }, false, false),
    );
    const before = await readFile(join(src, 'out/x.csv'), 'utf8');
    await rm(join(src, 'out/x.csv'));
    const now = outputs(
      await dispatch(
        COPY_FILES_ACTIVITY_TYPE,
        lowered(FILE_COPY_ACTIVITY_TYPE, { source: 'in/a.csv', dest }),
        true,
        true,
      ),
    );
    expect(await readFile(join(src, 'out/x.csv'), 'utf8')).toBe(before);
    expect({ bytesWritten: now.bytesWritten, source: now.source, dest: now.dest }).toEqual(old);
    expect(await tree(src)).toEqual(['in/a.csv', 'out/x.csv']);
  });

  it('file_move', async () => {
    await put('in/a.csv', 'payload');
    await mkdir(join(src, 'out'));
    const config = { source: 'in/a.csv', dest: 'out/x.csv' };
    const old = outputs(await dispatch(FILE_MOVE_ACTIVITY_TYPE, config, false, false));
    expect(await tree(src)).toEqual(['out/x.csv']);
    await rm(join(src, 'out/x.csv'));
    await put('in/a.csv', 'payload');
    const now = outputs(
      await dispatch(
        COPY_FILES_ACTIVITY_TYPE,
        lowered(FILE_MOVE_ACTIVITY_TYPE, config),
        true,
        true,
      ),
    );
    expect(await tree(src)).toEqual(['out/x.csv']);
    expect(await readFile(join(src, 'out/x.csv'), 'utf8')).toBe('payload');
    expect({ source: now.source, dest: now.dest }).toEqual(old);
  });

  it('the stored retired type still runs on a connection that never allowed writes', async () => {
    await put('in/a.csv', 'payload');
    const events = await dispatch(
      FILE_COPY_ACTIVITY_TYPE,
      { source: 'in/a.csv', dest: 'b.csv' },
      false,
      false,
    );
    expect(last(events).type).toBe('succeeded');
  });
});

/**
 * #1600 OR41 C6b — a files-as-is Copy's session log, to the run log (catalogue
 * §4.1, §5; ADF's copy log, https://learn.microsoft.com/azure/data-factory/copy-activity-log):
 * Everything logs a `FileRead` per source and a `FileWrite` per file written,
 * Warnings only each `FileSkip`. The lines are `node.output sessionLog`, at the
 * terminal, ahead of a failure's counters.
 */
describe('#1600 C6b — session log', () => {
  it('Everything logs each file read and written, before the success', async () => {
    await put('in/a.txt', 'aaa');
    await put('in/sub/b.txt', 'b');
    const events = await run({ sourcePath: 'in', logLevel: 'info' });
    expect(logLines(events)).toEqual([
      'Info FileRead a.txt read 3 bytes',
      "Info FileWrite a.txt wrote 3 bytes from 'a.txt'",
      'Info FileRead sub/b.txt read 1 byte',
      "Info FileWrite sub/b.txt wrote 1 byte from 'sub/b.txt'",
    ]);
    expect(last(events).type).toBe('succeeded');
  });

  it('a merge logs each source read and the one file written', async () => {
    await put('in/a.txt', 'aa');
    await put('in/b.txt', 'b');
    const events = await run({
      sourcePath: 'in',
      copyBehavior: 'merge',
      sinkFileName: 'all/joined.txt',
      logLevel: 'info',
    });
    expect(logLines(events)).toEqual([
      'Info FileRead a.txt read 2 bytes',
      'Info FileRead b.txt read 1 byte',
      'Info FileWrite all/joined.txt wrote 3 bytes merged from 2 files',
    ]);
  });

  it('Warnings, the default, logs nothing for files copied', async () => {
    await put('in/a.txt', 'a');
    expect(logLines(await run({ sourcePath: 'in' }))).toEqual([]);
  });

  it('logs nothing when nothing is selected', async () => {
    await put('in/a.txt', 'a');
    const events = await run({ sourcePath: 'in', wildcard: '*.csv', logLevel: 'info' });
    expect(logLines(events)).toEqual([]);
    expect(last(events).type).toBe('succeeded');
  });

  describe('a skipped file', () => {
    beforeEach(async () => {
      await put('in/a.txt', 'new a');
      await put('in/b.txt', 'new b');
      await put('b.txt', 'old b', dst);
    });

    it('Warnings logs it with why, and that its source is kept', async () => {
      const events = await run(
        { sourcePath: 'in', ifExists: 'skip', afterCopy: 'delete' },
        { sourceWritable: true },
      );
      expect(logLines(events)).toEqual([
        "Warning FileSkip b.txt skipped: 'b.txt' already exists and If file exists is Skip; the source is kept",
      ]);
      expect(outputs(events)).toMatchObject({ filesSkipped: 1 });
    });

    it('with After copy Keep, it says nothing about the source', async () => {
      const events = await run({ sourcePath: 'in', ifExists: 'skip' });
      expect(logLines(events)).toEqual([
        "Warning FileSkip b.txt skipped: 'b.txt' already exists and If file exists is Skip",
      ]);
    });

    it('Off logs nothing', async () => {
      const events = await run({ sourcePath: 'in', ifExists: 'skip', logLevel: 'off' });
      expect(logLines(events)).toEqual([]);
      expect(outputs(events)).toMatchObject({ filesSkipped: 1 });
    });

    it('a merge logs every source it skipped', async () => {
      await put('all.txt', 'old', dst);
      const events = await run({
        sourcePath: 'in',
        copyBehavior: 'merge',
        sinkFileName: 'all.txt',
        ifExists: 'skip',
      });
      expect(logLines(events)).toEqual([
        "Warning FileSkip a.txt skipped: 'all.txt' already exists and If file exists is Skip",
        "Warning FileSkip b.txt skipped: 'all.txt' already exists and If file exists is Skip",
      ]);
      expect(outputs(events)).toMatchObject({ filesSkipped: 2 });
    });

    it('a merge skipped under Delete source says each source is kept', async () => {
      await put('all.txt', 'old', dst);
      const events = await run(
        {
          sourcePath: 'in',
          copyBehavior: 'merge',
          sinkFileName: 'all.txt',
          ifExists: 'skip',
          afterCopy: 'delete',
        },
        { sourceWritable: true },
      );
      expect(logLines(events)).toEqual([
        "Warning FileSkip a.txt skipped: 'all.txt' already exists and If file exists is Skip; the source is kept",
        "Warning FileSkip b.txt skipped: 'all.txt' already exists and If file exists is Skip; the source is kept",
      ]);
      expect(await tree(src)).toEqual(['in/a.txt', 'in/b.txt']);
    });
  });

  it('a skipped copy that already holds the source bytes says After copy still applies', async () => {
    await put('in/b.txt', 'same b');
    await put('b.txt', 'same b', dst);
    const events = await run(
      { sourcePath: 'in', ifExists: 'skip', afterCopy: 'delete' },
      { sourceWritable: true },
    );
    expect(logLines(events)).toEqual([
      "Warning FileSkip b.txt skipped: 'b.txt' already exists and If file exists is Skip; it holds this file's bytes, so After copy still applies",
    ]);
    expect(outputs(events)).toMatchObject({ filesSkipped: 1, filesDeleted: 1 });
  });

  it.skipIf(process.getuid?.() === 0)(
    'a skip whose byte comparison fails part-way still logs its line',
    async () => {
      await chmod(await put('in/b.txt', 'same b'), 0o000);
      await put('b.txt', 'same b', dst);
      const events = await run(
        { sourcePath: 'in', ifExists: 'skip', afterCopy: 'delete' },
        { sourceWritable: true },
      );
      expect(failure(events)).toBeDefined();
      expect(logLines(events)).toEqual([
        "Warning FileSkip b.txt skipped: 'b.txt' already exists and If file exists is Skip",
      ]);
      expect(events).toContainEqual({ type: 'output', name: 'filesSkipped', value: 1 });
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'a failure part-way keeps the lines logged, ahead of the counters',
    async () => {
      await put('in/a.txt', 'a');
      await chmod(await put('in/b.txt', 'b'), 0o000);
      const events = await run({ sourcePath: 'in', logLevel: 'info' });
      expect(failure(events)).toMatchObject({ kind: 'permanent' });
      expect(logLines(events)).toEqual([
        'Info FileRead a.txt read 1 byte',
        "Info FileWrite a.txt wrote 1 byte from 'a.txt'",
      ]);
      const firstLine = events.findIndex(
        (e) => e.type === 'output' && e.name === SESSION_LOG_OUTPUT,
      );
      const firstCounter = events.findIndex(
        (e) => e.type === 'output' && e.name === 'filesWritten',
      );
      expect(firstLine).toBeGreaterThanOrEqual(0);
      expect(firstLine).toBeLessThan(firstCounter);
    },
  );

  it(`keeps ${SESSION_LOG_RUN_MAX_LINES} lines and counts the rest, pointing at a folder (C6c-1a)`, async () => {
    const n = SESSION_LOG_RUN_MAX_LINES / 2 + 1;
    for (let i = 0; i < n; i += 1) await put(`in/${String(i).padStart(4, '0')}.txt`, 'x');
    const lines = logLines(await run({ sourcePath: 'in', logLevel: 'info' }));
    expect(lines).toHaveLength(SESSION_LOG_RUN_MAX_LINES + 1);
    expect(lines[SESSION_LOG_RUN_MAX_LINES]).toBe(
      'Warning SessionLog  2 more lines not kept in the run log; write the session log to a folder to keep every line',
    );
  });
});

/**
 * #1600 OR41 C6d-2 — fault tolerance on a source of several files (ADF's
 * `skipErrorFile`, https://learn.microsoft.com/azure/data-factory/copy-activity-fault-tolerance):
 * Skip forbidden files skips a file or subfolder the connection may not read,
 * logged as a `FileSkip` and counted when it is a file. The races Skip missing
 * files covers are in `fs-files-copy-interleave.test.ts`.
 */
describe('#1600 C6d-2 — Skip forbidden files', () => {
  const asRoot = process.getuid?.() === 0;

  it.skipIf(asRoot)('skips and logs a file it may not read, and copies the rest', async () => {
    await put('in/a.txt', 'a');
    await chmod(await put('in/b.txt', 'b'), 0o000);
    const events = await run({ sourcePath: 'in', sinkFolder: 'out', skipForbiddenFiles: true });
    expect(outputs(events)).toMatchObject({ filesRead: 1, filesWritten: 1, filesSkipped: 1 });
    expect(await tree(dst)).toEqual(['out/a.txt']);
    expect(logLines(events)).toEqual([
      'Warning FileSkip b.txt skipped: permission denied and Skip forbidden files is on',
    ]);
  });

  it.skipIf(asRoot)('off, the default, fails on that file', async () => {
    await put('in/a.txt', 'a');
    await chmod(await put('in/b.txt', 'b'), 0o000);
    expect(failure(await run({ sourcePath: 'in' }))).toMatchObject({ kind: 'permanent' });
  });

  it.skipIf(asRoot)('skips a subfolder it may not list, logged and not counted', async () => {
    await put('in/a.txt', 'a');
    await put('in/locked/c.txt', 'c');
    await chmod(join(src, 'in/locked'), 0o000);
    try {
      const events = await run({ sourcePath: 'in', skipForbiddenFiles: true });
      expect(outputs(events)).toMatchObject({ filesWritten: 1, filesSkipped: 0 });
      expect(logLines(events)).toEqual([
        'Warning FileSkip locked skipped: folder permission denied and Skip forbidden files is on',
      ]);
      expect(failure(await run({ sourcePath: 'in' }))).toBeDefined();
    } finally {
      await chmod(join(src, 'in/locked'), 0o755);
    }
  });

  it.skipIf(asRoot)(
    'a merge leaves the forbidden file out, with the bits of the files it holds',
    async () => {
      await chmod(await put('in/a.txt', 'aa'), 0o644);
      await chmod(await put('in/b.txt', 'b'), 0o000);
      await chmod(await put('in/c.txt', 'c'), 0o644);
      const events = await run({
        sourcePath: 'in',
        copyBehavior: 'merge',
        sinkFileName: 'all.txt',
        skipForbiddenFiles: true,
        logLevel: 'info',
      });
      expect(outputs(events)).toMatchObject({ filesRead: 2, filesWritten: 1, filesSkipped: 1 });
      expect(await readFile(join(dst, 'all.txt'), 'utf8')).toBe('aac');
      expect((await stat(join(dst, 'all.txt'))).mode & 0o777).toBe(0o644);
      expect(logLines(events)).toEqual([
        'Warning FileSkip b.txt skipped: permission denied and Skip forbidden files is on',
        'Info FileRead a.txt read 2 bytes',
        'Info FileRead c.txt read 1 byte',
        'Info FileWrite all.txt wrote 3 bytes merged from 2 files',
      ]);
    },
  );

  it.skipIf(asRoot)('After copy Delete removes only the files it copied', async () => {
    await put('in/a.txt', 'a');
    await chmod(await put('in/b.txt', 'b'), 0o000);
    const events = await run(
      { sourcePath: 'in', afterCopy: 'delete', skipForbiddenFiles: true },
      { sourceWritable: true },
    );
    expect(outputs(events)).toMatchObject({ filesDeleted: 1, filesSkipped: 1 });
    expect(await tree(join(src, 'in'))).toEqual(['b.txt']);
  });

  it.skipIf(asRoot)('skips a file-list line inside a folder it may not search', async () => {
    await put('in/a.txt', 'a');
    await put('in/locked/c.txt', 'c');
    await put('list.txt', 'a.txt\nlocked/c.txt\n');
    await chmod(join(src, 'in/locked'), 0o000);
    try {
      const cfg = { sourcePath: 'in', pathType: 'list', fileListPath: 'list.txt' };
      const events = await run({ ...cfg, skipForbiddenFiles: true });
      expect(outputs(events)).toMatchObject({ filesWritten: 1, filesSkipped: 1 });
      expect(logLines(events)).toEqual([
        'Warning FileSkip locked/c.txt skipped: permission denied and Skip forbidden files is on',
      ]);
      expect(failure(await run(cfg))).toBeDefined();
    } finally {
      await chmod(join(src, 'in/locked'), 0o755);
    }
  });

  it.skipIf(asRoot)('skips a forbidden file once when two list lines name it', async () => {
    await put('in/locked/c.txt', 'c');
    await put('list.txt', 'locked/c.txt\n./locked/c.txt\n');
    await chmod(join(src, 'in/locked'), 0o000);
    try {
      const events = await run({
        sourcePath: 'in',
        pathType: 'list',
        fileListPath: 'list.txt',
        skipForbiddenFiles: true,
      });
      expect(outputs(events)).toMatchObject({ filesWritten: 0, filesSkipped: 1 });
      expect(logLines(events)).toHaveLength(1);
    } finally {
      await chmod(join(src, 'in/locked'), 0o755);
    }
  });

  it.skipIf(asRoot)('never skips the source folder itself', async () => {
    await put('in/a.txt', 'a');
    await chmod(join(src, 'in'), 0o000);
    try {
      const events = await run({ sourcePath: 'in', skipForbiddenFiles: true });
      expect(failure(events).error).toContain('EACCES');
    } finally {
      await chmod(join(src, 'in'), 0o755);
    }
  });

  it.skipIf(asRoot)('If file exists = Skip keeps a source it may not read to compare', async () => {
    await chmod(await put('in/b.txt', 'b'), 0o000);
    await put('b.txt', 'b', dst);
    const events = await run(
      { sourcePath: 'in', ifExists: 'skip', afterCopy: 'delete', skipForbiddenFiles: true },
      { sourceWritable: true },
    );
    expect(outputs(events)).toMatchObject({ filesSkipped: 1, filesDeleted: 0 });
    expect(logLines(events)).toEqual([
      "Warning FileSkip b.txt skipped: 'b.txt' already exists and If file exists is Skip; its source could not be read: permission denied and Skip forbidden files is on",
    ]);
    expect(await tree(join(src, 'in'))).toEqual(['b.txt']);
  });

  // #1777 — a target's sources are opened before a sink folder is made for
  // them, so one whose every source is skipped leaves no empty folder behind.
  it.skipIf(asRoot)('makes no sink subfolder for a file it skips', async () => {
    await put('in/a.txt', 'a');
    await chmod(await put('in/sub/b.txt', 'b'), 0o000);
    const events = await run({ sourcePath: 'in', sinkFolder: 'out', skipForbiddenFiles: true });
    expect(outputs(events)).toMatchObject({ filesWritten: 1, filesSkipped: 1 });
    expect(await readdir(join(dst, 'out'))).toEqual(['a.txt']);
  });

  it.skipIf(asRoot)('still makes the subfolder for the files of it it copies', async () => {
    await chmod(await put('in/sub/b.txt', 'b'), 0o000);
    await put('in/sub/c.txt', 'c');
    const events = await run({ sourcePath: 'in', skipForbiddenFiles: true, logLevel: 'info' });
    expect(outputs(events)).toMatchObject({ filesWritten: 1, filesSkipped: 1 });
    expect(await tree(dst)).toEqual(['sub/c.txt']);
    // The open before the folder is made is not a second read or skip.
    expect(logLines(events)).toEqual([
      'Warning FileSkip sub/b.txt skipped: permission denied and Skip forbidden files is on',
      'Info FileRead sub/c.txt read 1 byte',
      "Info FileWrite sub/c.txt wrote 1 byte from 'sub/c.txt'",
    ]);
  });

  it.skipIf(asRoot)('makes no File name subfolder for a merge it skips whole', async () => {
    await chmod(await put('in/a.txt', 'a'), 0o000);
    await chmod(await put('in/b.txt', 'b'), 0o000);
    const events = await run({
      sourcePath: 'in',
      copyBehavior: 'merge',
      sinkFileName: 'x/all.txt',
      skipForbiddenFiles: true,
    });
    expect(outputs(events)).toMatchObject({ filesWritten: 0, filesSkipped: 2 });
    expect(logLines(events)).toHaveLength(2);
    expect(await readdir(dst)).toEqual([]);
  });

  it.skipIf(asRoot)('a merge into a new File name subfolder skips a source once', async () => {
    await put('in/a.txt', 'a');
    await chmod(await put('in/b.txt', 'b'), 0o000);
    const events = await run({
      sourcePath: 'in',
      copyBehavior: 'merge',
      sinkFileName: 'x/all.txt',
      skipForbiddenFiles: true,
    });
    // Opened before `x` is made, and not again by the merge's own probe.
    expect(outputs(events)).toMatchObject({ filesWritten: 1, filesSkipped: 1 });
    expect(logLines(events)).toHaveLength(1);
    expect(await readFile(join(dst, 'x/all.txt'), 'utf8')).toBe('a');
  });

  it('still refuses a file-list line naming a file that is not there', async () => {
    await put('in/a.txt', 'a');
    await put('list.txt', 'a.txt\nnope.txt\n');
    const events = await run({ sourcePath: 'in', pathType: 'list', fileListPath: 'list.txt' });
    expect(failure(events).error).toContain("file list path 'nope.txt' does not exist");
  });
});

describe('#1600 OR41 C6f-2 — Degree of copy parallelism', () => {
  it('copies every file, and uses no more copies than there are files', async () => {
    await put('in/a.txt', 'aa');
    await put('in/b.txt', 'b');
    const out = outputs(await run({ sourcePath: 'in', sinkFolder: 'out', parallelCopies: 8 }));
    expect(out).toMatchObject({ filesRead: 2, filesWritten: 2, bytesWritten: 3 });
    expect(out['usedParallelCopies']).toBe(2);
    expect(await tree(dst)).toEqual(['out/a.txt', 'out/b.txt']);
  });

  it('uses the degree it is given when there are more files', async () => {
    for (const n of [1, 2, 3, 4, 5]) await put(`in/f${n}.txt`, String(n));
    const out = outputs(await run({ sourcePath: 'in', parallelCopies: 3 }));
    expect(out).toMatchObject({ filesWritten: 5, usedParallelCopies: 3 });
  });

  it('reports one copy when nothing is selected', async () => {
    await mkdir(join(src, 'in'), { recursive: true });
    const out = outputs(await run({ sourcePath: 'in', parallelCopies: 4 }));
    expect(out).toMatchObject({ filesWritten: 0, usedParallelCopies: 1 });
  });

  it('refuses more than one copy under Merge', async () => {
    await put('in/a.txt', 'a');
    const events = await run({
      sourcePath: 'in',
      copyBehavior: 'merge',
      sinkFileName: 'all.txt',
      parallelCopies: 2,
    });
    expect(failure(events)).toMatchObject({ kind: 'permanent' });
    expect(failure(events).error).toContain('a merge writes one file');
  });

  it('moves files that share new folders, many at once, and every one lands', async () => {
    const rels = ['a/b/1.txt', 'a/b/2.txt', 'a/c/3.txt', 'a/c/4.txt', 'a/5.txt', 'd/6.txt'];
    for (const rel of rels) await put(`in/${rel}`, rel);
    const events = await run(
      {
        sourcePath: 'in',
        sinkFolder: 'out/deep',
        afterCopy: 'move',
        moveTo: 'done/x',
        parallelCopies: 6,
      },
      { sourceWritable: true },
    );
    expect(outputs(events)).toMatchObject({
      filesWritten: 6,
      filesMoved: 6,
      usedParallelCopies: 6,
    });
    expect(await tree(dst)).toEqual(rels.map((r) => `out/deep/${r}`).sort());
    expect(await tree(src)).toEqual(rels.map((r) => `done/x/${r}`).sort());
    for (const rel of rels) expect(await readFile(join(dst, 'out/deep', rel), 'utf8')).toBe(rel);
  });

  it('fails with what it copied when one of several files fails', async () => {
    if (process.getuid?.() === 0) return;
    await put('in/a.txt', 'a');
    await chmod(await put('in/b.txt', 'b'), 0o000);
    await put('in/c.txt', 'c');
    const events = await run({ sourcePath: 'in', parallelCopies: 3 });
    expect(failure(events)).toMatchObject({ kind: 'permanent' });
    expect(failure(events).error).toContain('EACCES');
    expect(events).toContainEqual({ type: 'output', name: 'usedParallelCopies', value: 3 });
    // The copies already under way when b failed finish, and are counted.
    const written = events.find((e) => e.type === 'output' && e.name === 'filesWritten');
    expect(written).toMatchObject({ value: (await tree(dst)).length });
  });
});

/**
 * #1600 OR41 C6c-1a — Write to Folder: the session log is written, every line,
 * to a CSV file in a folder on the log connection (ADF's `logLocationSettings`),
 * and `logPath` names it. The file is the attempt's own.
 */
describe('#1600 C6c-1a — session log to a folder', () => {
  let logs: string;
  beforeEach(async () => {
    logs = tempRoot('copy-files-log-');
    await mkdir(join(logs, 'runs'));
  });
  const toFolder = { logTo: 'folder', logFolder: 'runs' };
  const FILE = 'session-log.run_1.n1.n1_0.csv';
  const csv = async () =>
    (await readFile(join(logs, 'runs', FILE), 'utf8'))
      .replace(/^\uFEFF/, '')
      .split('\r\n')
      .filter((l) => l !== '')
      .map((l) => l.replace(/^[^,]+,/, ''));

  it('writes every line to the folder, not the run log, and names the file in logPath', async () => {
    await put('in/a.txt', 'aaa');
    await put('in/sub/b.txt', 'b');
    const events = await run(
      { sourcePath: 'in', logLevel: 'info', ...toFolder },
      { log: { root: logs } },
    );
    expect(outputs(events)['logPath']).toBe(join(logs, 'runs', FILE));
    expect(logLines(events)).toEqual([]);
    expect(await csv()).toEqual([
      'Level,Operation,Item,Message',
      'Info,FileRead,a.txt,read 3 bytes',
      "Info,FileWrite,a.txt,wrote 3 bytes from 'a.txt'",
      'Info,FileRead,sub/b.txt,read 1 byte',
      "Info,FileWrite,sub/b.txt,wrote 1 byte from 'sub/b.txt'",
    ]);
    expect(await tree(dst)).toEqual(['a.txt', 'sub/b.txt']);
  });

  it('keeps every line past the run log’s cap', async () => {
    const n = SESSION_LOG_RUN_MAX_LINES / 2 + 1;
    for (let i = 0; i < n; i += 1) await put(`in/${String(i).padStart(4, '0')}.txt`, 'x');
    const events = await run(
      { sourcePath: 'in', logLevel: 'info', ...toFolder },
      { log: { root: logs } },
    );
    expect(last(events).type).toBe('succeeded');
    // The header, then two lines a file, none dropped.
    expect(await csv()).toHaveLength(1 + 2 * n);
  });

  it('writes a header-only file when nothing is selected', async () => {
    await mkdir(join(src, 'in'));
    const events = await run({ sourcePath: 'in', ...toFolder }, { log: { root: logs } });
    expect(outputs(events)['logPath']).toBe(join(logs, 'runs', FILE));
    expect(await csv()).toEqual(['Level,Operation,Item,Message']);
  });

  it('keeps the log of a copy that fails after it is opened', async () => {
    await put('in/a.txt', 'a');
    await put('out/a.txt', 'old', dst);
    const events = await run(
      { sourcePath: 'in', sinkFolder: 'out', ifExists: 'fail', ...toFolder },
      { log: { root: logs } },
    );
    expect(last(events)).toMatchObject({ type: 'failed', kind: 'permanent' });
    // The file ends with why: it is read without the node's error beside it.
    const error = (last(events) as { error: string }).error;
    expect(error).toMatch(/already exists and If file exists is Fail/);
    expect(await csv()).toEqual(['Level,Operation,Item,Message', `Error,Copy,,${error}`]);
  });

  it('keeps the log of a cancelled copy, ending with the cancel', async () => {
    // Straight to the copy, as the abort test above: the adapter answers an
    // abort it sees before dispatch, so only one landing mid-plan gets here.
    await put('in/a.txt', 'a');
    const ac = new AbortController();
    ac.abort();
    const ctx: ActivityContext = {
      runId: 'run_1',
      nodeId: 'n1',
      attemptId: 'n1#0',
      activityType: COPY_FILES_ACTIVITY_TYPE,
      input: { sourcePath: 'in', ...toFolder },
      connectionConfig: {},
      sink: { kind: 'fs', connectionConfig: { roots: [dst], writable: true } },
      logConnection: { kind: 'fs', connectionConfig: { roots: [logs], writable: true } },
      signal: ac.signal,
    };
    const events: ActivityEvent[] = [];
    for await (const ev of runFilesCopy(ctx, { roots: [src] })) events.push(ev);
    expect(last(events)).toMatchObject({ type: 'failed', kind: 'cancelled' });
    const rows = await csv();
    expect(rows[0]).toBe('Level,Operation,Item,Message');
    expect(rows.slice(1).map((r) => r.split(',').slice(0, 2).join(','))).toEqual(['Error,Copy']);
    expect(await tree(dst)).toEqual([]);
  });

  it('stops before the next file once the log can no longer be written', async () => {
    await put('in/a.txt', 'a');
    await put('in/b.txt', 'b');
    const spy = vi
      .spyOn(SessionLogWriter.prototype, 'failure', 'get')
      .mockReturnValueOnce(undefined)
      .mockReturnValue('disk full');
    try {
      const events = await run(
        { sourcePath: 'in', afterCopy: 'delete', ...toFolder },
        { log: { root: logs }, sourceWritable: true },
      );
      expect(last(events)).toEqual({
        type: 'failed',
        kind: 'permanent',
        error: 'the session log could not be written: disk full',
      });
      // One file was copied and its source deleted; the other is left alone.
      expect(await tree(dst)).toEqual(['a.txt']);
      expect(await tree(src)).toEqual(['in/b.txt']);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    [
      'no log connection is bound',
      {},
      'the session log is written to a folder, and no log connection is bound; pick one on the Settings tab',
    ],
    [
      'the log connection does not allow writes',
      { writable: false },
      'the log connection does not allow writes; turn on Allow writes on that connection',
    ],
    [
      'the log connection is not a file one',
      { kind: 'sqlite' as const },
      'the log connection is not a file connection',
    ],
  ])('refuses before copying anything when %s', async (_why, log, message) => {
    await put('in/a.txt', 'a');
    const events = await run(
      { sourcePath: 'in', ...toFolder },
      'writable' in log || 'kind' in log ? { log: { root: logs, ...log } } : {},
    );
    expect(last(events)).toEqual({ type: 'failed', kind: 'permanent', error: message });
    expect(await tree(dst)).toEqual([]);
  });

  it('refuses a log folder that does not exist, before copying anything', async () => {
    await put('in/a.txt', 'a');
    const events = await run(
      { sourcePath: 'in', logTo: 'folder', logFolder: 'missing' },
      { log: { root: logs } },
    );
    expect(last(events)).toMatchObject({
      type: 'failed',
      error: "the log folder 'missing' does not exist",
    });
    expect(await tree(dst)).toEqual([]);
  });

  it('refuses a log folder in the source folder it would copy, and writes no log there', async () => {
    await put('in/a.txt', 'a');
    await mkdir(join(src, 'in', 'logs'));
    const events = await run(
      { sourcePath: 'in', logTo: 'folder', logFolder: 'in/logs' },
      { log: { root: src } },
    );
    expect(last(events)).toMatchObject({
      type: 'failed',
      error:
        'the log folder is inside the source folder, so the copy would copy its own log; pick one outside it',
    });
    expect(await tree(src)).toEqual(['in/a.txt']);
    // Without Include subfolders, a subfolder is never listed, so it is allowed.
    const flat = await run(
      { sourcePath: 'in', recursive: false, logTo: 'folder', logFolder: 'in/logs' },
      { log: { root: src } },
    );
    expect(last(flat).type).toBe('succeeded');
  });

  it('fails a copy whose log cannot be written, reporting the counts first', async () => {
    await put('in/a.txt', 'a');
    const spy = vi
      .spyOn(SessionLogWriter.prototype, 'close')
      .mockResolvedValueOnce({ ok: false, error: 'disk full' });
    try {
      const events = await run({ sourcePath: 'in', ...toFolder }, { log: { root: logs } });
      expect(last(events)).toEqual({
        type: 'failed',
        kind: 'permanent',
        error: `copied 1 file, but the session log '${join(logs, 'runs', FILE)}' could not be written: disk full`,
      });
      expect(events).toContainEqual({ type: 'output', name: 'filesWritten', value: 1 });
      expect(events).toContainEqual({ type: 'output', name: 'logPath', value: null });
    } finally {
      spy.mockRestore();
    }
  });

  describe('#1600 C6c-2 — Log mode', () => {
    const path = () => join(logs, 'runs', FILE);
    const incomplete = (error: string) => ({
      type: 'warned',
      code: 'copy_session_log_incomplete',
      reason: `the session log '${path()}' could not be written, so it is missing lines (Best effort): ${error}`,
    });
    /** The log file's lines (no timestamps) each time the copy flushed it. */
    const flushes = () => {
      const seen: string[][] = [];
      const real = SessionLogWriter.prototype.flushIfFull;
      const spy = vi
        .spyOn(SessionLogWriter.prototype, 'flushIfFull')
        .mockImplementation(async function (this: SessionLogWriter) {
          await real.call(this);
          seen.push(
            readFileSync(path(), 'utf8')
              .split('\r\n')
              .slice(1)
              .filter((l) => l !== '')
              .map((l) => l.split(',')[2]!),
          );
        });
      return { seen, spy };
    };

    /**
     * The log opens for real, then every write to it fails, through the
     * writer's own seam. `flushBytes` 1 writes after every file in either mode,
     * so a Best effort write fails mid-copy too.
     */
    const failingWrites = () => {
      const realOpen = SessionLogWriter.open.bind(SessionLogWriter);
      return vi.spyOn(SessionLogWriter, 'open').mockImplementation(async (dir, name, opts) => {
        const opened = await realOpen(dir, name, opts);
        if (!opened.ok) return opened;
        await opened.writer.close();
        const fh = {
          write: () => Promise.reject(new Error('disk full')),
          close: () => Promise.resolve(),
        };
        const writer = SessionLogWriter.over(fh, opened.writer.path, { ...opts, flushBytes: 1 });
        return { ok: true, writer };
      });
    };

    it("Reliable writes each file's lines before the next file is copied", async () => {
      await put('in/a.txt', 'a');
      await put('in/b.txt', 'b');
      const { seen, spy } = flushes();
      try {
        const events = await run(
          { sourcePath: 'in', logLevel: 'info', ...toFolder },
          { log: { root: logs } },
        );
        expect(last(events)).toMatchObject({ type: 'succeeded' });
        expect(seen).toEqual([
          ['FileRead', 'FileWrite'],
          ['FileRead', 'FileWrite', 'FileRead', 'FileWrite'],
        ]);
      } finally {
        spy.mockRestore();
      }
    });

    it('Best effort holds the lines until 64 KiB, or the end', async () => {
      await put('in/a.txt', 'a');
      await put('in/b.txt', 'b');
      const { seen, spy } = flushes();
      try {
        const events = await run(
          { sourcePath: 'in', logLevel: 'info', logMode: 'bestEffort', ...toFolder },
          { log: { root: logs } },
        );
        expect(last(events)).toMatchObject({ type: 'succeeded' });
        expect(seen).toEqual([[], []]);
        expect(await csv()).toHaveLength(5);
      } finally {
        spy.mockRestore();
      }
    });

    it.each([
      ['Reliable stops before the next file', 'reliable', 'failed', ['a.txt'], ['in/b.txt']],
      [
        'Best effort keeps copying, and deleting',
        'bestEffort',
        'succeeded',
        ['a.txt', 'b.txt'],
        [],
      ],
    ])('%s once a write to the log fails', async (_name, logMode, outcome, copied, kept) => {
      await put('in/a.txt', 'a');
      await put('in/b.txt', 'b');
      const spy = failingWrites();
      try {
        const events = await run(
          { sourcePath: 'in', afterCopy: 'delete', logLevel: 'info', logMode, ...toFolder },
          { log: { root: logs }, sourceWritable: true },
        );
        expect(last(events)).toMatchObject({ type: outcome });
        if (logMode === 'reliable') {
          expect(last(events)).toMatchObject({
            error: 'the session log could not be written: disk full',
          });
          expect(events.filter((e) => e.type === 'warned')).toEqual([]);
        } else {
          expect(outputs(events)['logPath']).toBe(path());
          expect(events).toContainEqual(incomplete('disk full'));
        }
        expect(await tree(dst)).toEqual(copied);
        expect(await tree(src)).toEqual(kept);
      } finally {
        spy.mockRestore();
      }
    });

    it("Best effort keeps a failed copy's own error, and does not warn", async () => {
      const spy = failingWrites();
      try {
        const events = await run(
          {
            pathType: 'file',
            sourcePath: 'in/gone.txt',
            logLevel: 'info',
            logMode: 'bestEffort',
            ...toFolder,
          },
          { log: { root: logs } },
        );
        const end = last(events);
        expect(end).toMatchObject({ type: 'failed' });
        expect(end.type === 'failed' ? end.error : '').not.toMatch(/session log/);
        expect(events.filter((e) => e.type === 'warned')).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });

    it.each([
      ['a file was copied', 'in/a.txt'],
      ['nothing was selected', 'in/a.md'],
    ])('Best effort warns when the log cannot be closed, and %s', async (_when, file) => {
      await put(file, 'a');
      const spy = vi
        .spyOn(SessionLogWriter.prototype, 'close')
        .mockResolvedValueOnce({ ok: false, error: 'disk full' });
      try {
        const events = await run(
          { sourcePath: 'in', wildcard: '*.txt', logMode: 'bestEffort', ...toFolder },
          { log: { root: logs } },
        );
        expect(last(events)).toMatchObject({ type: 'succeeded' });
        expect(outputs(events)['logPath']).toBe(path());
        expect(events).toContainEqual(incomplete('disk full'));
      } finally {
        spy.mockRestore();
      }
    });

    it.each(['reliable', 'bestEffort'])(
      '%s still refuses the copy when the log cannot be opened',
      async (logMode) => {
        await put('in/a.txt', 'a');
        const events = await run(
          { sourcePath: 'in', logMode, logTo: 'folder', logFolder: 'missing' },
          { log: { root: logs } },
        );
        expect(last(events)).toMatchObject({ type: 'failed', kind: 'permanent' });
        expect(await tree(dst)).toEqual([]);
      },
    );
  });
});

/**
 * #1600 OR41 C5b — Load Incremental on a Files as-is copy: *Modified since last
 * successful run*. The window is [stored time, cutoff), the cutoff taken before
 * the listing and a settle margin behind the clock, and a file's time is the
 * later of its modified and status-change times, so a file renamed or moved in
 * keeping an old modified time is still copied. The executor's lease is the
 * `copyWatermark` given here: `old` the stored time, `commit` its store.
 */
describe('#1600 OR41 C5b — Load Incremental (Modified since last successful run)', () => {
  const PAST = new Date('2020-01-01T00:00:00Z');
  const INC = { sourcePath: 'in', load: 'incremental' };
  /** A lease holding `old`, recording each stored time. */
  const lease = (old: string | number | null) => {
    const stored: unknown[] = [];
    return { stored, copyWatermark: { old, commit: (next: unknown) => void stored.push(next) } };
  };
  /**
   * Run as if the settle margin had passed since now: the clock is set that far
   * ahead (only `Date`), so a file written before this call is inside the window.
   */
  async function settled(
    input: Record<string, unknown>,
    over: Parameters<typeof run>[1],
  ): Promise<{ events: ActivityEvent[]; cutoff: string }> {
    vi.useRealTimers();
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now + COPY_FILES_SETTLE_MS + 5);
    try {
      return { events: await run(input, over), cutoff: new Date(now + 5).toISOString() };
    } finally {
      vi.useRealTimers();
    }
  }
  const pause = () => new Promise((r) => setTimeout(r, 20));

  it('first run copies every file and stores the cutoff; the next copies only what changed since', async () => {
    await put('in/a.txt', 'a');
    await put('in/sub/b.txt', 'b');
    const one = lease(null);
    const first = await settled(INC, { copyWatermark: one.copyWatermark });
    expect(outputs(first.events)).toMatchObject({
      filesWritten: 2,
      watermark: { old: null, new: first.cutoff },
    });
    expect(one.stored).toEqual([first.cutoff]);
    await rm(dst, { recursive: true });
    await mkdir(dst);

    await pause();
    await put('in/c.txt', 'c');
    const two = lease(first.cutoff);
    const second = await settled(INC, { copyWatermark: two.copyWatermark });
    expect(outputs(second.events)).toMatchObject({
      filesRead: 1,
      filesWritten: 1,
      watermark: { old: first.cutoff, new: second.cutoff },
    });
    expect(await tree(dst)).toEqual(['c.txt']);
    expect(two.stored).toEqual([second.cutoff]);
  });

  it('copies a file renamed in with an old modified time (its status-change time is new)', async () => {
    const path = await put('drop.tmp', 'x');
    await utimes(path, PAST, PAST);
    await mkdir(join(src, 'in'));
    const one = lease(null);
    const first = await settled(
      { ...INC, wildcard: '*.csv' },
      { copyWatermark: one.copyWatermark },
    );
    expect(outputs(first.events)).toMatchObject({ filesWritten: 0 });
    await pause();
    execFileSync('mv', [path, join(src, 'in', 'drop.csv')]);
    expect((await stat(join(src, 'in', 'drop.csv'))).mtime.getTime()).toBe(PAST.getTime());
    const second = await settled(
      { ...INC, wildcard: '*.csv' },
      { copyWatermark: lease(first.cutoff).copyWatermark },
    );
    expect(outputs(second.events)).toMatchObject({ filesWritten: 1 });
    expect(await tree(dst)).toEqual(['drop.csv']);
  });

  it('leaves a file changed inside the settle margin to the next run', async () => {
    await put('in/a.txt', 'a');
    // Well inside the margin, and past the millisecond a.txt was written in, so
    // a copy with no margin would select it.
    await new Promise((r) => setTimeout(r, 50));
    const one = lease(null);
    // The real clock: a.txt was written less than the margin ago.
    const events = await run(INC, { copyWatermark: one.copyWatermark });
    expect(outputs(events)).toMatchObject({ filesWritten: 0 });
    const stored = Date.parse(String(one.stored[0]));
    expect(Date.now() - stored).toBeGreaterThanOrEqual(COPY_FILES_SETTLE_MS - 50);
  });

  it('stores nothing when a file fails, so the next run selects the same window again', async () => {
    await put('in/a.txt', 'a');
    await put('in/b.txt', 'b');
    await put('b.txt', 'held', dst);
    const one = lease(null);
    const { events } = await settled(
      { ...INC, ifExists: 'fail' },
      { copyWatermark: one.copyWatermark },
    );
    expect(failure(events).kind).toBe('permanent');
    expect(one.stored).toEqual([]);
    // No watermark is reported for a window not finished.
    const reported = events.filter((e) => e.type === 'output' && e.name === 'watermark');
    expect(reported).toEqual([]);
  });

  it('advances over an empty window, and never moves back', async () => {
    await mkdir(join(src, 'in'));
    const one = lease(null);
    const empty = await settled(INC, { copyWatermark: one.copyWatermark });
    expect(outputs(empty.events)).toMatchObject({ filesWritten: 0 });
    expect(one.stored).toEqual([empty.cutoff]);

    await put('in/a.txt', 'a');
    const ahead = '2999-01-01T00:00:00.000Z';
    const two = lease(ahead);
    const back = await settled(INC, { copyWatermark: two.copyWatermark });
    expect(outputs(back.events)).toMatchObject({
      filesWritten: 0,
      watermark: { old: ahead, new: ahead },
    });
    expect(two.stored).toEqual([]);
  });

  it('fails when the time cannot be stored, after the files are copied, with the counts', async () => {
    await put('in/a.txt', 'a');
    const { events } = await settled(INC, {
      copyWatermark: {
        old: null,
        commit: () => {
          throw new Error('disk I/O error');
        },
      },
    });
    expect(failure(events)).toMatchObject({
      kind: 'permanent',
      error: expect.stringContaining(
        'the files were copied, but the watermark could not be stored',
      ),
    });
    expect(events).toContainEqual({ type: 'output', name: 'filesWritten', value: 1 });
    expect(await tree(dst)).toEqual(['a.txt']);
  });

  it('refuses a stored value that is not a time, and a run with no lease', async () => {
    await put('in/a.txt', 'a');
    const bad = await settled(INC, { copyWatermark: lease(42).copyWatermark });
    expect(failure(bad.events).error).toMatch(/stored watermark 42 is not a time/);
    const none = await settled(INC, {});
    expect(failure(none.events).error).toMatch(/no stored watermark to read/);
    expect(await tree(dst)).toEqual([]);
  });

  it('under Full, reports no watermark and keeps Modified between on modified time only', async () => {
    const path = await put('in/a.txt', 'a');
    await utimes(path, PAST, PAST);
    const events = await run({
      sourcePath: 'in',
      modifiedStart: '2026-01-01T00:00:00Z',
    });
    const out = outputs(events);
    expect(out).toMatchObject({ filesWritten: 0 });
    expect('watermark' in out).toBe(false);
  });

  it('under Incremental, yields the whole declared contract, watermark last', async () => {
    await put('in/a.txt', 'a');
    const { events } = await settled(INC, { copyWatermark: lease(null).copyWatermark });
    expect(Object.keys(outputs(events))).toEqual([...declaredNames(), 'watermark']);
  });
});
