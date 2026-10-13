import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { link, mkdir, readFile, readdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COPY_FILES_ACTIVITY_TYPE } from '@autonomy-studio/shared';
import { fsAdapter } from '../fs.js';
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

describe('Copy · Files as-is — selection', () => {
  it('copies a folder by wildcard, into subfolders, preserving the hierarchy', async () => {
    await put('in/a.csv', 'aa');
    await put('in/b.txt', 'b');
    await put('in/sub/c.csv', 'ccc');
    const events = await run({ sourcePath: 'in', wildcard: '*.csv', sinkFolder: 'out' });
    expect(outputs(events)).toEqual({
      rowsRead: 0,
      rowsWritten: 0,
      rowsFailed: 0,
      truncated: false,
      filesRead: 2,
      filesWritten: 2,
      filesSkipped: 0,
      filesDeleted: 0,
      filesMoved: 0,
      bytesRead: 5,
      bytesWritten: 5,
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

  it('reports what it had copied before a failure part-way', async () => {
    await put('in/a.txt', 'a');
    await put('in/sub/b.txt', 'b');
    // `sub` in the sink is a FILE, so the second target has no folder to go in.
    await writeFile(join(dst, 'sub'), 'not a folder');
    const events = await run({ sourcePath: 'in' });
    expect(failure(events)).toMatchObject({ kind: 'permanent' });
    expect(events).toContainEqual({ type: 'output', name: 'filesWritten', value: 1 });
    expect(await tree(dst)).toEqual(['a.txt', 'sub']);
  });

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
});
