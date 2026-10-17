import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  DELETE_ACTIVITY_TYPE,
  SESSION_LOG_OUTPUT,
  SESSION_LOG_RUN_MAX_LINES,
} from '@autonomy-studio/shared';
import { fsAdapter } from '../fs.js';
import { CSV_BOM } from '../../util/csv.js';
import { cleanupTempRoots, tempRoot } from './temp-roots.js';
import type { ActivityContext, ActivityEvent } from '../types.js';

/**
 * #1600 OR41 C9c — Delete's session log (catalogue §4.4, §5), against real
 * folders: what each level keeps, the run log and its cap, the folder file and
 * `logPath`, and the log folder checks that run before anything is deleted. The
 * failure and cancel paths are in `fs-delete-interleave.test.ts`.
 */
let root: string;
let outside: string;
beforeEach(() => {
  root = tempRoot('fs-delete-log-root-');
  outside = tempRoot('fs-delete-log-out-');
});
afterEach(cleanupTempRoots);

/** `makeTmpSuffix` of the context below. */
const LOG_NAME = 'session-log.run_1.n1.n1_0.csv';

async function run(input: Record<string, unknown>, maxEntries?: number): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = [];
  const c: ActivityContext = {
    runId: 'run_1',
    nodeId: 'n1',
    attemptId: 'n1#0',
    activityType: DELETE_ACTIVITY_TYPE,
    input,
    connectionConfig: {
      roots: [root],
      writable: true,
      ...(maxEntries === undefined ? {} : { maxEntries }),
    },
    signal: new AbortController().signal,
  };
  for await (const ev of fsAdapter.runActivity(c, null)) events.push(ev);
  return events;
}

const logLines = (events: readonly ActivityEvent[]) =>
  events.flatMap((e) => (e.type === 'output' && e.name === SESSION_LOG_OUTPUT ? [e.value] : []));

/** The CSV's rows after its header, without each row's timestamp. */
async function csvRows(path: string): Promise<string[]> {
  const text = await readFile(path, 'utf8');
  expect(text.startsWith(CSV_BOM)).toBe(true);
  const [header, ...rows] = text.slice(CSV_BOM.length).split('\r\n');
  expect(header).toBe('Timestamp,Level,Operation,Item,Message');
  expect(rows.at(-1)).toBe('');
  return rows.slice(0, -1).map((r) => {
    expect(r).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z,/);
    return r.slice(r.indexOf(',') + 1);
  });
}

async function seed() {
  await mkdir(join(root, 'in', 'day1'), { recursive: true });
  await writeFile(join(root, 'in', 'a.txt'), 'a');
  await writeFile(join(root, 'in', 'keep.csv'), 'k');
  await writeFile(join(root, 'in', 'day1', 'b.txt'), 'b');
  await symlink(join(outside), join(root, 'in', 'link.txt'));
  await mkdir(join(root, 'logs'));
}

const deep = { path: 'in', wildcard: '*.txt', recursive: true, deleteEmptyFolders: true };

