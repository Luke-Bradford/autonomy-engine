import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  FILE_LIST_ACTIVITY_TYPE,
  GET_METADATA_ACTIVITY_TYPE,
  GET_METADATA_FS_FIELDS,
  getActivity,
  getMetadataConfigSchema,
  lowerRetiredTypes,
  type Node,
} from '@autonomy-studio/shared';
import { fsAdapter } from '../fs.js';
import { cleanupTempRoots, tempRoot } from './temp-roots.js';
import type { ActivityContext, ActivityEvent } from '../types.js';

// #1600 OR41 C8a — Get metadata on a file system connection (catalogue §4.3).

let root: string;
let outside: string;
beforeEach(() => {
  root = tempRoot('fs-meta-root-');
  outside = tempRoot('fs-meta-out-');
});
afterEach(cleanupTempRoots);

type Outputs = Record<string, unknown>;

async function run(
  input: Record<string, unknown>,
  over: { maxEntries?: number; signal?: AbortSignal } = {},
): Promise<ActivityEvent> {
  const events: ActivityEvent[] = [];
  const c: ActivityContext = {
    runId: 'run_1',
    nodeId: 'n1',
    attemptId: 'n1#0',
    activityType: 'get_metadata',
    input: { childFilter: '*', childType: 'all', ...input },
    connectionConfig: {
      roots: [root],
      ...(over.maxEntries === undefined ? {} : { maxEntries: over.maxEntries }),
    },
    signal: over.signal ?? new AbortController().signal,
  };
  for await (const ev of fsAdapter.runActivity(c, null)) events.push(ev);
  expect(events).toHaveLength(1);
  return events[0]!;
}

async function outputsOf(input: Record<string, unknown>): Promise<Outputs> {
  const ev = await run(input);
  if (ev.type !== 'succeeded') throw new Error(`expected success, got ${JSON.stringify(ev)}`);
  return ev.outputs as Outputs;
}

async function failureOf(
  input: Record<string, unknown>,
  over: { maxEntries?: number; signal?: AbortSignal } = {},
) {
  const ev = await run(input, over);
  if (ev.type !== 'failed') throw new Error(`expected failure, got ${JSON.stringify(ev)}`);
  return ev;
}

describe('get_metadata — a file', () => {
  it('reads every ticked field, and the outputs satisfy the catalog contract', async () => {
    await writeFile(join(root, 'a.csv'), 'id\n1\n', 'utf8');
    await utimes(
      join(root, 'a.csv'),
      new Date('2026-10-01T00:00:00Z'),
      new Date('2026-10-02T03:04:05Z'),
    );
    const fieldList = GET_METADATA_FS_FIELDS.filter((f) => f !== 'childItems');
    const out = await outputsOf({ path: 'a.csv', fieldList });
    expect(out).toMatchObject({
      path: join(root, 'a.csv'),
      exists: true,
      itemName: 'a.csv',
      itemType: 'file',
      size: 5,
      lastModified: '2026-10-02T03:04:05.000Z',
      contentMD5: createHash('md5').update('id\n1\n').digest('base64'),
      childItems: null,
    });
    expect(out.created === null || typeof out.created === 'string').toBe(true);
    // Every declared output is there with its declared type (or null when optional).
    for (const o of getActivity('get_metadata')!.outputs!) {
      const value = out[o.name];
      if (o.optional === true && value === null) continue;
      expect(o.type === 'json' ? value !== undefined : typeof value, o.name).toBe(
        o.type === 'json' ? true : o.type,
      );
    }
  });

  it('outputs null for every field it was not asked for', async () => {
    await writeFile(join(root, 'a.csv'), 'x', 'utf8');
    const out = await outputsOf({ path: 'a.csv', fieldList: ['size'] });
    expect(out).toEqual({
      path: join(root, 'a.csv'),
      exists: null,
      itemName: null,
      itemType: null,
      size: 1,
      created: null,
      lastModified: null,
      contentMD5: null,
      childItems: null,
    });
  });

  it('fails Child items on a file, so a lowered file_list still does', async () => {
    await writeFile(join(root, 'a.csv'), 'x', 'utf8');
    const ev = await failureOf({ path: 'a.csv', fieldList: ['childItems'] });
    expect(ev.kind).toBe('permanent');
    expect(ev.error).toBe("Child items needs a folder, and 'a.csv' is a file");
  });
});

