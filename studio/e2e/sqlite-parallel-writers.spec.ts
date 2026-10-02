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
 * parallel Copy branches; a parallel ForEach hits it on every sibling item.
 *
 * Each copy moves several `COPY_BATCH_ROWS` (1000) batches, because a one-batch
 * copy never yields mid-transaction and would pass with or without the fix.
 * Mutation-proved: with the sink's per-store queue removed, both tests fail.
 */

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

const MAPPING = [
  { source: 'id', sink: 'id', type: 'integer' },
  { source: 'name', sink: 'name', type: 'string' },
];

test('#1423 — two parallel Copy branches into one sqlite file both land', async ({ page }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1423a-')));
  try {
    /* The demo's shape: a staging table, read by two branches that each write
       their own table in the SAME file. */
    const dbPath = join(root, 'warehouse.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE staging (id INTEGER, name TEXT)');
    db.exec('CREATE TABLE clean_a (id INTEGER, name TEXT)');
    db.exec('CREATE TABLE clean_b (id INTEGER, name TEXT)');
    const insert = db.prepare('INSERT INTO staging (id, name) VALUES (?, ?)');
    db.exec('BEGIN');
    for (let i = 1; i <= ROWS; i += 1) insert.run(i, `row-${i}`);
    db.exec('COMMIT');
    db.close();

    const tag = '#1423 branches';
    const store = await warehouse(page, tag, root, dbPath);
    const staging = await tableDataset(page, tag, store, 'staging');
    const cleanA = await tableDataset(page, tag, store, 'clean_a');
    const cleanB = await tableDataset(page, tag, store, 'clean_b');

    const copyInto = (id: string, sink: string, y: number): SeedNode => ({
      id,
      type: 'copy',
      position: { x: 0, y },
      connectionIds: { source: store, sink: store },
      datasetIds: { source: staging, sink },
      config: { mapping: MAPPING, mode: 'append' },
    });
    // No edges: both are roots, so they dispatch together.
    const { pipelineVersionId } = await seedVersion(page, `${tag} pipeline`, {
      nodes: [copyInto('a', cleanA, 0), copyInto('b', cleanB, 120)],
      edges: [],
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
    const source = await seedDataset(page, {
      name: `${tag} any csv`,
      kind: 'delimited',
      connectionId: folder,
      config: { path: join(inDir, 'a.csv'), header: true },
      parameters: ['path'],
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'name', type: 'string', nullable: true },
      ],
    });
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

    // Parallel, not quietly sequential: the three items ran as instances.
    const events = (await (
      await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
    ).json()) as { type: string; payload: Record<string, unknown> }[];
    const loads = events
      .filter((e) => e.type === 'node.dispatched' && /^load@\d+$/.test(String(e.payload.nodeId)))
      .map((e) => e.payload.nodeId)
      .sort();
    expect(loads).toEqual(['load@0', 'load@1', 'load@2']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
