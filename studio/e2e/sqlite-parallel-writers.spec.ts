import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from '@playwright/test';
import { STARTER_TEMPLATES } from '../packages/web/src/pages/pipeline/starterTemplates';
import {
  fireAndSettle,
  seedVersion,
  type SeedContainer,
  type SeedEdge,
  type SeedNode,
} from './support/seedDoc';
import { seedConnection, seedDataset } from './support/seedResources';

/**
 * #1423 — two copies writing ONE sqlite file at the same time, in one run.
 *
 * The sink holds `begin immediate` across its between-batch yields, and
 * better-sqlite3's busy wait is synchronous, so a sibling copy used to freeze
 * the event loop for 250ms and fail `database is locked` (transient, retry 0 by
 * default → the run failed). The operator's demo hit it with two ordinary
 * parallel Copy branches; a parallel ForEach hits it on its sibling items.
 *
 * Each copy moves several `COPY_BATCH_ROWS` (1000) batches, because a one-batch
 * copy never yields mid-transaction and would pass with or without the fix.
 * Mutation-proved: with the sink's per-store queue removed, both tests fail.
 */

/** Rows per CSV — several batches each, and enough that siblings overlap. */
const ROWS = 4000;
async function warehouse(page: Page, tag: string, root: string, dbPath: string) {
  return seedConnection(page, {
    name: `${tag} warehouse`,
    kind: 'sqlite',
    config: { roots: [root], path: dbPath, writable: true },
  });
}

function tableDataset(page: Page, tag: string, connectionId: string, table: string) {
  return seedDataset(page, {
    name: `${tag} ${table}`,
    kind: 'table',
    connectionId,
    config: { table },
    columns: [
      { name: 'id', type: 'integer', nullable: true },
      { name: 'name', type: 'string', nullable: true },
    ],
  });
}

function csvDataset(page: Page, tag: string, connectionId: string, path: string) {
  return seedDataset(page, {
    name: `${tag} csv`,
    kind: 'delimited',
    connectionId,
    config: { path, header: true },
    parameters: ['path'],
    columns: [
      { name: 'id', type: 'string', nullable: false },
      { name: 'name', type: 'string', nullable: true },
    ],
  });
}

const MAPPING = [
  { source: 'id', sink: 'id', type: 'integer' },
  { source: 'name', sink: 'name', type: 'string' },
];

