import { mkdir, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';

// Pass every export straight through to the real implementation; only `unlink`
// becomes a spy, so a test can act between a file being chosen and deleted.
// The idiom is `fs-metadata-interleave.test.ts`'s.
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  return {
    ...actual,
    unlink: vi.fn(actual.unlink),
    opendir: vi.fn(actual.opendir),
    rmdir: vi.fn(actual.rmdir),
  };
});
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE_ACTIVITY_TYPE } from '@autonomy-studio/shared';
import { fsAdapter } from '../fs.js';
import { cleanupTempRoots, tempRoot } from './temp-roots.js';
import type { ActivityContext, ActivityEvent } from '../types.js';

/**
 * #1600 OR41 C9a — Delete's paths inside the delete loop: a mid-run abort and a
 * mid-run failure each report the counts so far, then the failure, and a file
 * removed by someone else after it was chosen is skipped.
 */
let root: string;
beforeEach(async () => {
  root = tempRoot('fs-delete-il-');
  await mkdir(join(root, 'in'));
  for (const n of ['a', 'b', 'c', 'd']) await writeFile(join(root, 'in', `${n}.txt`), n);
});
afterEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(fsp.unlink).mockReset();
  vi.mocked(fsp.unlink).mockImplementation(actual.unlink);
  vi.mocked(fsp.opendir).mockReset();
  vi.mocked(fsp.opendir).mockImplementation(actual.opendir);
  vi.mocked(fsp.rmdir).mockReset();
  vi.mocked(fsp.rmdir).mockImplementation(actual.rmdir);
  cleanupTempRoots();
});

async function run(input: Record<string, unknown>, signal: AbortSignal): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = [];
  const c: ActivityContext = {
    runId: 'run_1',
    nodeId: 'n1',
    attemptId: 'n1#0',
    activityType: DELETE_ACTIVITY_TYPE,
    input,
    connectionConfig: { roots: [root], writable: true },
    signal,
  };
  for await (const ev of fsAdapter.runActivity(c, null)) events.push(ev);
  return events;
}

const realUnlink = async () =>
  (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).unlink;

