import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GET_METADATA_FILE_DATASET_FIELDS, type DatasetKind } from '@autonomy-studio/shared';
import { fsAdapter } from '../fs.js';
import { cleanupTempRoots, tempRoot } from './temp-roots.js';
import { buildXlsx } from './xlsx-fixtures.js';
import type { ActivityContext, ActivityEvent, ResolvedDataset } from '../types.js';

// #1600 OR41 C8c-2 — Get metadata on a delimited or Excel dataset (catalogue
// §4.3): a file's fields through the dataset's path, and its columns through the
// dataset's own reader.

let root: string;
beforeEach(() => {
  root = tempRoot('fs-ds-meta-');
});
afterEach(cleanupTempRoots);

const csv = (config: Record<string, unknown>): ResolvedDataset => ({
  id: 'ds_1',
  name: 'orders',
  kind: 'delimited',
  config: { header: true, ...config },
  columns: [],
});
const sheet = (config: Record<string, unknown>, kind: DatasetKind = 'excel'): ResolvedDataset => ({
  id: 'ds_2',
  name: 'sales',
  kind,
  config: { header: true, sheet: 'Sales', ...config },
  columns: [],
});

async function run(input: Record<string, unknown>, source: ResolvedDataset) {
  const events: ActivityEvent[] = [];
  const c: ActivityContext = {
    runId: 'run_1',
    nodeId: 'n1',
    attemptId: 'n1#0',
    activityType: 'get_metadata',
    input,
    connectionConfig: { roots: [root] },
    datasets: { source },
    signal: new AbortController().signal,
  };
  for await (const ev of fsAdapter.runActivity(c, null)) events.push(ev);
  expect(events).toHaveLength(1);
  return events[0]!;
}

async function outputsOf(input: Record<string, unknown>, source: ResolvedDataset) {
  const ev = await run(input, source);
  if (ev.type !== 'succeeded') throw new Error(`expected success, got ${JSON.stringify(ev)}`);
  return ev.outputs as Record<string, unknown>;
}

async function failureOf(input: Record<string, unknown>, source: ResolvedDataset) {
  const ev = await run(input, source);
  if (ev.type !== 'failed') throw new Error(`expected failure, got ${JSON.stringify(ev)}`);
  return ev;
}

describe('get_metadata — a delimited dataset', () => {
  it("reads its file's fields and its header's columns, each a string", async () => {
    await writeFile(join(root, 'orders.csv'), 'id,name\n1,a\n2,b\n', 'utf8');
    const out = await outputsOf(
      { fieldList: [...GET_METADATA_FILE_DATASET_FIELDS] },
      csv({ path: 'orders.csv' }),
    );
    expect(out).toMatchObject({
      path: join(root, 'orders.csv'),
      exists: true,
      itemName: 'orders.csv',
      itemType: 'file',
      size: 16,
      structure: [
        { name: 'id', type: 'string' },
        { name: 'name', type: 'string' },
      ],
      columnCount: 2,
      childItems: null,
      rowCount: null,
    });
  });

  it('fills only what is ticked', async () => {
    await writeFile(join(root, 'orders.csv'), 'id;name\n1;a\n', 'utf8');
    const out = await outputsOf(
      { fieldList: ['columnCount'] },
      csv({ path: 'orders.csv', delimiter: ';' }),
    );
    expect(out).toMatchObject({ columnCount: 2, structure: null, exists: null, size: null });
  });

  it("names a header-less file's columns by position, as Copy does", async () => {
    await writeFile(join(root, 'raw.csv'), '1,a,x\n', 'utf8');
    const out = await outputsOf(
      { fieldList: ['structure'] },
      csv({ path: 'raw.csv', header: false }),
    );
    expect(out['structure']).toEqual([
      { name: 'column1', type: 'string' },
      { name: 'column2', type: 'string' },
      { name: 'column3', type: 'string' },
    ]);
  });

  it('with Exists ticked, a missing file is exists: false and its columns null', async () => {
    const out = await outputsOf(
      { fieldList: ['exists', 'structure', 'columnCount'] },
      csv({ path: 'later.csv' }),
    );
    expect(out).toMatchObject({ exists: false, structure: null, columnCount: null });
  });

  it('without Exists, a missing file fails', async () => {
    expect(await failureOf({ fieldList: ['structure'] }, csv({ path: 'later.csv' }))).toMatchObject(
      { kind: 'permanent' },
    );
  });

  it("an empty file has no header to read, and fails with the reader's reason", async () => {
    await writeFile(join(root, 'empty.csv'), '', 'utf8');
    const ev = await failureOf({ fieldList: ['columnCount'] }, csv({ path: 'empty.csv' }));
    expect(ev.kind).toBe('permanent');
    expect(ev.error).toMatch(/empty\.csv/);
  });

  it('refuses a folder before its reader is asked to open it', async () => {
    await mkdir(join(root, 'in'));
    expect(await failureOf({ fieldList: ['structure'] }, csv({ path: 'in' }))).toMatchObject({
      kind: 'permanent',
      error: "Structure needs a file, and 'in' is a directory",
    });
    expect(
      await failureOf({ fieldList: ['structure', 'columnCount'] }, csv({ path: 'in' })),
    ).toMatchObject({ error: "Structure and Column count need a file, and 'in' is a directory" });
  });

  it('refuses what a dataset cannot answer, and a path beside it', async () => {
    await writeFile(join(root, 'orders.csv'), 'id\n1\n', 'utf8');
    const ds = csv({ path: 'orders.csv' });
    expect(await failureOf({ fieldList: ['childItems'] }, ds)).toMatchObject({
      kind: 'permanent',
      error: 'Child items read a folder path, not a dataset',
    });
    expect(await failureOf({ fieldList: ['rowCount'] }, ds)).toMatchObject({
      kind: 'permanent',
      error: 'Row count read a database table, not a file',
    });
    expect(await failureOf({ path: 'orders.csv', fieldList: ['exists'] }, ds)).toMatchObject({
      kind: 'permanent',
      error: 'a dataset chosen on Source names what to read; clear File or folder path',
    });
  });

  it('never reads outside the roots, whatever the dataset says', async () => {
    const outside = tempRoot('fs-ds-meta-out-');
    await writeFile(join(outside, 'x.csv'), 'id\n1\n', 'utf8');
    const ev = await failureOf(
      { fieldList: ['exists', 'structure'] },
      csv({ path: join(outside, 'x.csv') }),
    );
    expect(ev).toMatchObject({ kind: 'permanent' });
    expect(ev.error).toMatch(/outside the allowed roots/);
  });
});