describe('get_metadata — a folder', () => {
  it('lists child items sorted by name, each with its size and time', async () => {
    await writeFile(join(root, 'b.csv'), 'bb', 'utf8');
    await writeFile(join(root, 'a.txt'), 'a', 'utf8');
    await mkdir(join(root, 'C'));
    await symlink(join(root, 'a.txt'), join(root, 'link'));
    const out = await outputsOf({ path: '.', fieldList: ['itemType', 'size', 'childItems'] });
    expect(out.itemType).toBe('directory');
    expect(out.size).toBeNull();
    const items = out.childItems as Array<Record<string, unknown>>;
    expect(items.map((i) => [i.name, i.type, i.size])).toEqual([
      ['C', 'directory', null],
      ['a.txt', 'file', 1],
      ['b.csv', 'file', 2],
      ['link', 'symlink', null],
    ]);
    for (const item of items) expect(typeof item.lastModified).toBe('string');
    const declared = getActivity('get_metadata')!.outputElements!.childItems!.map((f) => f.name);
    expect(Object.keys(items[0]!).sort()).toEqual([...declared].sort());
  });

  it('filters child items by wildcard and by type', async () => {
    await writeFile(join(root, 'a.csv'), 'a', 'utf8');
    await writeFile(join(root, 'b.txt'), 'b', 'utf8');
    await mkdir(join(root, 'c.csv'));
    const names = async (extra: Record<string, unknown>) =>
      (
        (await outputsOf({ path: '.', fieldList: ['childItems'], ...extra })).childItems as Array<{
          name: string;
        }>
      ).map((i) => i.name);
    expect(await names({ childFilter: '*.csv' })).toEqual(['a.csv', 'c.csv']);
    expect(await names({ childFilter: '*.csv', childType: 'files' })).toEqual(['a.csv']);
    expect(await names({ childType: 'folders' })).toEqual(['c.csv']);
  });

  it('leaves folders out and filters files by a modified window, as ADF does', async () => {
    await writeFile(join(root, 'old.csv'), 'o', 'utf8');
    await writeFile(join(root, 'new.csv'), 'n', 'utf8');
    await mkdir(join(root, 'dir'));
    await utimes(
      join(root, 'old.csv'),
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-01-01T00:00:00Z'),
    );
    await utimes(
      join(root, 'new.csv'),
      new Date('2026-10-01T00:00:00Z'),
      new Date('2026-10-01T00:00:00Z'),
    );
    await utimes(
      join(root, 'dir'),
      new Date('2026-10-01T00:00:00Z'),
      new Date('2026-10-01T00:00:00Z'),
    );
    const out = await outputsOf({
      path: '.',
      fieldList: ['childItems'],
      modifiedStart: '2026-09-01T00:00:00Z',
    });
    expect((out.childItems as Array<{ name: string }>).map((i) => i.name)).toEqual(['new.csv']);
  });

  it('counts every entry it visits against the list limit, matched or not', async () => {
    for (const n of ['a', 'b', 'c']) await writeFile(join(root, `${n}.txt`), n, 'utf8');
    const ev = await failureOf(
      { path: '.', fieldList: ['childItems'], childFilter: '*.csv' },
      { maxEntries: 2 },
    );
    expect(ev).toMatchObject({
      kind: 'permanent',
      error: 'folder has more than the 2-entry list limit',
    });
  });
});

