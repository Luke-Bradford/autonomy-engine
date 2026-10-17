import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fsAdapter } from '../fs.js';
import { cleanupTempRoots, tempRoot } from './temp-roots.js';
import type { ActivityContext, ActivityEvent } from '../types.js';

// #1600 OR41 C8d — Get metadata · Wait until on a file system path (catalogue §4.3).

let root: string;
let outside: string;
beforeEach(() => {
  root = tempRoot('fs-wait-root-');
  outside = tempRoot('fs-wait-out-');
});
afterEach(cleanupTempRoots);

async function check(input: Record<string, unknown>): Promise<ActivityEvent> {
  const events: ActivityEvent[] = [];
  const c: ActivityContext = {
    runId: 'run_1',
    nodeId: 'n1',
    attemptId: 'n1#0',
    activityType: 'get_metadata',
    input: { fieldList: ['itemName'], checkEverySeconds: 5, giveUpAfterSeconds: 60, ...input },
    connectionConfig: { roots: [root] },
    signal: new AbortController().signal,
  };
  for await (const ev of fsAdapter.runActivity(c, null)) events.push(ev);
  expect(events).toHaveLength(1);
  return events[0]!;
}

const notReady = (reason: string) => ({
  type: 'notReady',
  reason,
  recheckAfterSeconds: 5,
  giveUpAfterSeconds: 60,
});

describe('get_metadata — Wait until', () => {
  it('It exists: not ready while missing, even with Exists unticked, then the ticked fields', async () => {
    expect(await check({ path: 'in/a.csv', waitUntil: 'exists' })).toEqual(
      notReady("'in/a.csv' does not exist yet"),
    );
    await mkdir(join(root, 'in'));
    expect(await check({ path: 'in/a.csv', waitUntil: 'exists' })).toEqual(
      notReady("'in/a.csv' does not exist yet"),
    );
    await writeFile(join(root, 'in', 'a.csv'), '');
    expect(await check({ path: 'in/a.csv', waitUntil: 'exists' })).toEqual({
      type: 'succeeded',
      outputs: expect.objectContaining({ itemName: 'a.csv', exists: null }),
    });
  });

  it('It is not empty: a file with bytes, or a folder with an entry', async () => {
    await writeFile(join(root, 'a.csv'), '');
    expect(await check({ path: 'a.csv', waitUntil: 'nonEmpty' })).toEqual(
      notReady("'a.csv' is empty"),
    );
    await writeFile(join(root, 'a.csv'), 'id\n');
    expect((await check({ path: 'a.csv', waitUntil: 'nonEmpty' })).type).toBe('succeeded');

    await mkdir(join(root, 'drop'));
    expect(await check({ path: 'drop', waitUntil: 'nonEmpty' })).toEqual(
      notReady("'drop' is an empty folder"),
    );
    await writeFile(join(root, 'drop', 'x'), 'x');
    expect((await check({ path: 'drop', waitUntil: 'nonEmpty' })).type).toBe('succeeded');
  });

  it('It is at least N bytes: waits for the size, and fails on a folder', async () => {
    await writeFile(join(root, 'a.csv'), '12345');
    expect(await check({ path: 'a.csv', waitUntil: 'minimumSize', minimumSize: 6 })).toEqual(
      notReady("'a.csv' is 5 bytes, waiting for 6"),
    );
    expect((await check({ path: 'a.csv', waitUntil: 'minimumSize', minimumSize: 5 })).type).toBe(
      'succeeded',
    );
    await mkdir(join(root, 'd'));
    expect(await check({ path: 'd', waitUntil: 'minimumSize', minimumSize: 1 })).toMatchObject({
      type: 'failed',
      kind: 'permanent',
      error: "It is at least N bytes needs a file, and 'd' is a directory",
    });
  });

  it('still refuses a path outside the allowed folders, rather than wait for it', async () => {
    const ev = await check({ path: join(outside, 'later.csv'), waitUntil: 'exists' });
    expect(ev).toMatchObject({ type: 'failed', kind: 'permanent' });
  });

  it('reads once with Wait until off: a missing path fails as before', async () => {
    expect(await check({ path: 'nope.csv' })).toMatchObject({ type: 'failed' });
  });
});
