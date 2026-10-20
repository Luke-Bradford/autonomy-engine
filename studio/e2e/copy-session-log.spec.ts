import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
 * Logs tab. C6b — the same, on Copy · Files as-is against a file connection.
 */
test.describe('#1600 C6 — Copy session log', () => {
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
      // After the copy's progress tick, the two log lines, whole.
      await expect(values).toHaveText([/"rowsRead":3/, lines[0]!, lines[1]!]);
      expect(lines[0]!.length).toBeGreaterThan(80);

      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * #1772 — a long session log's FIRST lines are reachable in the Logs tab:
   * 250 skipped rows log past one page of 200, and filtering to `sessionLog`
   * then paging to First shows row 1's skip.
   */
  test('a session log longer than one page reads from its first skipped row', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const problems = collectPageProblems(page);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1772-')));
    try {
      const dbPath = join(root, 'shop.db');
      const db = new DatabaseSync(dbPath);
      db.exec(`CREATE TABLE incoming (id INTEGER, qty TEXT);
        CREATE TABLE orders (id INTEGER, qty INTEGER);`);
      const insert = db.prepare('INSERT INTO incoming VALUES (?, ?)');
      for (let id = 1; id <= 260; id++) insert.run(id, id <= 250 ? 'lots' : String(id));
      db.close();
      const conn = await seedConnection(page, {
        name: 'e2e 1772 shop',
        kind: 'sqlite',
        config: { roots: [root], path: dbPath, writable: true },
      });
      const sink = await seedDataset(page, {
        name: 'e2e 1772 orders',
        kind: 'table',
        connectionId: conn,
        config: { table: 'orders' },
        columns: [
          { name: 'id', type: 'integer', nullable: true },
          { name: 'qty', type: 'integer', nullable: true },
        ],
      });
      const pipelineId = await openSeededCanvas(page, 'e2e 1772 long session log', {
        nodes: [
          {
            id: 'copy1',
            type: 'copy',
            config: {
              logLevel: 'info',
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
      const versions = (await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json()) as { id: string; version: number }[];
      const latest = versions.sort((x, y) => y.version - x.version)[0]!;
      const runId = await fireAndSettle(page, latest.id, 'e2e 1772');
      const run = await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
      expect(run.status, `run: ${JSON.stringify(run)}`).toBe('success');

      await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
      await page.locator('.activity-runs__table .activity-runs__open').first().click();
      const drawer = page.locator('#run-detail-drawer');
      await drawer
        .getByRole('tablist', { name: 'Activity run details' })
        .getByRole('tab', { name: 'Logs', exact: true })
        .click();
      const values = drawer.locator('.node-logs tbody tr td:last-child');
      // Opens on the newest page, which no longer holds row 1's skip.
      await expect(values).toHaveCount(200);
      await expect(values.filter({ hasText: /TabularRowSkip row 1 / })).toHaveCount(0);

      await drawer.getByRole('combobox', { name: 'Name' }).selectOption('sessionLog');
      const first = drawer.getByRole('button', { name: 'First', exact: true });
      await first.click();
      await expect(drawer.locator('.node-logs__range')).toHaveText(/^Lines 1–200 of 2\d\d$/);
      await expect(values.first()).toHaveText(/ Warning TabularRowSkip row 1 not_a_number: /);
      const box = await first.boundingBox();
      expect(box, 'First has a box').not.toBeNull();
      expect(box!.y + box!.height).toBeLessThanOrEqual(900);

      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * #1600 OR41 C6b — the same Settings tab on Copy · Files as-is, run for real
   * on a file connection: Everything logs each file read and written, and the
   * file If file exists = Skip left in place is a FileSkip with why.
   */
  test('a files-as-is Copy logs each file read, written and skipped in the Logs tab', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const problems = collectPageProblems(page);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1600-c6b-')));
    try {
      mkdirSync(join(root, 'in'));
      mkdirSync(join(root, 'out'));
      writeFileSync(join(root, 'in', 'a.txt'), 'alpha\n');
      writeFileSync(join(root, 'in', 'b.txt'), 'new b\n');
      writeFileSync(join(root, 'out', 'b.txt'), 'old b\n');
      const store = await seedConnection(page, {
        name: 'e2e 1600 c6b store',
        kind: 'fs',
        config: { roots: [root], writable: true },
      });
      const pipelineId = await openSeededCanvas(page, 'e2e 1600 c6b files session log', {
        nodes: [
          {
            id: 'copy1',
            type: 'copy_files',
            config: { sourcePath: 'in', sinkFolder: 'out', ifExists: 'skip' },
            connectionIds: { source: store, sink: store },
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
      });

      await nodeById(page, 'copy1').click();
      const pane = properties(page);
      await pane.getByRole('tab', { name: 'Settings', exact: true }).click();
      const level = pane.getByRole('combobox', { name: 'Session log' });
      await expect(level.locator('option:checked')).toHaveText('Warnings (default)');
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

      const runId = await fireAndSettle(page, latest.id, 'e2e 1600 c6b');
      const run = await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
      expect(run.status, `run: ${JSON.stringify(run)}`).toBe('success');
      expect(readFileSync(join(root, 'out', 'b.txt'), 'utf8')).toBe('old b\n');
      const events = (await (
        await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
      ).json()) as { type: string; payload: Record<string, unknown> }[];
      const lines = events
        .filter((e) => e.type === 'node.output' && e.payload['name'] === 'sessionLog')
        .map((e) => e.payload['value'] as string);
      const ts = '\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z';
      expect(lines, `events: ${JSON.stringify(events.map((e) => e.type))}`).toHaveLength(3);
      expect(lines[0]).toMatch(new RegExp(`^${ts} Info FileRead a\\.txt read 6 bytes$`));
      expect(lines[1]).toMatch(
        new RegExp(`^${ts} Info FileWrite a\\.txt wrote 6 bytes from 'a\\.txt'$`),
      );
      expect(lines[2]).toMatch(
        new RegExp(
          `^${ts} Warning FileSkip b\\.txt skipped: 'b\\.txt' already exists and If file exists is Skip$`,
        ),
      );

      // The Logs tab shows each line whole.
      await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
      await page.locator('.activity-runs__table .activity-runs__open').first().click();
      const drawer = page.locator('#run-detail-drawer');
      await drawer
        .getByRole('tablist', { name: 'Activity run details' })
        .getByRole('tab', { name: 'Logs', exact: true })
        .click();
      const values = drawer.locator('.node-logs tbody tr td:last-child');
      for (const line of lines) await expect(values.filter({ hasText: line })).toHaveCount(1);
      expect(lines[2]!.length).toBeGreaterThan(80);

      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
