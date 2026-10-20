import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A hook runs once, just before the real call it is set on, so a test can act
 * between the copy choosing a path and touching it.
 */
interface Hook {
  readonly fn: 'open' | 'opendir' | 'lstat';
  readonly path: string;
  readonly nth: number;
  readonly act: () => Promise<void> | void;
  seen: number;
}
const hooks = vi.hoisted(() => [] as Hook[]);

// Pass every export straight through to the real implementation; only these
// three run a hook first. The idiom is `fs-delete-interleave.test.ts`'s.
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  const hooked =
    <A extends unknown[], R>(fn: Hook['fn'], real: (p: unknown, ...rest: A) => Promise<R>) =>
    async (p: unknown, ...rest: A): Promise<R> => {
      for (const h of hooks) {
        if (h.fn === fn && String(p) === h.path && ++h.seen === h.nth) await h.act();
      }
      return real(p, ...rest);
    };
  return {
    ...actual,
    open: hooked('open', actual.open as never),
    opendir: hooked('opendir', actual.opendir as never),
    lstat: hooked('lstat', actual.lstat as never),
  };
});

import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COPY_FILES_ACTIVITY_TYPE, SESSION_LOG_OUTPUT } from '@autonomy-studio/shared';
import { fsAdapter } from '../fs.js';
import { cleanupTempRoots, tempRoot } from './temp-roots.js';
import type { ActivityContext, ActivityEvent } from '../types.js';

/**
 * #1600 OR41 C6d-2 — Copy · Files as-is's Skip missing files, on by default as
 * in ADF: a file or subfolder removed by someone else after the copy chose it
 * is skipped, logged and (a file) counted. One file, an abort, and the
 * setting off all still fail.
 */
let src: string;
let dst: string;
beforeEach(() => {
  src = realpathSync(tempRoot('copy-files-il-src-'));
  dst = realpathSync(tempRoot('copy-files-il-dst-'));
});
afterEach(() => {
  hooks.length = 0;
  cleanupTempRoots();
});

const before = (fn: Hook['fn'], rel: string, act: Hook['act'], nth = 1) =>
  hooks.push({ fn, path: join(src, rel), nth, act, seen: 0 });
const remove = (rel: string) => () => rm(join(src, rel), { recursive: true, force: true });

async function put(rel: string, body: string, base = src): Promise<void> {
  await mkdir(join(base, rel, '..'), { recursive: true });
  await writeFile(join(base, rel), body);
}

