import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion } from './support/seedDoc';
import { seedConnection, seedDataset } from './support/seedResources';
import { fluentRootReady } from './support/theme';

/**
 * A CSV file of `csv` → a sqlite `people` table, as one `copy` node: the two
 * connections, the two datasets and the version. Shared by both tests below so
 * the second is not a second hand-rolled seeder (#1181).
 */
async function seedCsvToSqliteCopy(
  page: Page,
  root: string,
  tag: string,
  csv: string,
): Promise<{ csvPath: string; dbPath: string; pipelineVersionId: string }> {
  const csvPath = join(root, 'people.csv');
  writeFileSync(csvPath, csv, 'utf8');
  const dbPath = join(root, 'warehouse.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE people (id INTEGER, name TEXT)');
  db.close();

  const fsConnection = await seedConnection(page, {
    name: `${tag} csv store`,
    kind: 'fs',
    config: { roots: [root] },
  });
  const sqliteConnection = await seedConnection(page, {
    name: `${tag} warehouse`,
    kind: 'sqlite',
    config: { roots: [root], path: dbPath, writable: true },
  });

  const sourceDataset = await seedDataset(page, {
    name: `${tag} people.csv`,
    kind: 'delimited',
    connectionId: fsConnection,
    config: { path: csvPath, header: true },
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

  const { pipelineVersionId } = await seedVersion(page, `${tag} copy`, {
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
  return { csvPath, dbPath, pipelineVersionId };
}

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

test('#1162 — a copy run names both addresses it resolved', async ({ page }) => {
  const problems = collectPageProblems(page);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1162-')));
  try {
    const { csvPath, dbPath, pipelineVersionId } = await seedCsvToSqliteCopy(
      page,
      root,
      '#1162',
      'id,name\n1,alpha\n2,beta\n',
    );
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

/**
 * #1299 (data-movement spec §5) — "a long copy must not look hung": it streams a
 * `progress` tick per batch, and the run page shows the latest one.
 *
 * 1,500 rows is two of the reader's batches, so a REAL copy through the real
 * executor emits exactly two ticks. The drill-in's "latest" is then the
 * second, and its value is asserted exactly — a panel rendering some other
 * stream, or the name without the value, cannot pass. The live table cell (the
 * value while the node RUNS) is not reachable deterministically here, a local
 * copy of this size settles in milliseconds; `RunDetailPage.test.tsx` pins it.
 */
/* `COPY_PROGRESS_OUTPUT` in `@autonomy-studio/shared`. Spelled here because the
   e2e harness does not depend on the workspace packages, and because this IS
   the wire name a stored run log carries — a rename that forgot old logs should
   fail here. */
const COPY_PROGRESS_OUTPUT = 'progress';

test('#1299 — a copy streams per-batch progress, and the run page shows the latest', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1299-')));
  try {
    const rows = Array.from({ length: 1500 }, (_, i) => `${i + 1},row-${i + 1}`).join('\n');
    const { pipelineVersionId } = await seedCsvToSqliteCopy(
      page,
      root,
      '#1299',
      `id,name\n${rows}\n`,
    );
    const runId = await fireAndSettle(page, pipelineVersionId, '#1299 copy');

    /* THE PREMISE, from the durable log before any UI: two ticks, in batch
       order, both ahead of the terminal. */
    const events = (await (
      await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
    ).json()) as { type: string; payload: Record<string, unknown> }[];
    const ticks = events.filter(
      (e) => e.type === 'node.output' && e.payload.name === COPY_PROGRESS_OUTPUT,
    );
    /* 999, not 1,000: the CSV parser batches raw LINES, and the header line is
       one of the first batch's 1,000 before the reader strips it (measured —
       the first run of this spec asserted 1,000). */
    expect(ticks.map((e) => e.payload.value)).toEqual([
      { rowsRead: 999, rowsInFlight: 999, rowsFailed: 0 },
      { rowsRead: 1500, rowsInFlight: 1500, rowsFailed: 0 },
    ]);
    const succeededAt = events.findIndex((e) => e.type === 'node.succeeded');
    expect(succeededAt).toBeGreaterThan(events.indexOf(ticks[1]!));
    expect(events[succeededAt]?.payload.outputs).toMatchObject({ rowsWritten: 1500 });

    await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
    await fluentRootReady(page);
    /* Settled, so the table names the stream rather than showing a live value. */
    await expect(page.getByRole('cell', { name: `output: ${COPY_PROGRESS_OUTPUT}` })).toBeVisible();

    await page.getByRole('button', { name: 'Copy Data 1', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Node Copy Data 1' });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(
      `2 events (latest: ${COPY_PROGRESS_OUTPUT} = {"rowsRead":1500,"rowsInFlight":1500,"rowsFailed":0})`,
    );

    await expectQuiet(page, problems);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
