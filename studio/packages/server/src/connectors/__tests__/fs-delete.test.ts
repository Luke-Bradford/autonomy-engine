import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DELETE_ACTIVITY_TYPE, getActivity } from '@autonomy-studio/shared';
import { fsAdapter } from '../fs.js';
import { cleanupTempRoots, tempRoot } from './temp-roots.js';
import type { ActivityContext, ActivityEvent } from '../types.js';

/**
 * #1600 OR41 C9a — Delete on a file system connection, against real folders.
 * The mid-run abort and failure paths, which need a hook inside the delete
 * loop, are in `fs-delete-interleave.test.ts`.
 */
let root: string;
let outside: string;
beforeEach(() => {
  root = tempRoot('fs-delete-root-');
  outside = tempRoot('fs-delete-out-');
});
afterEach(cleanupTempRoots);

interface Over {
  writable?: boolean;
  maxEntries?: number;
  signal?: AbortSignal;
}

async function run(input: Record<string, unknown>, over: Over = {}): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = [];
  const c: ActivityContext = {
    runId: 'run_1',
    nodeId: 'n1',
    attemptId: 'n1#0',
    activityType: DELETE_ACTIVITY_TYPE,
    input,
    connectionConfig: {
      roots: [root],
      writable: over.writable ?? true,
      ...(over.maxEntries === undefined ? {} : { maxEntries: over.maxEntries }),
    },
    signal: over.signal ?? new AbortController().signal,
  };
  for await (const ev of fsAdapter.runActivity(c, null)) events.push(ev);
  return events;
}

async function outputsOf(input: Record<string, unknown>) {
  const events = await run(input);
  expect(events).toHaveLength(1);
  const ev = events[0]!;
  if (ev.type !== 'succeeded') throw new Error(`expected success, got ${JSON.stringify(ev)}`);
  return ev.outputs as Record<string, unknown>;
}

async function failureOf(input: Record<string, unknown>, over: Over = {}) {
  const events = await run(input, over);
  const ev = events.at(-1)!;
  if (ev.type !== 'failed') throw new Error(`expected failure, got ${JSON.stringify(ev)}`);
  return ev;
}

