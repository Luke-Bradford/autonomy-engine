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
 * #1600 OR41 C6d-1 — Copy's Skip incompatible rows (catalogue §4.1 Settings ·
 * Fault tolerance), authored on the Settings tab and run for real against a
 * SQLite file: a row the sink's primary key rejects is skipped and logged, and
 * the rest land.
 */
test.describe('#1600 C6d-1 — Copy Skip incompatible rows', () => {
  test('set on the Settings tab, it skips the duplicate key and the copy succeeds', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const problems = collectPageProblems(page);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1600-c6d-')));
    try {
      const dbPath = join(root, 'shop.db');
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE incoming (id INTEGER, qty TEXT);
        INSERT INTO incoming VALUES (1, '5'), (2, '6'), (1, '7');
        CREATE TABLE orders (id INTEGER PRIMARY KEY, qty INTEGER);
      `);
      db.close();
      const conn = await seedConnection(page, {
        name: 'e2e 1600 c6d shop',
        kind: 'sqlite',
        config: { roots: [root], path: dbPath, writable: true },
      });
      const sink = await seedDataset(page, {
        name: 'e2e 1600 c6d orders',
        kind: 'table',
        connectionId: conn,
        config: { table: 'orders' },
        columns: [
          { name: 'id', type: 'integer', nullable: false },
          { name: 'qty', type: 'integer', nullable: true },
        ],
      });
      const pipelineId = await openSeededCanvas(page, 'e2e 1600 c6d skip rows', {
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
      const skip = pane.getByRole('checkbox', { name: 'Skip incompatible rows', exact: true });

      // Not drawn under Upsert, which save refuses it with.
      await pane.getByRole('tab', { name: 'Sink', exact: true }).click();
      const behaviour = pane.getByRole('combobox', { name: 'Write behaviour' });
      await behaviour.selectOption('upsert');
      await settingsTab.click();
      await expect(pane.getByRole('combobox', { name: 'Session log' })).toBeVisible();
      await expect(skip).toHaveCount(0);
      await pane.getByRole('tab', { name: 'Sink', exact: true }).click();
      await behaviour.selectOption('append');
      await settingsTab.click();

      // Off by default, and first on the tab, above the Session log, as in ADF.
      await expect(skip).not.toBeChecked();
      const skipBox = await skip.boundingBox();
      const levelBox = await pane.getByRole('combobox', { name: 'Session log' }).boundingBox();
      expect(skipBox, 'the checkbox has a box').not.toBeNull();
      expect(levelBox, 'Session log has a box').not.toBeNull();
      expect(skipBox!.y).toBeLessThan(levelBox!.y);
      expect(skipBox!.y + skipBox!.height).toBeLessThanOrEqual(900);
      await skip.check();
      await pane.getByRole('button', { name: 'Apply config' }).click();

      await page.getByRole('button', { name: 'Save version' }).click();
      await expect(page.locator('.notice')).toHaveText('Saved v2.');
      const versions = (await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json()) as { id: string; version: number; nodes: Record<string, unknown>[] }[];
      const latest = versions.sort((a, b) => b.version - a.version)[0]!;
      const copy = latest.nodes.find((n) => n['id'] === 'copy1')!;
      expect(copy['config']).toMatchObject({ mode: 'append', skipIncompatibleRows: true });

      const runId = await fireAndSettle(page, latest.id, 'e2e 1600 c6d');
      const run = await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
      expect(run.status, `run: ${JSON.stringify(run)}`).toBe('success');
      const events = (await (
        await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
      ).json()) as { type: string; payload: Record<string, unknown> }[];
      const lines = events
        .filter((e) => e.type === 'node.output' && e.payload['name'] === 'sessionLog')
        .map((e) => (e.payload['value'] as string).replace(/^\S+ /, ''));
      expect(lines).toEqual([
        "Warning TabularRowSkip row 3 sink_rejected: into 'orders': UNIQUE constraint failed: orders.id",
      ]);
      const succeeded = events.find((e) => e.type === 'node.succeeded');
      expect(succeeded?.payload['outputs']).toMatchObject({
        rowsRead: 3,
        rowsWritten: 2,
        rowsFailed: 1,
      });
      const back = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(back.prepare('SELECT id, qty FROM orders ORDER BY id').all()).toEqual([
          { id: 1, qty: 5 },
          { id: 2, qty: 6 },
        ]);
      } finally {
        back.close();
      }

      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
