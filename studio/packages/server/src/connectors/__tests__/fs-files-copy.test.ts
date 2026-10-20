import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
  lowerRetiredTypes,
  SESSION_LOG_OUTPUT,
  SESSION_LOG_RUN_MAX_LINES,
  type Node,
} from '@autonomy-studio/shared';
import { fsAdapter } from '../fs.js';
import { runFilesCopy, unchangedSince } from '../fs-files-copy.js';
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
    expect(outputs(events)).toEqual({
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
    });
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

  it(`keeps ${SESSION_LOG_RUN_MAX_LINES} lines and counts the rest, with no folder to point at`, async () => {
    const n = SESSION_LOG_RUN_MAX_LINES / 2 + 1;
    for (let i = 0; i < n; i += 1) await put(`in/${String(i).padStart(4, '0')}.txt`, 'x');
    const lines = logLines(await run({ sourcePath: 'in', logLevel: 'info' }));
    expect(lines).toHaveLength(SESSION_LOG_RUN_MAX_LINES + 1);
    expect(lines[SESSION_LOG_RUN_MAX_LINES]).toBe(
      'Warning SessionLog  2 more lines not kept in the run log',
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

  it('still refuses a file-list line naming a file that is not there', async () => {
    await put('in/a.txt', 'a');
    await put('list.txt', 'a.txt\nnope.txt\n');
    const events = await run({ sourcePath: 'in', pathType: 'list', fileListPath: 'list.txt' });
    expect(failure(events).error).toContain("file list path 'nope.txt' does not exist");
  });
});
