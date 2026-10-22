import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, nodeById, openSeededCanvas } from './support/seedDoc';
import { problemsToggle, properties } from './support/panels';
import { seedConnection } from './support/seedResources';

/**
 * #1600 OR41 C10a — the Script activity on SQLite (activity catalogue §4.5).
 *
 * A seeded Script opens on Settings, its blocks are rows on the Script tab, an
 * authored edit saves, and the run executes the blocks in order: the Non-query
 * changes the store (with a `${}` bind value) and the Query returns its rows as
 * a result set.
 */
test.use({ viewport: { width: 1440, height: 900 } });

test.describe('#1600 C10a — Script on SQLite', () => {
  test('blocks authored in the dock run in order: a Non-query with a bind value, then a Query', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1600-c10a-')));
    try {
      const dbPath = join(root, 'warehouse.db');
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE orders (id INTEGER PRIMARY KEY, qty INTEGER);
        INSERT INTO orders VALUES (1, 10), (2, 20);
      `);
      db.close();
      const conn = await seedConnection(page, {
        name: 'e2e 1600 c10a warehouse',
        kind: 'sqlite',
        config: { roots: [root], path: dbPath, writable: true },
      });
      const pipelineId = await openSeededCanvas(page, 'e2e 1600 c10a script', {
        nodes: [
          {
            id: 'script1',
            type: 'script',
            connectionId: conn,
            config: {
              blocks: [
                {
                  type: 'nonQuery',
                  sql: 'UPDATE orders SET qty = qty + :inc',
                  parameters: { inc: '5' },
                },
                { type: 'query', sql: 'SELECT id, qty FROM orders ORDER BY id' },
              ],
            },
            position: { x: 0, y: 0 },
          },
        ],
      });

      const card = nodeById(page, 'script1');
      await expect(card).toContainText('2 blocks');
      await card.click();
      const pane = properties(page);
      await expect(pane.getByRole('tab')).toContainText(['General', 'Settings', 'Script']);
      // Opens on its first catalog tab, where the connection is.
      await expect(pane.getByRole('tab', { name: 'Settings', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(
        pane.getByRole('checkbox', { name: 'Run as one transaction' }),
      ).not.toBeChecked();
      // Unset, so the default is shown and nothing is written.
      await expect(
        pane.getByLabel('Capture result sets', { exact: true }).locator('option:checked'),
      ).toHaveText(/First 1000 rows/);

      await pane.getByRole('tab', { name: 'Script', exact: true }).click();
      await expect(pane.getByLabel('Script blocks row 1 type', { exact: true })).toHaveValue(
        'nonQuery',
      );
      await expect(pane.getByLabel('Script blocks row 2 type', { exact: true })).toHaveValue(
        'query',
      );
      const firstSql = pane.getByLabel('Script blocks row 1 SQL', { exact: true });
      await expect(firstSql).toHaveValue('UPDATE orders SET qty = qty + :inc');
      // The SQL is literal: no ƒx beside it.
      await expect(
        pane.getByRole('button', { name: /^Insert reference into Script blocks row 1 SQL/ }),
      ).toHaveCount(0);
      // Measured at 1440x900: the first block is on screen without scrolling.
      const box = (await firstSql.boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(900);

      // Authored, not only seeded: the bind value becomes an expression.
      const params = pane.getByLabel('Script blocks row 1 parameters — JSON', { exact: true });
      await params.fill('{"inc": "${string(add(2, 3))}"}');
      await pane.getByRole('button', { name: 'Apply config' }).click();
      await pane.getByRole('tab', { name: 'Settings', exact: true }).click();
      await pane.getByRole('checkbox', { name: 'Run as one transaction' }).check();
      await pane.getByRole('button', { name: 'Apply config' }).click();
      await expect(card).toContainText('2 blocks · one transaction');
      await expect(problemsToggle(page)).not.toHaveText(/[1-9]/);

      await page.getByRole('button', { name: 'Save version' }).click();
      await expect(page.locator('.notice')).toHaveText('Saved v2.');
      const versions = (await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json()) as { id: string; version: number; nodes: Record<string, unknown>[] }[];
      const latest = versions.sort((a, b) => b.version - a.version)[0]!;
      const saved = latest.nodes.find((n) => n['id'] === 'script1')!;
      expect(saved['config']).toMatchObject({
        runAsOneTransaction: true,
        blocks: [
          {
            type: 'nonQuery',
            sql: 'UPDATE orders SET qty = qty + :inc',
            parameters: { inc: '${string(add(2, 3))}' },
          },
          { type: 'query', sql: 'SELECT id, qty FROM orders ORDER BY id' },
        ],
      });

      const runId = await fireAndSettle(page, latest.id, 'e2e 1600 c10a');
      const run = await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
      expect(run.status, `run: ${JSON.stringify(run)}`).toBe('success');
      const events = (await (
        await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
      ).json()) as { type: string; payload: Record<string, unknown> }[];
      const succeeded = events.find((e) => e.type === 'node.succeeded');
      expect(succeeded?.payload['outputs']).toMatchObject({
        resultSetCount: 1,
        resultSets: [
          {
            rowCount: 2,
            rows: [
              { id: 1, qty: 15 },
              { id: 2, qty: 25 },
            ],
          },
        ],
        recordsAffected: 2,
        outputParameters: {},
        truncated: false,
      });

      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
