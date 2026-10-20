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
 * #1600 OR41 C6e-1 — Copy's Verify after copy (catalogue §4.1 Settings · Data
 * consistency; ADF's `validateDataConsistency`,
 * https://learn.microsoft.com/azure/data-factory/copy-activity-data-consistency),
 * set on the Settings tab and run for real against a SQLite file whose trigger
 * discards a row: the counts differ, so the copy fails and nothing is committed.
 */
test.describe('#1600 C6e-1 — Copy Verify after copy', () => {
  test('set on the Settings tab, a store that kept fewer rows fails the copy and keeps none', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const problems = collectPageProblems(page);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1600-c6e-')));
    try {
      const dbPath = join(root, 'shop.db');
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE incoming (id INTEGER, qty TEXT);
        INSERT INTO incoming VALUES (1, '5'), (2, '6'), (3, '7');
        CREATE TABLE orders (id INTEGER, qty INTEGER);
        CREATE TRIGGER drop2 BEFORE INSERT ON orders WHEN new.id = 2
          BEGIN SELECT RAISE(IGNORE); END;
      `);
      db.close();
      const conn = await seedConnection(page, {
        name: 'e2e 1600 c6e shop',
        kind: 'sqlite',
        config: { roots: [root], path: dbPath, writable: true },
      });
      const sink = await seedDataset(page, {
        name: 'e2e 1600 c6e orders',
        kind: 'table',
        connectionId: conn,
        config: { table: 'orders' },
        columns: [
          { name: 'id', type: 'integer', nullable: true },
          { name: 'qty', type: 'integer', nullable: true },
        ],
      });
      const pipelineId = await openSeededCanvas(page, 'e2e 1600 c6e verify', {
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
      const settingsTab = pane.getByRole('tab', { name: 'Settings', exact: true });
      const verify = pane.getByRole('checkbox', { name: 'Verify after copy', exact: true });

      // Not drawn under Upsert, which save refuses it with.
      await pane.getByRole('tab', { name: 'Sink', exact: true }).click();
      const behaviour = pane.getByRole('combobox', { name: 'Write behaviour' });
      await behaviour.selectOption('upsert');
      await settingsTab.click();
      await expect(pane.getByRole('combobox', { name: 'Session log' })).toBeVisible();
      await expect(verify).toHaveCount(0);
      await pane.getByRole('tab', { name: 'Sink', exact: true }).click();
      await behaviour.selectOption('append');
      await settingsTab.click();

      // Off by default, between Skip incompatible rows and the Session log (the
      // spec's Settings order), and inside the 900px viewport.
      await expect(verify).not.toBeChecked();
      const skipBox = await pane
        .getByRole('checkbox', { name: 'Skip incompatible rows', exact: true })
        .boundingBox();
      const verifyBox = await verify.boundingBox();
      const levelBox = await pane.getByRole('combobox', { name: 'Session log' }).boundingBox();
      expect(skipBox && verifyBox && levelBox, 'all three fields have a box').toBeTruthy();
      expect(skipBox!.y).toBeLessThan(verifyBox!.y);
      expect(verifyBox!.y).toBeLessThan(levelBox!.y);
      expect(levelBox!.y + levelBox!.height).toBeLessThanOrEqual(900);
      await verify.check();
      await pane.getByRole('button', { name: 'Apply config' }).click();

      await page.getByRole('button', { name: 'Save version' }).click();
      await expect(page.locator('.notice')).toHaveText('Saved v2.');
      const versions = (await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json()) as { id: string; version: number; nodes: Record<string, unknown>[] }[];
      const latest = versions.sort((a, b) => b.version - a.version)[0]!;
      const copy = latest.nodes.find((n) => n['id'] === 'copy1')!;
      expect(copy['config']).toMatchObject({ mode: 'append', validateDataConsistency: true });

      const runId = await fireAndSettle(page, latest.id, 'e2e 1600 c6e');
      const run = await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
      expect(run.status, `run: ${JSON.stringify(run)}`).toBe('failure');
      const events = (await (
        await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
      ).json()) as { type: string; payload: Record<string, unknown> }[];
      const failed = events.find((e) => e.type === 'node.failed');
      expect(failed?.payload).toMatchObject({
        kind: 'permanent',
        error:
          'Verify after copy failed: the copy read 3 row(s) and skipped 0, so 3 should have ' +
          'been written, but the store reports 2',
      });
      const back = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(back.prepare('SELECT id FROM orders').all()).toEqual([]);
      } finally {
        back.close();
      }

      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
