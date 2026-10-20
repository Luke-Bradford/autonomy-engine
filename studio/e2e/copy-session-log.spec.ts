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
 * #1600 OR41 C6a — Copy's session log (catalogue §4.1, §5), authored on the
 * Settings tab and run for real against a SQLite file: a row that cannot be
 * converted is skipped, and the run log says which, whole, in the Monitor's
 * Logs tab.
 */
test.describe('#1600 C6a — Copy session log', () => {
  test('Everything, set on the Settings tab, logs the skipped row and the batch in the Logs tab', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const problems = collectPageProblems(page);
    // `realpathSync`: macOS `/var` is a symlink, and roots compare REAL paths.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1600-c6a-')));
    try {
      const dbPath = join(root, 'shop.db');
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE incoming (id INTEGER, qty TEXT);
        INSERT INTO incoming VALUES (1, '5'), (2, 'lots'), (3, '7');
        CREATE TABLE orders (id INTEGER, qty INTEGER);
      `);
      db.close();
      const conn = await seedConnection(page, {
        name: 'e2e 1600 c6a shop',
        kind: 'sqlite',
        config: { roots: [root], path: dbPath, writable: true },
      });
      const sink = await seedDataset(page, {
        name: 'e2e 1600 c6a orders',
        kind: 'table',
        connectionId: conn,
        config: { table: 'orders' },
        columns: [
          { name: 'id', type: 'integer', nullable: true },
          { name: 'qty', type: 'integer', nullable: true },
        ],
      });
      const pipelineId = await openSeededCanvas(page, 'e2e 1600 c6a session log', {
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
      await pane.getByRole('tab', { name: 'Settings', exact: true }).click();
      const level = pane.getByRole('combobox', { name: 'Session log' });
      // Warnings is the default, written as nothing; there is no Write to until C6c.
      await expect(level.locator('option:checked')).toHaveText('Warnings (default)');
      await expect(level.locator('option')).toHaveText([
        'Warnings (default)',
        'Off',
        'Warnings',
        'Everything',
      ]);
      await expect(pane.getByRole('combobox', { name: 'Write to' })).toHaveCount(0);
      const box = await level.boundingBox();
      expect(box, 'Session log has a box').not.toBeNull();
      expect(box!.y + box!.height).toBeLessThanOrEqual(900);
      await level.selectOption({ label: 'Everything' });
      await pane.getByRole('button', { name: 'Apply config' }).click();

      await page.getByRole('button', { name: 'Save version' }).click();
      await expect(page.locator('.notice')).toHaveText('Saved v2.');
      const versions = (await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json()) as { id: string; version: number; nodes: Record<string, unknown>[] }[];
      const latest = versions.sort((a, b) => b.version - a.version)[0]!;
      const copy = latest.nodes.find((n) => n['id'] === 'copy1')!;
      expect(copy['config']).toMatchObject({ logLevel: 'info' });

      const runId = await fireAndSettle(page, latest.id, 'e2e 1600 c6a');
      const run = await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
      expect(run.status, `run: ${JSON.stringify(run)}`).toBe('success');
      const events = (await (
        await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
      ).json()) as { type: string; payload: Record<string, unknown> }[];
      const lines = events
        .filter((e) => e.type === 'node.output' && e.payload['name'] === 'sessionLog')
        .map((e) => e.payload['value'] as string);
      const ts = '\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z';
      expect(lines, `events: ${JSON.stringify(events.map((e) => e.type))}`).toHaveLength(2);
      expect(lines[0]).toMatch(
        new RegExp(`^${ts} Warning TabularRowSkip row 2 not_a_number: into 'qty': .+`),
      );
      expect(lines[1]).toMatch(
        new RegExp(`^${ts} Info TabularRowBatch rows 1-3 read 3 rows, 1 skipped$`),
      );
      const back = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(back.prepare('SELECT id, qty FROM orders ORDER BY id').all()).toEqual([
          { id: 1, qty: 5 },
          { id: 3, qty: 7 },
        ]);
      } finally {
        back.close();
      }

      // The Logs tab shows the skip line whole, past the 80-character inline cap.
      await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
      await page.locator('.activity-runs__table .activity-runs__open').first().click();
      const drawer = page.locator('#run-detail-drawer');
      await drawer
        .getByRole('tablist', { name: 'Activity run details' })
        .getByRole('tab', { name: 'Logs', exact: true })
        .click();
      const values = drawer.locator('.node-logs tbody tr td:last-child');
      await expect(values).toHaveText([lines[0]!, lines[1]!]);
      expect(lines[0]!.length).toBeGreaterThan(80);

      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