describe('get_metadata — a path that is not there', () => {
  it('answers exists false with Exists ticked, the missing parent included', async () => {
    expect(await outputsOf({ path: 'nope.csv', fieldList: ['exists', 'size'] })).toMatchObject({
      exists: false,
      size: null,
      path: join(root, 'nope.csv'),
    });
    expect(await outputsOf({ path: 'no/such/dir.csv', fieldList: ['exists'] })).toMatchObject({
      exists: false,
      path: join(root, 'no', 'such', 'dir.csv'),
    });
    // ENOTDIR: a component is a file.
    await writeFile(join(root, 'f.txt'), 'x', 'utf8');
    expect(await outputsOf({ path: 'f.txt/x/y', fieldList: ['exists'] })).toMatchObject({
      exists: false,
    });
  });

  it('fails without Exists ticked', async () => {
    const ev = await failureOf({ path: 'nope.csv', fieldList: ['size'] });
    expect(ev.error).toMatch(/ENOENT/);
  });

  it('never answers for a path outside the roots, through a link or not', async () => {
    // A missing path whose nearest real ancestor is outside the roots is refused
    // as it always was, not answered `exists:false`: that answer would tell an
    // existing outside folder from a missing one.
    await symlink(outside, join(root, 'out'));
    for (const path of [join(outside, 'nope', 'x'), 'out/nope/x', join(outside, 'x')]) {
      const ev = await run({ path, fieldList: ['exists'] });
      expect(ev.type, path).toBe('failed');
    }
    await mkdir(join(outside, 'there'));
    expect((await run({ path: 'out/there/x', fieldList: ['exists'] })).type).toBe('failed');
  });

  it('refuses a symlink at the path even with Exists ticked', async () => {
    await writeFile(join(root, 'a.txt'), 'a', 'utf8');
    await symlink(join(root, 'a.txt'), join(root, 'l'));
    const ev = await failureOf({ path: 'l', fieldList: ['exists'] });
    expect(ev.error).toMatch(/symlink/);
  });
});

describe('get_metadata — dispatch', () => {
  it('refuses a config its schema refuses', async () => {
    const ev = await failureOf({ path: '.', fieldList: [] });
    expect(ev.error).toMatch(/^invalid get_metadata activity config: .*tick at least one field/);
  });

  it('stops on cancel', async () => {
    await writeFile(join(root, 'a.txt'), 'a', 'utf8');
    const ac = new AbortController();
    ac.abort();
    const ev = await failureOf({ path: '.', fieldList: ['childItems'] }, { signal: ac.signal });
    expect(ev.kind).toBe('cancelled');
  });
});

describe('get_metadata — edges the lenses asked for', () => {
  it('never walks past a dangling link, whose target may be outside', async () => {
    // `realpath` cannot resolve `root/dangling`, but it is there: walking past
    // it to `root` would answer for `outside/gone/x`.
    await symlink(join(outside, 'gone'), join(root, 'dangling'));
    expect((await run({ path: 'dangling/x', fieldList: ['exists'] })).type).toBe('failed');
  });

  it('reads Modified before as exclusive', async () => {
    await writeFile(join(root, 'edge.csv'), 'e', 'utf8');
    await writeFile(join(root, 'early.csv'), 'e', 'utf8');
    const at = new Date('2026-10-01T00:00:00Z');
    await utimes(join(root, 'edge.csv'), at, at);
    await utimes(
      join(root, 'early.csv'),
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-09-01T00:00:00Z'),
    );
    const out = await outputsOf({
      path: '.',
      fieldList: ['childItems'],
      modifiedEnd: '2026-10-01T00:00:00Z',
    });
    expect((out.childItems as Array<{ name: string }>).map((i) => i.name)).toEqual(['early.csv']);
  });

  it('lists exactly the limit without failing', async () => {
    for (const n of ['a', 'b']) await writeFile(join(root, `${n}.txt`), n, 'utf8');
    const ev = await run({ path: '.', fieldList: ['childItems'] }, { maxEntries: 2 });
    expect(ev.type).toBe('succeeded');
  });

  it('says a folder exists and has no size or MD5', async () => {
    await mkdir(join(root, 'd'));
    expect(
      await outputsOf({ path: 'd', fieldList: ['exists', 'itemName', 'size', 'contentMD5'] }),
    ).toMatchObject({ exists: true, itemName: 'd', size: null, contentMD5: null });
  });
});

