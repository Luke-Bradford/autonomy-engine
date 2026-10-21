import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A hook runs once, just before the real call it is set on, so a test can act
 * between the copy choosing a path and touching it. #1600 C6e-2: `opened` runs
 * just after an `open` returns, and `read` after the first read of the handle
 * that `open` returned, so a test can change a file while it is copied. A
 * `prefix` hook matches any path that starts with `path` (a temp's suffix is
 * unknown).
 */
interface Hook {
  readonly fn: 'open' | 'opendir' | 'lstat' | 'opened' | 'read';
  readonly path: string;
  readonly prefix?: boolean;
  readonly nth: number;
  readonly act: () => Promise<void> | void;
  seen: number;
}
const hooks = vi.hoisted(() => [] as Hook[]);

// Pass every export straight through to the real implementation; only these
// three run a hook first. The idiom is `fs-delete-interleave.test.ts`'s.
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  const matches = (h: Hook, fn: Hook['fn'], p: unknown) =>
    h.fn === fn && (h.prefix === true ? String(p).startsWith(h.path) : String(p) === h.path);
  const hooked =
    <A extends unknown[], R>(fn: Hook['fn'], real: (p: unknown, ...rest: A) => Promise<R>) =>
    async (p: unknown, ...rest: A): Promise<R> => {
      for (const h of hooks) {
        if (matches(h, fn, p) && ++h.seen === h.nth) await h.act();
      }
      return real(p, ...rest);
    };
  const open = hooked('open', actual.open as never) as typeof actual.open;
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const fh = await open(...args);
      for (const h of hooks) {
        if (matches(h, 'opened', args[0]) && ++h.seen === h.nth) await h.act();
        if (!matches(h, 'read', args[0]) || ++h.seen !== h.nth) continue;
        const read = fh.read.bind(fh) as (...a: unknown[]) => Promise<unknown>;
        let fired = false;
        fh.read = (async (...a: unknown[]) => {
          const got = await read(...a);
          if (!fired) {
            fired = true;
            await h.act();
          }
          return got;
        }) as typeof fh.read;
      }
      return fh;
    },
    opendir: hooked('opendir', actual.opendir as never),
    lstat: hooked('lstat', actual.lstat as never),
  };
});

import { realpathSync } from 'node:fs';
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises';
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

/**
 * #1600 OR41 C6e-2 — Copy · Files as-is's Verify copied files (ADF's
 * `validateDataConsistency` for binary files) and Skip inconsistent files
 * (`skipErrorFile.dataInconsistency`): a file that changes while it is copied
 * fails the copy, or is skipped, and is never landed.
 */