describe('delete — the session log in a folder', () => {
  it('Everything writes every item to a CSV file, and logPath names it', async () => {
    await seed();
    const events = await run({ ...deep, logLevel: 'info', logTo: 'folder', logFolder: 'logs' });
    const done = events.at(-1)!;
    expect(done).toMatchObject({
      type: 'succeeded',
      outputs: { filesDeleted: 2, foldersDeleted: 1, logPath: join(root, 'logs', LOG_NAME) },
    });
    // A folder log streams nothing.
    expect(events).toHaveLength(1);
    expect(await csvRows(join(root, 'logs', LOG_NAME))).toEqual([
      'Warning,FileSkip,link.txt,"skipped: not a regular file, so left in place"',
      'Info,FileDelete,a.txt,deleted',
      'Info,FileDelete,day1/b.txt,deleted',
      'Info,FolderDelete,day1,deleted',
    ]);
  });

  it('Warnings writes only what was skipped or kept', async () => {
    await seed();
    await run({ ...deep, logLevel: 'warning', logTo: 'folder', logFolder: 'logs' });
    expect(await csvRows(join(root, 'logs', LOG_NAME))).toEqual([
      'Warning,FileSkip,link.txt,"skipped: not a regular file, so left in place"',
    ]);
  });

  it('a folder kept because it holds files is logged by Everything only', async () => {
    await mkdir(join(root, 'in', 'day2'), { recursive: true });
    await writeFile(join(root, 'in', 'day2', 'keep.csv'), 'k');
    await mkdir(join(root, 'logs'));
    await run({ ...deep, logLevel: 'info', logTo: 'folder', logFolder: 'logs' });
    expect(await csvRows(join(root, 'logs', LOG_NAME))).toEqual([
      'Info,FolderSkip,day2,kept: not empty',
    ]);
  });

  it('a missing path writes a header-only file and succeeds', async () => {
    await mkdir(join(root, 'logs'));
    const events = await run({
      path: 'nope',
      logLevel: 'info',
      logTo: 'folder',
      logFolder: 'logs',
    });
    expect(events.at(-1)).toMatchObject({
      type: 'succeeded',
      outputs: { filesDeleted: 0, logPath: join(root, 'logs', LOG_NAME) },
    });
    expect(await csvRows(join(root, 'logs', LOG_NAME))).toEqual([]);
  });

  it('a name a spreadsheet would read as a formula is written as text', async () => {
    await mkdir(join(root, 'in'));
    await writeFile(join(root, 'in', '=cmd.txt'), 'x');
    await mkdir(join(root, 'logs'));
    await run({ path: 'in', logLevel: 'info', logTo: 'folder', logFolder: 'logs' });
    expect(await csvRows(join(root, 'logs', LOG_NAME))).toEqual([
      "Info,FileDelete,'=cmd.txt,deleted",
    ]);
  });

  it('a log that cannot be written fails the node after the deletes, with the counts', async () => {
    await seed();
    // A folder holds the attempt's file name, so the rename onto it fails.
    await mkdir(join(root, 'logs', LOG_NAME));
    const events = await run({ ...deep, logLevel: 'info', logTo: 'folder', logFolder: 'logs' });
    expect(events.at(-1)).toMatchObject({ type: 'failed', kind: 'permanent' });
    const failure = events.at(-1) as Extract<ActivityEvent, { type: 'failed' }>;
    expect(failure.error).toMatch(
      /^deleted 2 file\(s\) and 1 folder\(s\), but the session log could not be written: /,
    );
    expect(events).toContainEqual({ type: 'output', name: 'filesDeleted', value: 2 });
    expect(events).toContainEqual({ type: 'output', name: 'logPath', value: null });
    expect(await readdir(join(root, 'logs'))).toEqual([LOG_NAME]);
  });
});

