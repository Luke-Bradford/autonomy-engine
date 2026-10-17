import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fsAdapter } from '../fs.js';
import { cleanupTempRoots, tempRoot } from './temp-roots.js';
import type { ActivityContext, ActivityEvent } from '../types.js';

// #1736 — what happens to Get metadata WHILE it runs. A pre-aborted signal
// never gets this far (the adapter refuses it before dispatch), so these act
// from inside the activity's own file system calls, on a real file system:
// - the `lstat` of `gone.txt` deletes it first, so the real `lstat` answers
//   ENOENT, as when an entry is removed after the folder was read;
// - with `cancelOnEntry`, the first entry's `lstat` cancels the run, as a
//   cancel mid-listing does (the first, so the folder's order cannot matter);
// - the first chunk read of `big.bin` cancels the run, mid-Content MD5.
let cancel: AbortController;
let cancelOnEntry = false;
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    lstat: async (...args: Parameters<typeof real.lstat>) => {
      const at = String(args[0]);
      if (at.endsWith('gone.txt')) await real.rm(at, { force: true });
      if (cancelOnEntry && at.endsWith('.txt')) cancel.abort();
      return real.lstat(...args);
    },
    open: async (...args: Parameters<typeof real.open>) => {
      const fh = await real.open(...args);
      if (!String(args[0]).endsWith('big.bin')) return fh;
      const read = fh.read.bind(fh) as (...a: unknown[]) => Promise<unknown>;
      (fh as unknown as { read: (...a: unknown[]) => Promise<unknown> }).read = async (...a) => {
        const r = await read(...a);
        cancel.abort();
        return r;
      };
      return fh;
    },
  };
});

let root: string;
beforeEach(() => {
  root = tempRoot('fs-meta-interleave-');
  cancel = new AbortController();
  cancelOnEntry = false;
});
afterEach(cleanupTempRoots);

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
      const ev = await run({ path: '.', fieldList: ['childItems'], recursive });
      if (ev.type !== 'succeeded') throw new Error(`expected success, got ${JSON.stringify(ev)}`);
      const items = ev.outputs.childItems as Array<{ name: string }>;
      expect(items.map((i) => i.name)).toEqual(['kept.txt']);
    });
  }
});

describe('get_metadata — a cancel while it runs (#1736)', () => {
  it('stops listing child items', async () => {
    // Entries left after the one that cancels, so the loop sees the signal.
    cancelOnEntry = true;
    for (const n of ['w', 'x', 'y', 'z']) await writeFile(join(root, `${n}.txt`), n, 'utf8');
    expect(await run({ path: '.', fieldList: ['childItems'] })).toMatchObject({
      type: 'failed',
      kind: 'cancelled',
    });
  });

  it('stops reading Content MD5 before the hash finishes', async () => {
    // Four 64 KiB chunks: the cancel lands after the first.
    await writeFile(join(root, 'big.bin'), Buffer.alloc(1 << 18, 7));
    expect(await run({ path: 'big.bin', fieldList: ['contentMD5'] })).toMatchObject({
      type: 'failed',
      kind: 'cancelled',
    });
  });
});
