import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstat, open, writeFile } from 'node:fs/promises';

// #1736 — what happens to Get metadata WHILE it runs. A pre-aborted signal
// never gets this far (the adapter refuses it before dispatch), so these act
// from inside the activity's own file system calls, on a real file system.
// As in fs.test.ts, every export passes straight through; `lstat` and `open`
// are real-behaving spies that a test wraps for itself.
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});
import { join } from 'node:path';
import { fsAdapter } from '../fs.js';
import { cleanupTempRoots, tempRoot } from './temp-roots.js';
import type { ActivityContext, ActivityEvent } from '../types.js';

const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

/** Run `before` ahead of every real `lstat` of the activity. */
function beforeLstat(before: (path: string) => Promise<void> | void): void {
  vi.mocked(lstat).mockImplementation(async (...args: Parameters<typeof realFs.lstat>) => {
    await before(String(args[0]));
    return realFs.lstat(...args);
  });
}

let root: string;
let cancel: AbortController;
beforeEach(() => {
  root = tempRoot('fs-meta-interleave-');
  cancel = new AbortController();
});
afterEach(() => {
  vi.mocked(lstat).mockImplementation(realFs.lstat);
  vi.mocked(open).mockImplementation(realFs.open);
  cleanupTempRoots();
});

async function run(input: Record<string, unknown>): Promise<ActivityEvent> {
  const events: ActivityEvent[] = [];
  const c: ActivityContext = {
    runId: 'run_1',
    nodeId: 'n1',
    attemptId: 'n1#0',
    activityType: 'get_metadata',
    input: { childFilter: '*', childType: 'all', ...input },
    connectionConfig: { roots: [root] },
    signal: cancel.signal,
  };
  for await (const ev of fsAdapter.runActivity(c, null)) events.push(ev);
  expect(events).toHaveLength(1);
  return events[0]!;
}

describe('get_metadata — an entry removed after the folder was read (#1736)', () => {
  for (const recursive of [false, true]) {
    it(`skips it and lists the rest${recursive ? ', with Include subfolders' : ''}`, async () => {
      await writeFile(join(root, 'gone.txt'), 'g', 'utf8');
      await writeFile(join(root, 'kept.txt'), 'k', 'utf8');
      // The real `lstat` answers ENOENT: the file is deleted just before it.
      beforeLstat((at) => (at.endsWith('gone.txt') ? realFs.rm(at, { force: true }) : undefined));
      const ev = await run({ path: '.', fieldList: ['childItems'], recursive });
      if (ev.type !== 'succeeded') throw new Error(`expected success, got ${JSON.stringify(ev)}`);
      const items = ev.outputs.childItems as Array<{ name: string }>;
      expect(items.map((i) => i.name)).toEqual(['kept.txt']);
    });
  }
});

describe('get_metadata — a cancel while it runs (#1736)', () => {
  it('stops listing child items', async () => {
    // The first entry's `lstat` cancels, whichever the folder lists first, and
    // entries are left after it, so the loop sees the signal.
    beforeLstat((at) => {
      if (at !== root && at.startsWith(root)) cancel.abort();
    });
    for (const n of ['w', 'x', 'y', 'z']) await writeFile(join(root, `${n}.txt`), n, 'utf8');
    expect(await run({ path: '.', fieldList: ['childItems'] })).toMatchObject({
      type: 'failed',
      kind: 'cancelled',
    });
  });

  it('stops reading Content MD5 before the hash finishes', async () => {
    // Four 64 KiB chunks: the cancel lands after the first.
    await writeFile(join(root, 'big.bin'), Buffer.alloc(1 << 18, 7));
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof realFs.open>) => {
      const fh = await realFs.open(...args);
      const read = fh.read.bind(fh) as (...a: unknown[]) => Promise<unknown>;
      // The first chunk read cancels the run.
      (fh as unknown as { read: (...a: unknown[]) => Promise<unknown> }).read = async (...a) => {
        const r = await read(...a);
        cancel.abort();
        return r;
      };
      return fh;
    });
    expect(await run({ path: 'big.bin', fieldList: ['contentMD5'] })).toMatchObject({
      type: 'failed',
      kind: 'cancelled',
    });
  });
});