test('#1423 — two parallel Copy branches into one sqlite file both land', async ({ page }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1423a-')));
  try {
    /* The demo's shape: two branches, each writing its own table in the SAME
       file, from one CSV. */
    const csv = join(root, 'orders.csv');
    const lines = ['id,name'];
    for (let i = 1; i <= ROWS; i += 1) lines.push(`${i},row-${i}`);
    writeFileSync(csv, `${lines.join('\n')}\n`);
    const dbPath = join(root, 'warehouse.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE clean_a (id INTEGER, name TEXT)');
    db.exec('CREATE TABLE clean_b (id INTEGER, name TEXT)');
    db.close();

    const tag = '#1423 branches';
    const folder = await seedConnection(page, {
      name: `${tag} landing folder`,
      kind: 'fs',
      config: { roots: [root] },
    });
    const store = await warehouse(page, tag, root, dbPath);
    const orders = await csvDataset(page, tag, folder, csv);
    const cleanA = await tableDataset(page, tag, store, 'clean_a');
    const cleanB = await tableDataset(page, tag, store, 'clean_b');

    const copyInto = (id: string, sink: string, y: number): SeedNode => ({
      id,
      type: 'copy',
      position: { x: 300, y },
      connectionIds: { source: folder, sink: store },
      datasetIds: { source: orders, sink },
      config: { mapping: MAPPING, mode: 'append' },
    });
    // Fanned out from one upstream node (a zero-second wait, there only to be
    // that node), as the demo's branches are. Two ROOT
    // copies were measured to run one after the other (the second dispatched
    // only once the first finished), so a root pair never contends — that is #1488,
    // and this shape is the one that does.
    const { pipelineVersionId } = await seedVersion(page, `${tag} pipeline`, {
      nodes: [
        { id: 'start', type: 'wait', config: { seconds: '${0}' }, position: { x: 0, y: 60 } },
        copyInto('a', cleanA, 0),
        copyInto('b', cleanB, 120),
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'a', on: 'success' },
        { id: 'e2', from: 'start', to: 'b', on: 'success' },
      ],
    });

    const runId = await fireAndSettle(page, pipelineVersionId, `${tag} run`);
    const run = await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
    expect(run.status, `run: ${JSON.stringify(run)}`).toBe('success');

    const back = new DatabaseSync(dbPath, { readOnly: true });
    for (const table of ['clean_a', 'clean_b']) {
      expect(back.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: ROWS });
    }
    back.close();

    /* They really did overlap: both copies were dispatched before either
       finished. Without this the spec could pass on a serial schedule. */
    const events = (await (
      await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
    ).json()) as { type: string; payload: Record<string, unknown> }[];
    const at = (type: string, nodeId: string) =>
      events.findIndex((e) => e.type === type && e.payload.nodeId === nodeId);
    const lastDispatch = Math.max(at('node.dispatched', 'a'), at('node.dispatched', 'b'));
    const firstFinish = Math.min(
      ...events.flatMap((e, i) =>
        e.type === 'node.succeeded' && ['a', 'b'].includes(String(e.payload.nodeId)) ? [i] : [],
      ),
    );
    expect(lastDispatch).toBeGreaterThanOrEqual(0);
    expect(lastDispatch).toBeLessThan(firstFinish);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#1423 — a PARALLEL ForEach (batchCount 3) copies every file into one table', async ({
  page,
}) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1423b-')));
  try {
    const inDir = join(root, 'in');
    mkdirSync(inDir);
    const names = ['a.csv', 'b.csv', 'c.csv'];
    names.forEach((name, f) => {
      const lines = ['id,name'];
      for (let i = 1; i <= ROWS; i += 1) lines.push(`${f * ROWS + i},row-${f}-${i}`);
      writeFileSync(join(inDir, name), `${lines.join('\n')}\n`);
    });
    const dbPath = join(root, 'warehouse.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE people (id INTEGER, name TEXT)');
    db.close();

    const tag = '#1423 foreach';
    const folder = await seedConnection(page, {
      name: `${tag} landing folder`,
      kind: 'fs',
      config: { roots: [root] },
    });
    const store = await warehouse(page, tag, root, dbPath);
    // Points at one real file; every dispatch overrides it per item.
    const source = await csvDataset(page, tag, folder, join(inDir, 'a.csv'));
    const sink = await tableDataset(page, tag, store, 'people');

    // The #1420 starter template, bound as `foreach-copy-folder.spec.ts` binds
    // it — with the one change under test: the ForEach runs items in parallel.
    const template = STARTER_TEMPLATES.find((t) => t.id === 'csv-folder-to-table')!;
    const bindings: Record<string, Partial<SeedNode>> = {
      list: { connectionId: folder, config: { path: inDir } },
      load: {
        connectionIds: { source: folder, sink: store },
        datasetIds: { source, sink },
        config: { mapping: MAPPING, mode: 'append' },
      },
    };
    const { pipelineVersionId } = await seedVersion(page, `${tag} pipeline`, {
      nodes: template.nodes.map((n): SeedNode => ({
        id: n.id,
        type: n.type,
        position: n.position,
        ...(n.datasetParams === undefined ? {} : { datasetParams: n.datasetParams }),
        ...bindings[n.id],
        config: { ...n.config, ...bindings[n.id]?.config },
      })),
      edges: template.edges.map((e): SeedEdge => ({ ...e })),
      containers: template.containers.map((c): SeedContainer =>
        c.kind === 'foreach' ? { ...c, batchCount: 3 } : { ...c },
      ),
    });

    const runId = await fireAndSettle(page, pipelineVersionId, `${tag} run`);
    const run = await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
    expect(run.status, `run: ${JSON.stringify(run)}`).toBe('success');

    const back = new DatabaseSync(dbPath, { readOnly: true });
    expect(back.prepare('SELECT count(*) AS n, count(DISTINCT id) AS d FROM people').get()).toEqual(
      {
        n: 3 * ROWS,
        d: 3 * ROWS,
      },
    );
    back.close();

    // Parallel, not quietly sequential: all three items were dispatched before
    // any of them finished. A sequential ForEach dispatches the same three ids.
    const events = (await (
      await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
    ).json()) as { type: string; payload: Record<string, unknown> }[];
    const isLoad = (e: { payload: Record<string, unknown> }) =>
      /^load@\d+$/.test(String(e.payload.nodeId));
    const dispatched = events.flatMap((e, i) =>
      e.type === 'node.dispatched' && isLoad(e) ? [i] : [],
    );
    const firstFinish = events.findIndex((e) => e.type === 'node.succeeded' && isLoad(e));
    expect(dispatched).toHaveLength(3);
    expect(firstFinish).toBeGreaterThan(Math.max(...dispatched));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
