import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * #996 M6 (#1162, data-movement spec §2.1) — a run says WHERE its data went.
 *
 * §2.1's argument, which this walks end to end: a copy node holds a dataset
 * *ref*, and a dataset row is MUTABLE, so a rerun pinned to the same
 * `pipelineVersionId` writes wherever that dataset points TODAY. The
 * compensating control is that the resolved address is recorded on dispatch —
 * "the run log says where it actually wrote, not merely which dataset it
 * named". M6 slice B (#1149) made it durable; this is the spec that proves a
 * human can read it.
 *
 * EGRESS-FREE, and the first e2e to run a REAL copy. A CSV source over the `fs`
 * connection and a SQLite sink is the cheapest heterogeneous pair the catalog
 * admits: the source is a `writeFileSync`, and only ONE database file has to
 * exist. Both fixtures are made by this process, which runs on the same host as
 * the server (`playwright.config.ts` binds `127.0.0.1`).
 *
 * `node:sqlite` rather than `better-sqlite3`: the sink table has to exist before
 * the copy can write it (there is no DDL activity in the catalog, by design),
 * and `better-sqlite3` does not resolve from the workspace root under pnpm. The
 * built-in needs no dependency at all.
 *
 * `realpathSync` on the temp root is load-bearing, not tidiness — on macOS
 * `/var` is a symlink to `/private/var`, and `resolveWithinRoots` compares
 * REAL paths, so an unresolved root never contains its own files and every
 * dispatch would refuse.
 */

async function created(page: Page, url: string, data: unknown): Promise<string> {
  const res = await page.request.post(url, { data });
  expect(res.status(), `${url} → ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

test('#1162 — a copy run names both addresses it resolved', async ({ page }) => {
  const problems = collectPageProblems(page);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1162-')));
  try {
    const csvPath = join(root, 'people.csv');
    writeFileSync(csvPath, 'id,name\n1,alpha\n2,beta\n', 'utf8');
    const dbPath = join(root, 'warehouse.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE people (id INTEGER, name TEXT)');
    db.close();

    const fsConnection = await created(page, '/api/connections', {
      name: '#1162 csv store',
      kind: 'fs',
      config: { roots: [root] },
    });
    const sqliteConnection = await created(page, '/api/connections', {
      name: '#1162 warehouse',
      kind: 'sqlite',
      config: { roots: [root], path: dbPath, writable: true },
    });

    const sourceDataset = await created(page, '/api/datasets', {
      name: '#1162 people.csv',
      kind: 'delimited',
      connectionId: fsConnection,
      config: { path: csvPath, header: true },
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'name', type: 'string', nullable: true },
      ],
    });
    const sinkDataset = await created(page, '/api/datasets', {
      name: '#1162 people table',
      kind: 'table',
      connectionId: sqliteConnection,
      config: { table: 'people' },
      columns: [
        { name: 'id', type: 'integer', nullable: true },
        { name: 'name', type: 'string', nullable: true },
      ],
    });

    const { pipelineVersionId } = await seedVersion(page, '#1162 copy', {
      nodes: [
        {
          id: 'copy1',
          type: 'copy',
          position: { x: 0, y: 0 },
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
      ],
    });
    const runId = await fireAndSettle(page, pipelineVersionId, '#1162 copy');

    /* THE PREMISE, established before any UI assertion. Without it the panel
       assertions below could pass against a copy that resolved its addresses
       and then failed, or never moved a row — and the whole point of the
       section is that it describes work that actually happened. */
    const run = await (await page.request.get(`/api/runs/${runId}`)).json();
    expect(run.status, `run: ${JSON.stringify(run)}`).toBe('success');
    const back = new DatabaseSync(dbPath, { readOnly: true });
    expect(back.prepare('SELECT id, name FROM people ORDER BY id').all()).toEqual([
      { id: 1, name: 'alpha' },
      { id: 2, name: 'beta' },
    ]);
    back.close();

    /* …and that the durable fact this ticket renders is on the event, so a
       green panel can never be a panel rendering something else. */
    const events = (await (
      await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
    ).json()) as { type: string; payload: Record<string, unknown> }[];
    const dispatched = events.find((e) => e.type === 'node.dispatched');
    expect(dispatched?.payload.datasetAddresses).toMatchObject({
      source: { kind: 'fs', store: csvPath },
      sink: { kind: 'sqlite', store: dbPath, object: 'main.people' },
    });

    await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
    await fluentRootReady(page);
    await page.getByRole('button', { name: 'Copy Data 1', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Node Copy Data 1' });
    await expect(panel).toBeVisible();

    const movement = panel.getByRole('heading', { name: 'Data movement' });
    await expect(movement).toBeVisible();

    /* The ADDRESSES, read off the rendered panel — the whole ticket. Asserted
       against the paths this spec created, so the section cannot pass by
       rendering the dataset NAMES, which is exactly the weaker answer §2.1
       says is not good enough. */
    const text = (await panel.textContent()) ?? '';
    expect(text).toContain(`'${csvPath}'`);
    expect(text).toContain(`'${dbPath}' → 'main.people'`);

    /* A `delimited` end's `object` IS its store — `resolveDelimitedDatasetAddress`
       sets both to the same confined path, deliberately and against two rejected
       alternatives. So the CSV end must read ONCE. Measured, not assumed: the
       first run of this spec rendered "'…/people.csv' → '…/people.csv'", which
       is what put the collapse in `describeDatasetAddress`. */
    expect(text).not.toContain(`'${csvPath}' → `);

    await expectQuiet(page, problems);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