describe('get_metadata — an Excel dataset', () => {
  const book = () =>
    buildXlsx({
      sheets: [
        {
          name: 'Sales',
          rows: [
            [
              { kind: 'inline', text: 'region' },
              { kind: 'inline', text: 'total' },
            ],
            [
              { kind: 'inline', text: 'north' },
              { kind: 'number', value: 3 },
            ],
          ],
        },
      ],
    });

  it("reads the sheet's header, each column of no declared type", async () => {
    await writeFile(join(root, 'sales.xlsx'), book());
    const out = await outputsOf(
      { fieldList: ['exists', 'structure', 'columnCount'] },
      sheet({ path: 'sales.xlsx' }),
    );
    expect(out).toMatchObject({
      exists: true,
      structure: [
        { name: 'region', type: '' },
        { name: 'total', type: '' },
      ],
      columnCount: 2,
    });
  });

  it('Exists answers for the file, so a missing sheet fails', async () => {
    await writeFile(join(root, 'sales.xlsx'), book());
    const ev = await failureOf(
      { fieldList: ['exists', 'structure'] },
      sheet({ path: 'sales.xlsx', sheet: 'Returns' }),
    );
    expect(ev.kind).toBe('permanent');
    expect(ev.error).toMatch(/Returns/);
  });
});

// #1600 OR41 C8d-2a — Wait until on a delimited or Excel dataset: the wait is on
// the dataset's own file, as C8d-1's is on a path.
describe('get_metadata — Wait until on a file dataset', () => {
  const timers = { checkEverySeconds: 5, giveUpAfterSeconds: 60 };
  const notReady = (reason: string) => ({
    type: 'notReady',
    reason,
    recheckAfterSeconds: 5,
    giveUpAfterSeconds: 60,
  });

  it('It exists: not ready while its folder is missing, then its columns', async () => {
    const input = { fieldList: ['columnCount'], waitUntil: 'exists', ...timers };
    const source = csv({ path: 'later/orders.csv' });
    expect(await run(input, source)).toEqual(notReady("'later/orders.csv' does not exist yet"));
    await mkdir(join(root, 'later'));
    expect(await run(input, source)).toEqual(notReady("'later/orders.csv' does not exist yet"));
    await writeFile(join(root, 'later', 'orders.csv'), 'id,name\n1,a\n', 'utf8');
    expect(await outputsOf(input, source)).toMatchObject({ columnCount: 2 });
  });

  it('It is not empty and It is at least N bytes: on the dataset file', async () => {
    await writeFile(join(root, 'orders.csv'), '', 'utf8');
    const source = csv({ path: 'orders.csv' });
    expect(await run({ fieldList: ['size'], waitUntil: 'nonEmpty', ...timers }, source)).toEqual(
      notReady("'orders.csv' is empty"),
    );
    const atLeast = { fieldList: ['size'], waitUntil: 'minimumSize', minimumSize: 8, ...timers };
    await writeFile(join(root, 'orders.csv'), 'id\n1\n', 'utf8');
    expect(await run(atLeast, source)).toEqual(notReady("'orders.csv' is 5 bytes, waiting for 8"));
    await writeFile(join(root, 'orders.csv'), 'id\n1\n2\n3\n', 'utf8');
    expect(await outputsOf(atLeast, source)).toMatchObject({ size: 9 });
  });

  it('waits for an Excel workbook the same way', async () => {
    const input = { fieldList: ['exists'], waitUntil: 'exists', ...timers };
    expect(await run(input, sheet({ path: 'in/sales.xlsx' }))).toEqual(
      notReady("'in/sales.xlsx' does not exist yet"),
    );
  });
});
