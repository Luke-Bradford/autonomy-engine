import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { STARTER_TEMPLATES } from '../packages/web/src/pages/pipeline/starterTemplates';
import {
  fireAndSettle,
  seedVersion,
  type SeedContainer,
  type SeedEdge,
  type SeedNode,
} from './support/seedDoc';
import { seedConnection, seedDataset } from './support/seedResources';
import { fluentRootReady } from './support/theme';

/**
 * #1420 (OR26) — "looks at files in a folder, then needs to iterate over each
 * file to copy them into a database". The operator's recipe, composed from
 * parts that each had coverage and had never been run TOGETHER:
 *
 *   List directory → Filter (files only) → ForEach { Copy data }
 *
 * with the copy's source path overridden PER ITEM through `datasetParams`, so
 * one CSV dataset serves every file in the folder. The folder holds a
 * sub-directory on purpose: without the filter the foreach would hand a
 * directory to the copy, so a filter that silently passed everything fails
 * the run rather than this spec passing by luck.
 *
 * SEQUENTIAL, which is studio's foreach default (`batchCount` absent). The
 * PARALLEL form of this recipe is `sqlite-parallel-writers.spec.ts`: sibling
 * iterations into one sqlite file used to fail `database is locked`, measured
 * while writing this spec and fixed by #1423's per-store write queue.
 *
 * `realpathSync` on the root: macOS `/var` is a symlink and `file_list`
 * reports the CANONICAL dir, which the copy then has to find inside the root.
 */
const FILES: Record<string, string> = {
  'a.csv': 'id,name\n1,alpha\n2,beta\n',
  'b.csv': 'id,name\n3,gamma\n',
  'c.csv': 'id,name\n4,delta\n5,epsilon\n6,zeta\n',
};

test('#1420 — ForEach over a listed folder copies every CSV into a table', async ({ page }) => {
  const problems = collectPageProblems(page);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1420-')));
  try {
    const inDir = join(root, 'in');
    mkdirSync(join(inDir, 'archive'), { recursive: true });
    for (const [name, body] of Object.entries(FILES)) writeFileSync(join(inDir, name), body);
    // Not a CSV: the template's filter keeps `.csv` files only, and a copy of
    // this through the CSV dataset would fail the run (#1413).
    writeFileSync(join(inDir, 'README.txt'), 'not a csv\n');
    const dbPath = join(root, 'warehouse.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE people (id INTEGER, name TEXT)');
    db.close();

    const tag = '#1420';
    const fsConnection = await seedConnection(page, {
      name: `${tag} landing folder`,
      kind: 'fs',
      config: { roots: [root] },
    });
    const sqliteConnection = await seedConnection(page, {
      name: `${tag} warehouse`,
      kind: 'sqlite',
      config: { roots: [root], path: dbPath, writable: true },
    });
    const sourceDataset = await seedDataset(page, {
      name: `${tag} any csv`,
      kind: 'delimited',
      connectionId: fsConnection,
      // Points at one real file; every dispatch overrides it per item.
      config: { path: join(inDir, 'a.csv'), header: true },
      parameters: ['path'],
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'name', type: 'string', nullable: true },
      ],
    });
    const sinkDataset = await seedDataset(page, {
      name: `${tag} people table`,
      kind: 'table',
      connectionId: sqliteConnection,
      config: { table: 'people' },
      columns: [
        { name: 'id', type: 'integer', nullable: true },
        { name: 'name', type: 'string', nullable: true },
      ],
    });

    /* #1413 — built FROM the starter template the empty canvas offers, bound
       the way an operator binds it: the folder on List directory, and the two
       stores, the two datasets and a mapping on Copy data. So this run is the
       proof that the template, not a hand-written lookalike, works end to end;
       a template edit that breaks its wiring fails here. */
    const template = STARTER_TEMPLATES.find((t) => t.id === 'csv-folder-to-table')!;
    const bindings: Record<string, Partial<SeedNode>> = {
      list: { connectionId: fsConnection, config: { path: inDir } },
      load: {
        connectionIds: { source: fsConnection, sink: sqliteConnection },
        datasetIds: { source: sourceDataset, sink: sinkDataset },
        config: {
          mapping: [
            { source: 'id', sink: 'id', type: 'integer' },
            { source: 'name', sink: 'name', type: 'string' },
          ],
          mode: 'append',
        },
      },
    };
    const { pipelineVersionId } = await seedVersion(page, `${tag} load folder`, {
      nodes: template.nodes.map((n): SeedNode => ({
        id: n.id,
        type: n.type,
        position: n.position,
        ...(n.datasetParams === undefined ? {} : { datasetParams: n.datasetParams }),
        ...bindings[n.id],
        config: { ...n.config, ...bindings[n.id]?.config },
      })),
      edges: template.edges.map((e): SeedEdge => ({ ...e })),
      containers: template.containers.map((c): SeedContainer => ({ ...c })),
    });

    const runId = await fireAndSettle(page, pipelineVersionId, `${tag} run`);

    /* THE PREMISE first: the run succeeded and every row of all three files
         landed. The sub-directory is not a row source, so 6 rows exactly. */
    const run = await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
    expect(run.status, `run: ${JSON.stringify(run)}`).toBe('success');
    const back = new DatabaseSync(dbPath, { readOnly: true });
    expect(back.prepare('SELECT id, name FROM people ORDER BY id').all()).toEqual([
      { id: 1, name: 'alpha' },
      { id: 2, name: 'beta' },
      { id: 3, name: 'gamma' },
      { id: 4, name: 'delta' },
      { id: 5, name: 'epsilon' },
      { id: 6, name: 'zeta' },
    ]);
    back.close();

    /* One copy dispatch PER FILE, each at its own path — the per-item
         override is what did the work, not three reads of the default. */
    const events = (await (
      await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
    ).json()) as { type: string; payload: Record<string, unknown> }[];
    const sources = events
      .filter((e) => e.type === 'node.dispatched' && /^load(@\d+)?$/.test(String(e.payload.nodeId)))
      .map((e) => (e.payload.datasetAddresses as { source: { store: string } }).source.store)
      .sort();
    expect(sources).toEqual(Object.keys(FILES).map((f) => join(inDir, f)));

    /* …and the run page shows the iteration, not just a green pipeline. The box
       counts ITEMS; it used to read `round 2` for three files — the 0-based
       index of the last item, which reads as two passes. */
    await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}?rdTab=graph`);
    await fluentRootReady(page);
    const box = page.getByRole('group', {
      name: 'ForEach 1 container, 1 activity, success, 3 of 3 items',
    });
    await expect(box).toBeVisible();
    await expect(box).toContainText('ForEach 1 · success · 3 of 3 items');
    await expect(box).not.toContainText('round');

    await expectQuiet(page, problems);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