// #1600 OR41 C8b — a stored List directory opens as Get metadata · Child items
// (`retired.ts`). After its next Save it runs as that, so the two must agree on
// what an author's pipeline reads: the same entries by name and type, the same
// path, and a failure wherever List directory failed. The deliberate
// differences (sorted, more fields per item) are in the catalogue's §4.3.
describe('get_metadata — the lowered file_list answers as List directory did', () => {
  async function dispatch(type: string, input: Record<string, unknown>, maxEntries?: number) {
    const events: ActivityEvent[] = [];
    const c: ActivityContext = {
      runId: 'run_1',
      nodeId: 'list',
      attemptId: 'list#0',
      activityType: type,
      input,
      connectionConfig: { roots: [root], ...(maxEntries === undefined ? {} : { maxEntries }) },
      signal: new AbortController().signal,
    };
    for await (const ev of fsAdapter.runActivity(c, null)) events.push(ev);
    expect(events).toHaveLength(1);
    return events[0]!;
  }
  /** Both ways: the stored `file_list`, and the Get metadata it opens as. */
  async function both(path: string, maxEntries?: number) {
    const stored = {
      id: 'list',
      type: FILE_LIST_ACTIVITY_TYPE,
      config: { path },
      connectionId: 'c',
      position: { x: 0, y: 0 },
    } as Node;
    const lowered = lowerRetiredTypes({ nodes: [stored], containers: [] }).nodes[0]!;
    expect(lowered.type).toBe(GET_METADATA_ACTIVITY_TYPE);
    // The dispatch input is the config the schema parses, `outputs` aside.
    const { outputs: _contract, ...config } = lowered.config;
    const input = getMetadataConfigSchema.parse(config);
    return {
      old: await dispatch(FILE_LIST_ACTIVITY_TYPE, { path }, maxEntries),
      now: await dispatch(GET_METADATA_ACTIVITY_TYPE, input, maxEntries),
    };
  }
  const named = (items: unknown) =>
    (items as { name: string; type: string }[])
      .map(({ name, type }) => ({ name, type }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  it('the same entries by name and type, a dotfile and a link included, and the same path', async () => {
    await mkdir(join(root, 'in', 'sub'), { recursive: true });
    await writeFile(join(root, 'in', 'b.csv'), 'x', 'utf8');
    await writeFile(join(root, 'in', '.hidden'), 'x', 'utf8');
    await symlink(join(root, 'in', 'b.csv'), join(root, 'in', 'link'));
    const { old, now } = await both('in');
    if (old.type !== 'succeeded' || now.type !== 'succeeded') throw new Error('expected success');
    expect(named(now.outputs['childItems'])).toEqual(named(old.outputs['entries']));
    expect(named(old.outputs['entries'])).toEqual([
      { name: '.hidden', type: 'file' },
      { name: 'b.csv', type: 'file' },
      { name: 'link', type: 'symlink' },
      { name: 'sub', type: 'directory' },
    ]);
    expect(now.outputs['path']).toBe(old.outputs['path']);
  });

  it.each([
    ['a file', async () => writeFile(join(root, 'a.csv'), 'x', 'utf8'), 'a.csv'],
    ['a missing path', async () => undefined, 'nope'],
  ])('fails permanently on %s, as List directory does', async (_why, setUp, path) => {
    await setUp();
    const { old, now } = await both(path);
    expect([old.type, now.type]).toEqual(['failed', 'failed']);
    expect(old.type === 'failed' && now.type === 'failed' && [old.kind, now.kind]).toEqual([
      'permanent',
      'permanent',
    ]);
  });

  it('the same list limit: exactly the limit lists, one more fails', async () => {
    for (const n of ['a', 'b', 'c']) await writeFile(join(root, n), 'x', 'utf8');
    const at = await both('.', 3);
    expect([at.old.type, at.now.type]).toEqual(['succeeded', 'succeeded']);
    const over = await both('.', 2);
    expect([over.old.type, over.now.type]).toEqual(['failed', 'failed']);
  });
});