async function run(
  input: Record<string, unknown>,
  over: { sourceWritable?: boolean; signal?: AbortSignal } = {},
): Promise<ActivityEvent[]> {
  const c: ActivityContext = {
    runId: 'run_1',
    nodeId: 'n1',
    attemptId: 'n1#0',
    activityType: COPY_FILES_ACTIVITY_TYPE,
    input,
    connectionConfig: { roots: [src], ...(over.sourceWritable === true && { writable: true }) },
    sink: { kind: 'fs', connectionConfig: { roots: [dst], writable: true } },
    signal: over.signal ?? new AbortController().signal,
  };
  const out: ActivityEvent[] = [];
  for await (const ev of fsAdapter.runActivity(c, null)) out.push(ev);
  return out;
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
const logLines = (events: ActivityEvent[]) =>
  events.flatMap((e) =>
    e.type === 'output' && e.name === SESSION_LOG_OUTPUT
      ? [String(e.value).replace(/^\S+ /, '')]
      : [],
  );
const tree = async (base: string) =>
  (await readdir(base, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(base.length + 1))
    .sort();
const MISSING = 'skipped: removed by someone else and Skip missing files is on';

describe('#1600 C6d-2 — Skip missing files', () => {
  beforeEach(async () => {
    await put('in/a.txt', 'aa');
    await put('in/b.txt', 'b');
  });

  it('skips a file removed between the listing and its stat', async () => {
    before('lstat', 'in/b.txt', remove('in/b.txt'));
    const events = await run({ sourcePath: 'in', sinkFolder: 'out' });
    expect(outputs(events)).toMatchObject({ filesWritten: 1, filesSkipped: 1 });
    expect(logLines(events)).toEqual([`Warning FileSkip b.txt ${MISSING}`]);
    expect(await tree(dst)).toEqual(['out/a.txt']);
  });

  it('skips a subfolder removed before it is listed, logged and not counted', async () => {
    await put('in/sub/c.txt', 'c');
    before('opendir', 'in/sub', remove('in/sub'));
    const events = await run({ sourcePath: 'in' });
    expect(outputs(events)).toMatchObject({ filesWritten: 2, filesSkipped: 0 });
    expect(logLines(events)).toEqual([
      'Warning FileSkip sub skipped: folder removed by someone else and Skip missing files is on',
    ]);
  });

  it('skips a file removed before it is read, writing nothing for it', async () => {
    before('open', 'in/b.txt', remove('in/b.txt'));
    const events = await run({ sourcePath: 'in', sinkFolder: 'out' });
    expect(outputs(events)).toMatchObject({ filesRead: 1, filesWritten: 1, filesSkipped: 1 });
    // No empty b.txt and no temp left behind.
    expect(await tree(dst)).toEqual(['out/a.txt']);
  });

  it('off, fails on that file, with what it had copied', async () => {
    before('open', 'in/b.txt', remove('in/b.txt'));
    const events = await run({ sourcePath: 'in', skipMissingFiles: false });
    expect(failure(events).error).toContain('ENOENT');
    expect(events).toContainEqual({ type: 'output', name: 'filesWritten', value: 1 });
    expect(logLines(events)).toEqual([]);
  });

  it('off, fails on a file removed between the listing and its stat', async () => {
    before('lstat', 'in/b.txt', remove('in/b.txt'));
    expect(failure(await run({ sourcePath: 'in', skipMissingFiles: false })).error).toContain(
      'ENOENT',
    );
  });

  it('never skips one file', async () => {
    before('open', 'in/a.txt', remove('in/a.txt'));
    const events = await run({ sourcePath: 'in/a.txt', pathType: 'file' });
    expect(failure(events).error).toContain('ENOENT');
    expect(await tree(dst)).toEqual([]);
  });

  it('never logs an abort as a skip', async () => {
    const ac = new AbortController();
    before('open', 'in/b.txt', async () => {
      ac.abort();
      await remove('in/b.txt')();
    });
    const events = await run({ sourcePath: 'in' }, { signal: ac.signal });
    expect(failure(events)).toMatchObject({ kind: 'cancelled' });
    expect(logLines(events)).toEqual([]);
  });

  it('logs the skip when it leaves nothing to copy', async () => {
    before('lstat', 'in/a.txt', remove('in/a.txt'));
    before('lstat', 'in/b.txt', remove('in/b.txt'));
    const events = await run({ sourcePath: 'in' });
    expect(outputs(events)).toMatchObject({ filesWritten: 0, filesSkipped: 2 });
    // In the folder's listing order, which the disk decides.
    expect(logLines(events).sort()).toEqual([
      `Warning FileSkip a.txt ${MISSING}`,
      `Warning FileSkip b.txt ${MISSING}`,
    ]);
  });

  it('reports a skip made while planning beside a later refusal', async () => {
    await put('a.txt', 'theirs', dst);
    before('lstat', 'in/b.txt', remove('in/b.txt'));
    const events = await run({ sourcePath: 'in', ifExists: 'fail' });
    expect(failure(events).error).toContain('already exists and If file exists is Fail');
    expect(events).toContainEqual({ type: 'output', name: 'filesSkipped', value: 1 });
    expect(logLines(events)).toEqual([`Warning FileSkip b.txt ${MISSING}`]);
  });

  describe('in a merge', () => {
    beforeEach(async () => {
      await put('in/c.txt', 'c');
    });
    const merge = { sourcePath: 'in', copyBehavior: 'merge', sinkFileName: 'all.txt' };

    it('leaves out a file removed before the merge opens it', async () => {
      before('open', 'in/b.txt', remove('in/b.txt'));
      const events = await run({ ...merge, logLevel: 'info' });
      expect(outputs(events)).toMatchObject({ filesRead: 2, filesWritten: 1, filesSkipped: 1 });
      expect(await readFile(join(dst, 'all.txt'), 'utf8')).toBe('aac');
      expect(logLines(events)).toEqual([
        `Warning FileSkip b.txt ${MISSING}`,
        'Info FileRead a.txt read 2 bytes',
        'Info FileRead c.txt read 1 byte',
        'Info FileWrite all.txt wrote 3 bytes merged from 2 files',
      ]);
    });

    it('leaves out a file removed after its first open, while the merge writes', async () => {
      before('open', 'in/b.txt', remove('in/b.txt'), 2);
      const events = await run(merge);
      expect(outputs(events)).toMatchObject({ filesRead: 2, filesSkipped: 1 });
      expect(await readFile(join(dst, 'all.txt'), 'utf8')).toBe('aac');
      expect(logLines(events)).toEqual([`Warning FileSkip b.txt ${MISSING}`]);
    });

    it('lands no file when every source goes while it writes', async () => {
      before(
        'open',
        'in/a.txt',
        async () => {
          for (const n of ['a', 'b', 'c']) await remove(`in/${n}.txt`)();
        },
        2,
      );
      const events = await run(merge, { sourceWritable: true });
      expect(outputs(events)).toMatchObject({ filesWritten: 0, filesSkipped: 3 });
      expect(await tree(dst)).toEqual([]);
    });

    it('counts a skipped source once when the merge target then appears', async () => {
      before('open', 'in/b.txt', async () => {
        await remove('in/b.txt')();
        await writeFile(join(dst, 'all.txt'), 'theirs');
      });
      const events = await run({ ...merge, ifExists: 'skip' });
      expect(outputs(events)).toMatchObject({ filesWritten: 0, filesSkipped: 3 });
      expect(await readFile(join(dst, 'all.txt'), 'utf8')).toBe('theirs');
    });

    it('After copy Delete leaves alone the source it skipped', async () => {
      before('open', 'in/b.txt', remove('in/b.txt'));
      const events = await run({ ...merge, afterCopy: 'delete' }, { sourceWritable: true });
      expect(outputs(events)).toMatchObject({ filesDeleted: 2, filesSkipped: 1 });
      expect(await tree(src)).toEqual([]);
    });
  });

  describe('a target If file exists = Skip compares', () => {
    beforeEach(async () => {
      await put('b.txt', 'b', dst);
    });
    const cfg = { sourcePath: 'in', ifExists: 'skip', afterCopy: 'delete' };

    it('skips a source removed before it is compared, and counts it once', async () => {
      before('open', 'in/b.txt', remove('in/b.txt'));
      const events = await run(cfg, { sourceWritable: true });
      expect(outputs(events)).toMatchObject({ filesWritten: 1, filesSkipped: 1, filesDeleted: 1 });
      expect(logLines(events)).toEqual([
        `Warning FileSkip b.txt skipped: 'b.txt' already exists and If file exists is Skip; its source could not be read: removed by someone else and Skip missing files is on`,
      ]);
    });

    it('off, fails there', async () => {
      before('open', 'in/b.txt', remove('in/b.txt'));
      const events = await run({ ...cfg, skipMissingFiles: false }, { sourceWritable: true });
      expect(failure(events).error).toContain('ENOENT');
    });
  });
});