describe('delete — the log folder is checked before anything is deleted', () => {
  const remaining = async () => (await readdir(join(root, 'in'))).sort();

  it('a missing log folder fails the node', async () => {
    await seed();
    const events = await run({ ...deep, logTo: 'folder', logFolder: 'nolog' });
    expect(events).toEqual([
      { type: 'failed', kind: 'permanent', error: "the log folder 'nolog' does not exist" },
    ]);
    expect(await remaining()).toEqual(['a.txt', 'day1', 'keep.csv', 'link.txt']);
  });

  it('a log folder that is a file, or outside the allowed folders, fails the node', async () => {
    await seed();
    const asFile = await run({ ...deep, logTo: 'folder', logFolder: 'in/a.txt' });
    expect(asFile.at(-1)).toMatchObject({
      type: 'failed',
      error: expect.stringContaining('is not a folder'),
    });
    const far = await run({ ...deep, logTo: 'folder', logFolder: outside });
    expect(far.at(-1)).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect((far.at(-1) as { error: string }).error).toMatch(/^the log folder: /);
    expect(await remaining()).toEqual(['a.txt', 'day1', 'keep.csv', 'link.txt']);
  });

  it.skipIf(process.getuid?.() === 0)(
    'a log folder it cannot write to fails the node',
    async () => {
      await seed();
      await chmod(join(root, 'logs'), 0o555);
      try {
        const events = await run({ ...deep, logTo: 'folder', logFolder: 'logs' });
        expect(events).toEqual([
          { type: 'failed', kind: 'permanent', error: "the log folder 'logs' is not writable" },
        ]);
      } finally {
        await chmod(join(root, 'logs'), 0o755);
      }
      expect(await remaining()).toEqual(['a.txt', 'day1', 'keep.csv', 'link.txt']);
    },
  );

  it('the refusal comes before the walk, so an entry limit failure writes nothing there', async () => {
    await seed();
    const events = await run({ ...deep, logTo: 'folder', logFolder: 'in' }, 1);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'failed',
        error: expect.stringContaining('is the folder this Delete deletes from'),
      }),
    ]);
    expect(await remaining()).toEqual(['a.txt', 'day1', 'keep.csv', 'link.txt']);
  });

  it('a log folder this Delete could remove is refused, and nothing is written', async () => {
    await seed();
    await mkdir(join(root, 'in', 'logs'));
    const same = await run({ path: 'in', logTo: 'folder', logFolder: 'in' });
    expect(same.at(-1)).toMatchObject({
      type: 'failed',
      kind: 'permanent',
      error: expect.stringContaining('is the folder this Delete deletes from'),
    });
    const under = await run({ ...deep, logTo: 'folder', logFolder: 'in/logs' });
    expect(under.at(-1)).toMatchObject({
      error: expect.stringContaining('is inside the folder this Delete deletes from'),
    });
    expect(await remaining()).toEqual(['a.txt', 'day1', 'keep.csv', 'link.txt', 'logs']);
    expect(await readdir(join(root, 'in', 'logs'))).toEqual([]);
  });

  it('a subfolder is a log folder when Include subfolders is off', async () => {
    await seed();
    await mkdir(join(root, 'in', 'logs'));
    const events = await run({
      path: 'in',
      wildcard: '*.txt',
      logTo: 'folder',
      logFolder: 'in/logs',
    });
    expect(events.at(-1)).toMatchObject({ type: 'succeeded', outputs: { filesDeleted: 1 } });
    expect(existsSync(join(root, 'in', 'logs', LOG_NAME))).toBe(true);
  });

  it("a File path's own folder is a log folder", async () => {
    await seed();
    const events = await run({
      pathType: 'file',
      path: 'in/a.txt',
      logTo: 'folder',
      logFolder: 'in',
    });
    expect(events.at(-1)).toMatchObject({
      type: 'succeeded',
      outputs: { filesDeleted: 1, logPath: join(root, 'in', LOG_NAME) },
    });
  });
});

describe('delete — the session log in the run log', () => {
  it('streams each line ahead of the terminal, with its time, and logPath is null', async () => {
    await seed();
    const events = await run({ ...deep, logLevel: 'info' });
    expect(logLines(events)).toEqual([
      expect.stringMatching(/^\S+Z Warning FileSkip link\.txt skipped: not a regular file/),
      expect.stringMatching(/^\S+Z Info FileDelete a\.txt deleted$/),
      expect.stringMatching(/^\S+Z Info FileDelete day1\/b\.txt deleted$/),
      expect.stringMatching(/^\S+Z Info FolderDelete day1 deleted$/),
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'succeeded', outputs: { logPath: null } });
  });

  it('Warnings is the default, and a clean delete logs nothing', async () => {
    await mkdir(join(root, 'in'));
    await writeFile(join(root, 'in', 'a.txt'), 'a');
    expect(await run({ path: 'in' })).toEqual([
      expect.objectContaining({
        type: 'succeeded',
        outputs: expect.objectContaining({ filesDeleted: 1 }),
      }),
    ]);
  });

  it('Off logs nothing, a skip included', async () => {
    await seed();
    const events = await run({ ...deep, logLevel: 'off' });
    expect(logLines(events)).toEqual([]);
  });

  it(`keeps ${SESSION_LOG_RUN_MAX_LINES} lines, and says how many more there were last`, async () => {
    await mkdir(join(root, 'in'));
    const n = SESSION_LOG_RUN_MAX_LINES + 2;
    await Promise.all(
      Array.from({ length: n }, (_, i) => writeFile(join(root, 'in', `f${i}.txt`), '')),
    );
    const events = await run({ path: 'in', logLevel: 'info', maxConcurrentConnections: 8 });
    const lines = logLines(events);
    expect(lines).toHaveLength(SESSION_LOG_RUN_MAX_LINES + 1);
    expect(lines.at(-1)).toMatch(
      /Z Warning SessionLog {2}2 more lines not kept in the run log; write the session log to a folder/,
    );
    expect(events.at(-1)).toMatchObject({ type: 'succeeded', outputs: { filesDeleted: n } });
  });
});
