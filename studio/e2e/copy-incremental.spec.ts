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
 * #1600 OR41 C5a — a Copy's Load Incremental (catalogue §4.1): Load first on the
 * Source tab, its watermark drawn only where it applies, and Watermark from
 * Automatic copying only the rows above the watermark the last committed copy
 * stored. SQLite only: the e2e harness has no postgres (the live postgres
 * coverage is `postgres-incremental.test.ts`).
 */
test.describe('#1600 C5a — Copy Load Incremental', () => {
  test('Load Incremental on the Source tab saves, and a second run copies only the newer rows', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const problems = collectPageProblems(page);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1600-c5a-')));
    try {
      const dbPath = join(root, 'shop.db');
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE incoming (id INTEGER, modified_at INTEGER);
        INSERT INTO incoming VALUES (1, 100), (2, 200);
        CREATE TABLE orders (id INTEGER, modified_at INTEGER);
      `);
      db.close();
      const conn = await seedConnection(page, {
        name: 'e2e 1600 c5a shop',
        kind: 'sqlite',
        config: { roots: [root], path: dbPath, writable: true },
      });
      const sink = await seedDataset(page, {
        name: 'e2e 1600 c5a orders',
        kind: 'table',
        connectionId: conn,
        config: { table: 'orders' },
        columns: [
          { name: 'id', type: 'integer', nullable: true },
          { name: 'modified_at', type: 'integer', nullable: true },
        ],
      });
      const pipelineId = await openSeededCanvas(page, 'e2e 1600 c5a incremental', {
        nodes: [
          {
            id: 'copy1',
            type: 'copy',
            config: {
              mapping: [
                { source: 'id', sink: 'id', type: 'integer' },
                { source: 'modified_at', sink: 'modified_at', type: 'integer' },
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
      const load = pane.getByRole('combobox', { name: 'Load', exact: true });
      const column = pane.getByRole('textbox', { name: 'Watermark column', exact: true });
      const from = pane.getByRole('combobox', { name: 'Watermark from', exact: true });
      const old = pane.getByRole('textbox', { name: 'Old watermark', exact: true });
      const partition = pane.getByRole('combobox', { name: 'Partition option', exact: true });

      await pane.getByRole('tab', { name: 'Source', exact: true }).click();
      await expect(load).toBeVisible();
      await expect(column).toHaveCount(0);
      await expect(from).toHaveCount(0);
      await expect(old).toHaveCount(0);
      // Load leads the tab, above the partition option, and is sized to its options.
      const [loadBox, partitionBox] = await Promise.all([
        load.boundingBox(),
        partition.boundingBox(),
      ]);
      expect(loadBox && partitionBox, 'each control has a box').toBeTruthy();
      expect(loadBox!.y).toBeLessThan(partitionBox!.y);
      expect(loadBox!.width).toBeLessThanOrEqual(200);
      expect(loadBox!.y + loadBox!.height).toBeLessThanOrEqual(900);

      await load.selectOption('incremental');
      await expect(column).toBeVisible();
      await expect(from).toBeVisible();
      await expect(from).toHaveValue('automatic');
      await expect(old).toHaveCount(0);
      await from.selectOption('expression');
      await expect(old).toBeVisible();
      await from.selectOption('automatic');
      await expect(old).toHaveCount(0);
      await column.fill('modified_at');
      await pane.getByRole('button', { name: 'Apply config' }).click();

      await page.getByRole('button', { name: 'Save version' }).click();
      await expect(page.locator('.notice')).toHaveText('Saved v2.');
      const versions = (await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json()) as { id: string; version: number; nodes: Record<string, unknown>[] }[];
      const latest = versions.sort((a, b) => b.version - a.version)[0]!;
      const copy = latest.nodes.find((n) => n['id'] === 'copy1')!;
      expect(copy['config']).toMatchObject({
        load: 'incremental',
        watermarkColumnName: 'modified_at',
      });
      expect(copy['config']).not.toHaveProperty('watermarkOld');

      const watermarkOf = async (runId: string) => {
        const run = await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
        expect(run.status, `run: ${JSON.stringify(run)}`).toBe('success');
        const events = (await (
          await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
        ).json()) as { type: string; payload: Record<string, unknown> }[];
        const done = events.find((e) => e.type === 'node.succeeded')?.payload;
        return (done?.['outputs'] as Record<string, unknown> | undefined)?.['watermark'];
      };
      const landed = () => {
        const check = new DatabaseSync(dbPath, { readOnly: true });
        const rows = check.prepare('SELECT id FROM orders ORDER BY id').all();
        check.close();
        return rows.map((r) => (r as { id: number }).id);
      };

      const first = await fireAndSettle(page, latest.id, 'e2e 1600 c5a first');
      expect(await watermarkOf(first)).toEqual({ column: 'modified_at', old: null, new: 200 });
      expect(landed()).toEqual([1, 2]);

      const more = new DatabaseSync(dbPath);
      more.exec('INSERT INTO incoming VALUES (3, 300)');
      more.close();
      const second = await fireAndSettle(page, latest.id, 'e2e 1600 c5a second');
      expect(await watermarkOf(second)).toEqual({ column: 'modified_at', old: 200, new: 300 });
      expect(landed()).toEqual([1, 2, 3]);

      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