describe('#1600 C6e-2 — Verify copied files', () => {
  beforeEach(async () => {
    await put('in/a.txt', 'aa');
    await put('in/b.txt', 'bbbb');
    await put('b.txt', 'old', dst);
  });
  const verify = { sourcePath: 'in', validateDataConsistency: true };
  const whileRead = (rel: string, act: Hook['act']) => before('read', rel, act);
  const reason = (detail: string) => `the source changed while it was copied: ${detail}`;

  it('copies files that do not change exactly as an unverified copy does', async () => {
    // The measured duration and throughput differ run to run, and the
    // consistency output is what tells the two apart (C6f-1).
    const MEASURES = ['durationMs', 'throughput', 'consistency'];
    const counts = (out: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(out).filter(([k]) => !MEASURES.includes(k)));
    const verified = outputs(await run(verify));
    await rm(join(dst, 'a.txt'));
    await writeFile(join(dst, 'b.txt'), 'old');
    const unverified = outputs(await run({ sourcePath: 'in' }));
    expect(counts(unverified)).toEqual(counts(verified));
    expect(verified).toMatchObject({ filesWritten: 2, filesSkipped: 0, bytesWritten: 6 });
    expect(verified['consistency']).toEqual({ verified: true, result: 'none' });
    expect(unverified['consistency']).toEqual({ verified: false, result: 'none' });
  });

  it.each([
    [
      'grows',
      () => appendFile(join(src, 'in/b.txt'), 'more'),
      'it held 4 bytes when opened, and the copy read 8 bytes',
    ],
    ['shrinks', () => truncate(join(src, 'in/b.txt'), 1), 'its size went from 4 bytes to 1 byte'],
    [
      'is touched',
      () => utimes(join(src, 'in/b.txt'), new Date(0), new Date(0)),
      'its modified time changed',
    ],
    [
      'is replaced',
      async () => {
        await writeFile(join(src, 'in/b.new'), 'bbbb');
        await rm(join(src, 'in/b.txt'));
        const { rename } = await import('node:fs/promises');
        await rename(join(src, 'in/b.new'), join(src, 'in/b.txt'));
      },
      'another file took its place',
    ],
    ['is removed', remove('in/b.txt'), 'it was removed'],
  ])('fails when a file %s while it is read, landing nothing for it', async (_, act, detail) => {
    whileRead('in/b.txt', act);
    const events = await run(verify);
    expect(failure(events)).toMatchObject({
      kind: 'permanent',
      error: `Verify copied files failed for 'b.txt': ${reason(detail)}`,
    });
    // C6f-1 — ADF's InconsistentData Found, ahead of the failure.
    expect(events).toContainEqual({
      type: 'output',
      name: 'consistency',
      value: { verified: true, result: 'found' },
    });
    // The target it would have replaced is kept, and no temp is left.
    expect(await readFile(join(dst, 'b.txt'), 'utf8')).toBe('old');
    expect((await tree(dst)).filter((f) => f.startsWith('b.txt'))).toEqual(['b.txt']);
  });

  it('off, lands what it read, as before', async () => {
    whileRead('in/b.txt', () => appendFile(join(src, 'in/b.txt'), 'more'));
    const events = await run({ sourcePath: 'in' });
    expect(outputs(events)).toMatchObject({ filesWritten: 2 });
    expect(await readFile(join(dst, 'b.txt'), 'utf8')).toBe('bbbbmore');
  });

  it('lands nothing when it writes without replacing (If file exists = Fail)', async () => {
    await rm(join(dst, 'b.txt'));
    whileRead('in/b.txt', () => appendFile(join(src, 'in/b.txt'), 'more'));
    const events = await run({ ...verify, ifExists: 'fail' });
    expect(failure(events).error).toMatch(/^Verify copied files failed for 'b\.txt'/);
    expect(await tree(dst)).toEqual(['a.txt']);
  });

  it('fails when the file written is not the size read', async () => {
    hooks.push({
      fn: 'opened',
      path: `${join(dst, 'b.txt')}.tmp.`,
      prefix: true,
      nth: 1,
      seen: 0,
      act: async () => {
        const [tmp] = (await readdir(dst)).filter((f) => f.startsWith('b.txt.tmp.'));
        await appendFile(join(dst, tmp!), 'x'.repeat(100));
      },
    });
    const events = await run(verify);
    expect(failure(events).error).toBe(
      "Verify copied files failed for 'b.txt': the file written holds 100 bytes, not the 4 bytes read",
    );
    expect(await readFile(join(dst, 'b.txt'), 'utf8')).toBe('old');
  });

  describe('Skip inconsistent files', () => {
    const skip = { ...verify, skipInconsistentFiles: true };

    it('skips and logs the file, and copies the rest', async () => {
      whileRead('in/b.txt', () => appendFile(join(src, 'in/b.txt'), 'more'));
      const events = await run(skip);
      expect(outputs(events)).toMatchObject({
        filesRead: 1,
        filesWritten: 1,
        filesSkipped: 1,
        bytesRead: 2,
        consistency: { verified: true, result: 'skipped' },
      });
      expect(logLines(events)).toEqual([
        `Warning FileSkip b.txt skipped: ${reason('it held 4 bytes when opened, and the copy read 8 bytes')}, and Skip inconsistent files is on`,
      ]);
      expect(await readFile(join(dst, 'b.txt'), 'utf8')).toBe('old');
      expect(await readFile(join(dst, 'a.txt'), 'utf8')).toBe('aa');
    });

    it('leaves no temp for the file it skipped', async () => {
      whileRead('in/b.txt', () => appendFile(join(src, 'in/b.txt'), 'more'));
      outputs(await run(skip));
      expect(await tree(dst)).toEqual(['a.txt', 'b.txt']);
    });

    it('reports an abort during the check as the outcome, not a skip', async () => {
      const ctl = new AbortController();
      // b.txt is the last target: the stat after its read is its check.
      before(
        'lstat',
        'in/b.txt',
        async () => {
          await appendFile(join(src, 'in/b.txt'), 'more');
          ctl.abort();
        },
        2,
      );
      const events = await run(skip, { signal: ctl.signal });
      expect(last(events)).toMatchObject({ type: 'failed', kind: 'cancelled' });
      expect(logLines(events)).toEqual([]);
    });

    it('never moves the file it skipped', async () => {
      whileRead('in/b.txt', () => appendFile(join(src, 'in/b.txt'), 'more'));
      const events = await run(
        { ...skip, afterCopy: 'move', moveTo: 'done' },
        { sourceWritable: true },
      );
      expect(outputs(events)).toMatchObject({ filesMoved: 1, filesSkipped: 1 });
      expect(await tree(src)).toEqual(['done/a.txt', 'in/b.txt']);
    });

    it('never deletes the file it skipped', async () => {
      whileRead('in/b.txt', () => appendFile(join(src, 'in/b.txt'), 'more'));
      const events = await run({ ...skip, afterCopy: 'delete' }, { sourceWritable: true });
      expect(outputs(events)).toMatchObject({ filesDeleted: 1, filesSkipped: 1 });
      expect(await tree(src)).toEqual(['in/b.txt']);
    });

    it('never skips one file, which fails', async () => {
      before('read', 'in/b.txt', () => appendFile(join(src, 'in/b.txt'), 'more'));
      const one = { sourcePath: 'in/b.txt', pathType: 'file', validateDataConsistency: true };
      const events = await run(one);
      expect(failure(events).error).toBe(
        `Verify copied files failed for 'b.txt': ${reason('it held 4 bytes when opened, and the copy read 8 bytes')}`,
      );
      // C6f-1 — a single file reports what it found too.
      expect(events).toContainEqual({
        type: 'output',
        name: 'consistency',
        value: { verified: true, result: 'found' },
      });
      // Asking for the skip there is refused at dispatch, before anything is read.
      const refused = failure(await run({ ...one, skipInconsistentFiles: true }));
      expect(refused.error).toMatch(/^invalid copy \(files\) config: .*one file fails instead/);
      expect(await readFile(join(dst, 'b.txt'), 'utf8')).toBe('old');
    });
  });

  it('refuses Verify with Flatten at dispatch, where a ${} Copy behaviour is judged', async () => {
    // Save cannot judge a `${}` Copy behaviour; dispatch parses the resolved one.
    const events = await run({ ...verify, copyBehavior: 'flatten' });
    expect(failure(events)).toMatchObject({ kind: 'permanent' });
    expect(failure(events).error).toMatch(/needs Copy behaviour Preserve hierarchy/);
  });
});