/** Whether the temp file system folds case, probed once when the tests are defined. */
function foldsCase(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'fs-delete-case-'));
  try {
    mkdirSync(join(dir, 'Ab'));
    return existsSync(join(dir, 'AB'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every file and folder under `dir`, relative and sorted. */
async function tree(dir: string): Promise<string[]> {
  const out = await readdir(dir, { recursive: true });
  return out.map((p) => p.split('\\').join('/')).sort();
}

async function seed(): Promise<void> {
  await mkdir(join(root, 'in', 'sub', 'deep'), { recursive: true });
  await writeFile(join(root, 'in', 'a.txt'), 'a');
  await writeFile(join(root, 'in', 'b.csv'), 'b');
  await writeFile(join(root, 'in', 'sub', 'c.txt'), 'c');
  await writeFile(join(root, 'in', 'sub', 'deep', 'd.txt'), 'd');
}

describe('delete — choosing the files', () => {
  it('deletes one file, and the outputs satisfy the catalog contract', async () => {
    await writeFile(join(root, 'one.txt'), 'x');
    const outputs = await outputsOf({ pathType: 'file', path: 'one.txt' });
    expect(outputs).toEqual({
      path: join(realpathSync(root), 'one.txt'),
      filesDeleted: 1,
      foldersDeleted: 0,
    });
    expect(Object.keys(outputs).sort()).toEqual(
      getActivity(DELETE_ACTIVITY_TYPE)!
        .outputs.map((o) => o.name)
        .sort(),
    );
    expect(existsSync(join(root, 'one.txt'))).toBe(false);
  });

  it("deletes a folder's top-level files only, keeping its subfolders and the folder", async () => {
    await seed();
    const outputs = await outputsOf({ path: 'in' });
    expect(outputs['filesDeleted']).toBe(2);
    expect(await tree(join(root, 'in'))).toEqual([
      'sub',
      'sub/c.txt',
      'sub/deep',
      'sub/deep/d.txt',
    ]);
  });

  it('with Include subfolders and a wildcard, deletes the matches in every subfolder and keeps the folders', async () => {
    await seed();
    const outputs = await outputsOf({ path: 'in', wildcard: '*.txt', recursive: true });
    expect(outputs).toMatchObject({ filesDeleted: 3, foldersDeleted: 0 });
    expect(await tree(join(root, 'in'))).toEqual(['b.csv', 'sub', 'sub/deep']);
  });

  it('keeps a file modified outside the window', async () => {
    await seed();
    const old = new Date('2020-01-01T00:00:00Z');
    await utimes(join(root, 'in', 'a.txt'), old, old);
    const outputs = await outputsOf({ path: 'in', modifiedStart: '2021-01-01T00:00:00Z' });
    expect(outputs['filesDeleted']).toBe(1);
    expect(await tree(join(root, 'in'))).toContain('a.txt');
    expect(await tree(join(root, 'in'))).not.toContain('b.csv');
  });

  it('a file outside the window is not deleted on the File path type', async () => {
    await writeFile(join(root, 'one.txt'), 'x');
    const outputs = await outputsOf({
      pathType: 'file',
      path: 'one.txt',
      modifiedEnd: '2000-01-01T00:00:00Z',
    });
    expect(outputs['filesDeleted']).toBe(0);
    expect(existsSync(join(root, 'one.txt'))).toBe(true);
  });

  it('may name the allowed folder itself, and never removes it', async () => {
    await seed();
    const outputs = await outputsOf({
      path: root,
      recursive: true,
      deleteEmptyFolders: true,
    });
    expect(outputs).toMatchObject({ filesDeleted: 4, foldersDeleted: 3 });
    expect(await tree(root)).toEqual([]);
    expect(existsSync(root)).toBe(true);
  });
});

describe('delete — nothing matched', () => {
  it('with Fail if nothing matched, a file outside the window fails and stays', async () => {
    await writeFile(join(root, 'one.txt'), 'x');
    const f = await failureOf({
      pathType: 'file',
      path: 'one.txt',
      modifiedEnd: '2000-01-01T00:00:00Z',
      failIfNothingMatched: true,
    });
    expect(f.error).toContain('outside the window');
    expect(existsSync(join(root, 'one.txt'))).toBe(true);
  });

  it('a missing path deletes nothing and succeeds', async () => {
    expect(await outputsOf({ path: 'nope/deeper' })).toEqual({
      path: join(realpathSync(root), 'nope', 'deeper'),
      filesDeleted: 0,
      foldersDeleted: 0,
    });
  });

  it('with Fail if nothing matched, a missing path fails', async () => {
    const f = await failureOf({ path: 'nope', failIfNothingMatched: true });
    expect(f).toMatchObject({ kind: 'permanent' });
    expect(f.error).toContain('does not exist');
  });

  it('with Fail if nothing matched, no match fails before anything is deleted', async () => {
    await seed();
    const f = await failureOf({
      path: 'in',
      wildcard: '*.json',
      recursive: true,
      deleteEmptyFolders: true,
      failIfNothingMatched: true,
    });
    expect(f).toMatchObject({ kind: 'permanent' });
    expect(f.error).toContain('no file');
    expect(await tree(join(root, 'in'))).toHaveLength(6);
  });
});

describe('delete — a path typed in another case', () => {
  // Only meaningful where the temp file system folds case (macOS by default),
  // so it is skipped, and reported as skipped, elsewhere.
  it.skipIf(!foldsCase())(
    "on a case-insensitive file system, deletes the folder's files all the same",
    async () => {
      await mkdir(join(root, 'Out'));
      await writeFile(join(root, 'Out', 'a.txt'), 'a');
      expect(await outputsOf({ path: 'out' })).toMatchObject({ filesDeleted: 1 });
      expect(await readdir(join(root, 'Out'))).toEqual([]);
    },
  );
});

describe('delete — empty folders', () => {
  it('removes the subfolders left empty, deepest first, and keeps the rest', async () => {
    await seed();
    await mkdir(join(root, 'in', 'keep'));
    await writeFile(join(root, 'in', 'keep', 'k.csv'), 'k');
    await mkdir(join(root, 'in', 'was-empty'));
    const outputs = await outputsOf({
      path: 'in',
      wildcard: '*.txt',
      recursive: true,
      deleteEmptyFolders: true,
    });
    // sub/deep goes first, which empties sub; was-empty was empty already.
    expect(outputs).toMatchObject({ filesDeleted: 3, foldersDeleted: 3 });
    expect(await tree(join(root, 'in'))).toEqual(['b.csv', 'keep', 'keep/k.csv']);
  });
});

describe('delete — refusals', () => {
  it('refuses a connection without Allow writes, deleting nothing', async () => {
    await writeFile(join(root, 'one.txt'), 'x');
    const f = await failureOf({ pathType: 'file', path: 'one.txt' }, { writable: false });
    expect(f).toMatchObject({ kind: 'permanent' });
    expect(f.error).toContain('Allow writes');
    expect(existsSync(join(root, 'one.txt'))).toBe(true);
  });

  it('refuses a path outside the allowed folders', async () => {
    await writeFile(join(outside, 'x.txt'), 'x');
    const f = await failureOf({ pathType: 'file', path: join(outside, 'x.txt') });
    expect(f.kind).toBe('permanent');
    expect(existsSync(join(outside, 'x.txt'))).toBe(true);
  });

  it('refuses a link at the path', async () => {
    await writeFile(join(outside, 'x.txt'), 'x');
    await symlink(join(outside, 'x.txt'), join(root, 'link.txt'));
    const f = await failureOf({ pathType: 'file', path: 'link.txt' });
    expect(f.kind).toBe('permanent');
    expect(existsSync(join(outside, 'x.txt'))).toBe(true);
    expect(existsSync(join(root, 'link.txt'))).toBe(true);
  });

  it('leaves a link inside the folder in place and never follows it', async () => {
    await mkdir(join(root, 'in'));
    await mkdir(join(outside, 'far'));
    await writeFile(join(outside, 'far', 'x.txt'), 'x');
    await writeFile(join(outside, 'y.txt'), 'y');
    await symlink(join(outside, 'far'), join(root, 'in', 'dirlink'));
    await symlink(join(outside, 'y.txt'), join(root, 'in', 'filelink.txt'));
    const outputs = await outputsOf({ path: 'in', recursive: true, deleteEmptyFolders: true });
    expect(outputs).toMatchObject({ filesDeleted: 0, foldersDeleted: 0 });
    // A plain listing: a recursive `readdir` would itself follow the link.
    expect((await readdir(join(root, 'in'))).sort()).toEqual(['dirlink', 'filelink.txt']);
    expect(existsSync(join(outside, 'far', 'x.txt'))).toBe(true);
    expect(existsSync(join(outside, 'y.txt'))).toBe(true);
  });

  it('a folder on the File path type, and a file on the Folder path type, fail', async () => {
    await seed();
    expect((await failureOf({ pathType: 'file', path: 'in' })).error).toContain(
      'is not a file, and the path type is File',
    );
    expect((await failureOf({ path: 'in/a.txt' })).error).toContain(
      'is not a folder, and the path type is Folder',
    );
    expect(await tree(join(root, 'in'))).toHaveLength(6);
  });

  it('over the entry limit, fails with every file still there', async () => {
    await seed();
    const f = await failureOf({ path: 'in', recursive: true }, { maxEntries: 3 });
    expect(f.error).toContain('3-entry list limit');
    expect(await tree(join(root, 'in'))).toHaveLength(6);
  });

  it('refuses a config the schema refuses (Delete empty folders without Include subfolders)', async () => {
    await seed();
    const f = await failureOf({ path: 'in', deleteEmptyFolders: true });
    expect(f.error).toContain('invalid delete activity config');
    expect(await tree(join(root, 'in'))).toHaveLength(6);
  });

  it('an abort before the delete is a cancel with nothing deleted', async () => {
    await seed();
    const ac = new AbortController();
    ac.abort();
    const f = await failureOf({ path: 'in' }, { signal: ac.signal });
    expect(f).toMatchObject({ kind: 'cancelled', error: 'file delete aborted' });
    expect(await tree(join(root, 'in'))).toHaveLength(6);
  });
});

describe('delete — Max concurrent deletes', () => {
  it('deletes every match with several at once', async () => {
    await mkdir(join(root, 'many'));
    for (let i = 0; i < 40; i += 1) await writeFile(join(root, 'many', `f${i}.txt`), String(i));
    const outputs = await outputsOf({ path: 'many', maxConcurrentConnections: 8 });
    expect(outputs['filesDeleted']).toBe(40);
    expect(await tree(join(root, 'many'))).toEqual([]);
  });
});