describe('delete — inside the delete loop', () => {
  it('an abort after the first delete reports one deleted, then the cancel', async () => {
    const ac = new AbortController();
    const unlink = await realUnlink();
    vi.mocked(fsp.unlink).mockImplementation(async (p) => {
      await unlink(p);
      ac.abort();
    });
    const events = await run({ path: 'in' }, ac.signal);
    expect(events.filter((e) => e.type === 'output')).toContainEqual({
      type: 'output',
      name: 'filesDeleted',
      value: 1,
    });
    expect(events.at(-1)).toMatchObject({ type: 'failed', kind: 'cancelled' });
    expect(await readdir(join(root, 'in'))).toHaveLength(3);
  });

  it('a failed delete stops the rest and reports the counts so far', async () => {
    const unlink = await realUnlink();
    let calls = 0;
    vi.mocked(fsp.unlink).mockImplementation(async (p) => {
      calls += 1;
      if (calls === 2)
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      await unlink(p);
    });
    const events = await run({ path: 'in' }, new AbortController().signal);
    expect(events.filter((e) => e.type === 'output')).toContainEqual({
      type: 'output',
      name: 'filesDeleted',
      value: 1,
    });
    expect(events.at(-1)).toMatchObject({ type: 'failed', kind: 'permanent' });
    // One deleted, one refused, and the other two never tried.
    expect(calls).toBe(2);
    expect(await readdir(join(root, 'in'))).toHaveLength(3);
  });

  it('a file removed by someone else after it was chosen is skipped, not a failure', async () => {
    const unlink = await realUnlink();
    vi.mocked(fsp.unlink).mockImplementation(async (p) => {
      // Another process takes b.txt after it was checked and before the
      // delete, so the delete itself finds it gone.
      if (String(p).endsWith('b.txt')) await rm(p);
      await unlink(p);
    });
    const events = await run({ path: 'in' }, new AbortController().signal);
    expect(events).toEqual([
      {
        type: 'succeeded',
        outputs: expect.objectContaining({ filesDeleted: 3, foldersDeleted: 0 }),
      },
    ]);
    expect(await readdir(join(root, 'in'))).toEqual([]);
  });

  it('a subfolder swapped for a link to elsewhere during the walk deletes nothing through it', async () => {
    const outside = tempRoot('fs-delete-il-out-');
    await writeFile(join(outside, 'x.txt'), 'outside');
    await mkdir(join(root, 'in', 'sub'));
    await writeFile(join(root, 'in', 'sub', 'x.txt'), 'inside');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    // The swap lands in the walk's residual gap: after the subfolder's `lstat`
    // says folder, before its `opendir`, which then follows the link.
    vi.mocked(fsp.opendir).mockImplementation(async (p, o) => {
      if (String(p) === join(root, 'in', 'sub')) {
        await rename(join(root, 'in', 'sub'), join(root, 'in', 'gone'));
        await symlink(outside, join(root, 'in', 'sub'));
      }
      return actual.opendir(p, o);
    });
    const events = await run({ path: 'in', recursive: true }, new AbortController().signal);
    expect(events.at(-1)).toMatchObject({ type: 'succeeded' });
    // The four top-level files go; the outside file, reached through the link
    // with its own identity, is still there.
    expect(events.at(-1)).toMatchObject({ outputs: { filesDeleted: 4 } });
    expect(await readdir(outside)).toEqual(['x.txt']);
  });

  it('a file replaced by another of the same name after it was chosen is left alone', async () => {
    const unlink = await realUnlink();
    vi.mocked(fsp.unlink).mockImplementation(async (p) => {
      if (String(p).endsWith('a.txt')) {
        // A new b.txt arrives in the gap: a different file, not the one chosen.
        await rm(join(root, 'in', 'b.txt'));
        await writeFile(join(root, 'in', 'b.txt'), 'new');
      }
      await unlink(p);
    });
    const events = await run({ path: 'in' }, new AbortController().signal);
    expect(events.at(-1)).toMatchObject({ type: 'succeeded', outputs: { filesDeleted: 3 } });
    expect(await readdir(join(root, 'in'))).toEqual(['b.txt']);
  });

  it('a file modified out of the window after it was chosen is left alone', async () => {
    const unlink = await realUnlink();
    vi.mocked(fsp.unlink).mockImplementation(async (p) => {
      if (String(p).endsWith('a.txt')) {
        const old = new Date('2010-01-01T00:00:00Z');
        await utimes(join(root, 'in', 'c.txt'), old, old);
      }
      await unlink(p);
    });
    const events = await run(
      { path: 'in', modifiedStart: '2020-01-01T00:00:00Z' },
      new AbortController().signal,
    );
    expect(events.at(-1)).toMatchObject({ type: 'succeeded', outputs: { filesDeleted: 3 } });
    expect(await readdir(join(root, 'in'))).toEqual(['c.txt']);
  });

  it('runs at most Max concurrent deletes at once, and that many when it can', async () => {
    const unlink = await realUnlink();
    const peakAt = async (width: number | undefined): Promise<number> => {
      for (const n of ['a', 'b', 'c', 'd']) await writeFile(join(root, 'in', `${n}.txt`), n);
      let inFlight = 0;
      let peak = 0;
      vi.mocked(fsp.unlink).mockImplementation(async (p) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        await unlink(p);
        inFlight -= 1;
      });
      const input =
        width === undefined ? { path: 'in' } : { path: 'in', maxConcurrentConnections: width };
      const events = await run(input, new AbortController().signal);
      expect(events.at(-1)).toMatchObject({ type: 'succeeded', outputs: { filesDeleted: 4 } });
      return peak;
    };
    expect(await peakAt(undefined)).toBe(1);
    expect(await peakAt(3)).toBe(3);
  });

  it('a folder that cannot be removed fails the node after the files, with the counts', async () => {
    await mkdir(join(root, 'in', 'sub'));
    vi.mocked(fsp.rmdir).mockImplementation(async () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });
    const events = await run(
      { path: 'in', recursive: true, deleteEmptyFolders: true },
      new AbortController().signal,
    );
    expect(events.filter((e) => e.type === 'output')).toContainEqual({
      type: 'output',
      name: 'filesDeleted',
      value: 4,
    });
    expect(events.at(-1)).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(await readdir(join(root, 'in'))).toEqual(['sub']);
  });

  it('a mount point (EBUSY) is kept, not a failure', async () => {
    await mkdir(join(root, 'in', 'mnt'));
    vi.mocked(fsp.rmdir).mockImplementation(async () => {
      throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    });
    const events = await run(
      { path: 'in', recursive: true, deleteEmptyFolders: true },
      new AbortController().signal,
    );
    expect(events).toEqual([
      {
        type: 'succeeded',
        outputs: expect.objectContaining({ filesDeleted: 4, foldersDeleted: 0 }),
      },
    ]);
  });

  it('an abort while removing folders stops there and reports the counts', async () => {
    await mkdir(join(root, 'in', 'x'));
    await mkdir(join(root, 'in', 'y'));
    const ac = new AbortController();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fsp.rmdir).mockImplementation(async (p) => {
      await actual.rmdir(p);
      ac.abort();
    });
    const events = await run({ path: 'in', recursive: true, deleteEmptyFolders: true }, ac.signal);
    expect(events.filter((e) => e.type === 'output')).toContainEqual({
      type: 'output',
      name: 'foldersDeleted',
      value: 1,
    });
    expect(events.at(-1)).toMatchObject({ type: 'failed', kind: 'cancelled' });
    expect(await readdir(join(root, 'in'))).toHaveLength(1);
  });
});
