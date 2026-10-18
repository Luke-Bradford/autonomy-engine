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
 * #1600 OR41 C3a — Copy's Write behaviour (catalogue §4.1): Upsert with Key
 * columns, authored in the Sink tab and run for real against a SQLite file.
 * Run twice, the copy updates the matched rows and adds none.
 */
test.describe('#1600 C3a — Copy Write behaviour', () => {
  test('Upsert with Key columns, authored in the Sink tab, updates matched rows and a rerun adds none', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const problems = collectPageProblems(page);
    // `realpathSync`: macOS `/var` is a symlink, and roots compare REAL paths.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1600-c3a-')));
    try {
      const dbPath = join(root, 'crm.db');
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE incoming (id INTEGER, name TEXT);
        INSERT INTO incoming VALUES (2, 'Bea'), (3, 'Cal');
        CREATE TABLE customers (id INTEGER, name TEXT);
        INSERT INTO customers VALUES (1, 'Ann'), (2, 'Bee');
      `);
      db.close();
      const conn = await seedConnection(page, {
        name: 'e2e 1600 c3a crm',
        kind: 'sqlite',
        config: { roots: [root], path: dbPath, writable: true },
      });
      const sink = await seedDataset(page, {
        name: 'e2e 1600 c3a customers',
        kind: 'table',
        connectionId: conn,
        config: { table: 'customers' },
        columns: [
          { name: 'id', type: 'integer', nullable: true },
          { name: 'name', type: 'string', nullable: true },
        ],
      });
      const pipelineId = await openSeededCanvas(page, 'e2e 1600 c3a upsert', {
        nodes: [
          {
            id: 'copy1',
            type: 'copy',
            config: {
              mapping: [
                { source: 'id', sink: 'id', type: 'integer' },
                { source: 'name', sink: 'name', type: 'string' },
              ],
              mode: 'append',
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
      await pane.getByRole('tab', { name: 'Sink', exact: true }).click();
      const behaviour = pane.getByRole('combobox', { name: 'Write behaviour' });
      await expect(behaviour.locator('option')).toHaveText([
        'Append',
        'Overwrite',
        'Truncate then insert',
        'Upsert',
      ]);
      const keys = pane.getByRole('textbox', { name: 'Key columns' });
      // Key columns are read only by Upsert, so the other behaviours hide them.
      await expect(keys).toHaveCount(0);
      await behaviour.selectOption('upsert');
      await expect(keys).toBeVisible();
      // The whole Sink tab fits the dock at 1440x900, Key columns included.
      const box = await keys.boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(900);
      await keys.fill('id');
      await pane.getByRole('button', { name: 'Apply config' }).click();
      await expect(nodeById(page, 'copy1')).toContainText('· upsert on id');

      await page.getByRole('button', { name: 'Save version' }).click();
      await expect(page.locator('.notice')).toHaveText('Saved v2.');
      const versions = (await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json()) as { id: string; version: number; nodes: Record<string, unknown>[] }[];
      const latest = versions.sort((a, b) => b.version - a.version)[0]!;
      const copy = latest.nodes.find((n) => n['id'] === 'copy1')!;
      expect(copy['config']).toMatchObject({ mode: 'upsert', keyColumns: ['id'] });

      const customers = () => {
        const back = new DatabaseSync(dbPath, { readOnly: true });
        try {
          return back.prepare('SELECT id, name FROM customers ORDER BY id').all();
        } finally {
          back.close();
        }
      };
      const runOk = async (label: string) => {
        const runId = await fireAndSettle(page, latest.id, label);
        const run = await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
        expect(run.status, `run: ${JSON.stringify(run)}`).toBe('success');
      };
      const expected = [
        { id: 1, name: 'Ann' },
        { id: 2, name: 'Bea' },
        { id: 3, name: 'Cal' },
      ];
      await runOk('e2e 1600 c3a first');
      expect(customers()).toEqual(expected);
      await runOk('e2e 1600 c3a second');
      expect(customers()).toEqual(expected);

      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
