import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, nodeById, openSeededCanvas } from './support/seedDoc';
import { properties } from './support/panels';
import { seedConnection, seedDataset } from './support/seedResources';

/**
 * #1600 OR41 C6f-3 — a rows Copy's partitioned reads (ADF's `partitionOption`
 * Dynamic range on a database source, its degree the copy's `parallelCopies`,
 * https://learn.microsoft.com/azure/data-factory/connector-azure-database-for-postgresql#parallel-copy-from-azure-database-for-postgresql).
 * The e2e harness has no PostgreSQL, so the ranges, the shared snapshot and the
 * sessions are tested against a live one in `postgres-partitions.test.ts`
 * (CI's postgres service). Here: the form draws the fields where ADF does and
 * saves them, and a SQLite source, which reads on one thread, is refused before
 * the sink writes anything.
 */
test.describe('#1600 C6f-3 — Copy partitioned reads', () => {
  test('Dynamic range on the Source tab and its degree on Settings save, and a SQLite source is refused', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const problems = collectPageProblems(page);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1600-c6f3-')));
    try {
      const dbPath = join(root, 'shop.db');
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE incoming (id INTEGER, qty INTEGER);
        INSERT INTO incoming VALUES (1, 5), (2, 6), (3, 7);
        CREATE TABLE orders (id INTEGER, qty INTEGER);
      `);
      db.close();
      const conn = await seedConnection(page, {
        name: 'e2e 1600 c6f3 shop',
        kind: 'sqlite',
        config: { roots: [root], path: dbPath, writable: true },
      });
      const sink = await seedDataset(page, {
        name: 'e2e 1600 c6f3 orders',
        kind: 'table',
        connectionId: conn,
        config: { table: 'orders' },
        columns: [
          { name: 'id', type: 'integer', nullable: true },
          { name: 'qty', type: 'integer', nullable: true },
        ],
      });
      const pipelineId = await openSeededCanvas(page, 'e2e 1600 c6f3 partitions', {
        nodes: [
          {
            id: 'copy1',
            type: 'copy',
            config: {
              mapping: [
                { source: 'id', sink: 'id', type: 'integer' },
                { source: 'qty', sink: 'qty', type: 'integer' },
              ],
            },
            connectionIds: { source: conn, sink: conn },
            datasetIds: { sink },
            inlineDatasets: { source: { kind: 'table', config: { table: 'incoming' } } },
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
      });

      await nodeById(page, 'copy1').click();
      const pane = properties(page);
      const sourceTab = pane.getByRole('tab', { name: 'Source', exact: true });
      const settingsTab = pane.getByRole('tab', { name: 'Settings', exact: true });
      const option = pane.getByRole('combobox', { name: 'Partition option', exact: true });
      const column = pane.getByRole('textbox', { name: 'Partition column', exact: true });
      const lower = pane.getByRole('textbox', { name: 'Partition lower bound', exact: true });
      const upper = pane.getByRole('textbox', { name: 'Partition upper bound', exact: true });
      const degree = pane.getByRole('textbox', { name: 'Degree of copy parallelism', exact: true });

      // None draws no range and no degree: one reader has neither.
      await sourceTab.click();
      await expect(option).toBeVisible();
      await expect(column).toHaveCount(0);
      await expect(lower).toHaveCount(0);
      await settingsTab.click();
      await expect(pane.getByRole('combobox', { name: 'Session log' })).toBeVisible();
      await expect(degree).toHaveCount(0);

      // Dynamic range draws the column and the bounds on Source. The bounds are
      // short numbers, so they pack on one row (UI standard 5); the dock scrolls.
      await sourceTab.click();
      await option.selectOption('dynamicRange');
      await expect(column).toBeVisible();
      await expect(lower).toBeVisible();
      await expect(upper).toBeVisible();
      await upper.scrollIntoViewIfNeeded();
      const [lowerBox, upperBox] = await Promise.all([lower.boundingBox(), upper.boundingBox()]);
      expect(lowerBox && upperBox, 'each bound has a box').toBeTruthy();
      expect(Math.abs(lowerBox!.y - upperBox!.y)).toBeLessThan(1);
      expect(lowerBox!.x).toBeLessThan(upperBox!.x);
      expect(upperBox!.width).toBeLessThanOrEqual(160);
      expect(upperBox!.y + upperBox!.height).toBeLessThanOrEqual(900);
      await column.fill('id');
      await lower.fill('1');
      await upper.fill('3');

      // The degree leads Settings, as on Files as-is and in ADF.
      await settingsTab.click();
      await expect(degree).toBeVisible();
      const degreeBox = await degree.boundingBox();
      const skipBox = await pane
        .getByRole('checkbox', { name: 'Skip incompatible rows', exact: true })
        .boundingBox();
      expect(degreeBox && skipBox, 'each control has a box').toBeTruthy();
      expect(
        degreeBox!.y < skipBox!.y - 1 ||
          (Math.abs(degreeBox!.y - skipBox!.y) < 8 && degreeBox!.x < skipBox!.x),
        `degree ${JSON.stringify(degreeBox)} skip ${JSON.stringify(skipBox)}`,
      ).toBe(true);
      expect(degreeBox!.width).toBeLessThanOrEqual(160);
      await degree.fill('2');
      await pane.getByRole('button', { name: 'Apply config' }).click();

      await page.getByRole('button', { name: 'Save version' }).click();
      await expect(page.locator('.notice')).toHaveText('Saved v2.');
      const versions = (await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json()) as { id: string; version: number; nodes: Record<string, unknown>[] }[];
      const latest = versions.sort((a, b) => b.version - a.version)[0]!;
      const copy = latest.nodes.find((n) => n['id'] === 'copy1')!;
      expect(copy['config']).toMatchObject({
        partitionOption: 'dynamicRange',
        partitionColumnName: 'id',
        partitionLowerBound: 1,
        partitionUpperBound: 3,
        parallelCopies: 2,
      });

      // SQLite reads on one thread: refused before the sink's transaction.
      const runId = await fireAndSettle(page, latest.id, 'e2e 1600 c6f3');
      const run = await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
      expect(run.status, `run: ${JSON.stringify(run)}`).toBe('failure');
      const events = (await (
        await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
      ).json()) as { type: string; payload: Record<string, unknown> }[];
      expect(events.find((e) => e.type === 'node.failed')?.payload).toMatchObject({
        kind: 'permanent',
        error:
          'Partition option Dynamic range reads a PostgreSQL table; this source is read with one reader (set Partition option to None)',
      });
      const check = new DatabaseSync(dbPath, { readOnly: true });
      const kept = check.prepare('SELECT count(*) AS n FROM orders').get() as { n: number };
      check.close();
      expect(kept.n).toBe(0);

      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
