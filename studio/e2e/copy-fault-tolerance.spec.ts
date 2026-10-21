import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
        // #1600 OR41 C6f-1 — ADF's name, and the old one kept beside it.
        rowsSkipped: 1,
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

/**
 * #1600 OR41 C6d-2 — Copy · Files as-is's Skip missing files and Skip
 * forbidden files (catalogue §4.1 Settings · Fault tolerance; ADF's
 * `skipErrorFile`, https://learn.microsoft.com/azure/data-factory/copy-activity-fault-tolerance),
 * set on the Settings tab and run for real: a file the connection may not read
 * is skipped and logged, and the rest are copied. The missing-file races are
 * unit-tested (`fs-files-copy-interleave.test.ts`); a browser cannot time them.
 */
test.describe('#1600 C6d-2 — Copy · Files as-is Skip missing and forbidden files', () => {
  // A file mode of 000 does not stop root, so the skip could not happen.
  test.skip(process.getuid?.() === 0, 'root reads a mode-000 file');

  test('set on the Settings tab, a forbidden file is skipped and the rest copied', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const problems = collectPageProblems(page);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1600-c6d2-')));
    try {
      mkdirSync(join(root, 'in'));
      writeFileSync(join(root, 'in', 'a.txt'), 'alpha\n');
      writeFileSync(join(root, 'in', 'b.txt'), 'secret\n');
      chmodSync(join(root, 'in', 'b.txt'), 0o000);
      const store = await seedConnection(page, {
        name: 'e2e 1600 c6d2 store',
        kind: 'fs',
        config: { roots: [root], writable: true },
      });
      const pipelineId = await openSeededCanvas(page, 'e2e 1600 c6d2 skip forbidden files', {
        nodes: [
          {
            id: 'copy1',
            type: 'copy_files',
            config: { sourcePath: 'in', sinkFolder: 'out' },
            connectionIds: { source: store, sink: store },
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
      });

      await nodeById(page, 'copy1').click();
      const pane = properties(page);
      const settingsTab = pane.getByRole('tab', { name: 'Settings', exact: true });
      const missing = pane.getByRole('checkbox', { name: 'Skip missing files', exact: true });
      const forbidden = pane.getByRole('checkbox', { name: 'Skip forbidden files', exact: true });
      const level = pane.getByRole('combobox', { name: 'Session log' });

      // Not drawn for one file, which fails whatever they say, as in ADF.
      const pathType = pane.getByRole('combobox', { name: 'Path type' });
      await pathType.selectOption('file');
      await settingsTab.click();
      await expect(level).toBeVisible();
      await expect(missing).toHaveCount(0);
      await expect(forbidden).toHaveCount(0);
      await pane.getByRole('tab', { name: 'Source', exact: true }).click();
      await pathType.selectOption('folder');
      await settingsTab.click();

      // ADF's defaults, first on the tab and above the Session log. Short
      // fields pack side by side (UI standard 5), so the two share a row.
      await expect(missing).toBeChecked();
      await expect(forbidden).not.toBeChecked();
      const missingBox = await missing.boundingBox();
      const forbiddenBox = await forbidden.boundingBox();
      const levelBox = await level.boundingBox();
      expect(missingBox && forbiddenBox && levelBox, 'each control has a box').toBeTruthy();
      expect(missingBox!.y).toBe(forbiddenBox!.y);
      expect(missingBox!.x).toBeLessThan(forbiddenBox!.x);
      expect(forbiddenBox!.y).toBeLessThan(levelBox!.y);
      expect(levelBox!.y + levelBox!.height).toBeLessThanOrEqual(900);
      await forbidden.check();
      // Round-trips the other way too: off is stored as off.
      await missing.uncheck();
      await pane.getByRole('button', { name: 'Apply config' }).click();

      await page.getByRole('button', { name: 'Save version' }).click();
      await expect(page.locator('.notice')).toHaveText('Saved v2.');
      const versions = (await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json()) as { id: string; version: number; nodes: Record<string, unknown>[] }[];
      const latest = versions.sort((a, b) => b.version - a.version)[0]!;
      const copy = latest.nodes.find((n) => n['id'] === 'copy1')!;
      expect(copy['config']).toMatchObject({
        pathType: 'folder',
        skipMissingFiles: false,
        skipForbiddenFiles: true,
      });

      const runId = await fireAndSettle(page, latest.id, 'e2e 1600 c6d2');
      const run = await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
      expect(run.status, `run: ${JSON.stringify(run)}`).toBe('success');
      const events = (await (
        await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
      ).json()) as { type: string; payload: Record<string, unknown> }[];
      const lines = events
        .filter((e) => e.type === 'node.output' && e.payload['name'] === 'sessionLog')
        .map((e) => (e.payload['value'] as string).replace(/^\S+ /, ''));
      expect(lines).toEqual([
        'Warning FileSkip b.txt skipped: permission denied and Skip forbidden files is on',
      ]);
      const succeeded = events.find((e) => e.type === 'node.succeeded');
      expect(succeeded?.payload['outputs']).toMatchObject({
        filesRead: 1,
        filesWritten: 1,
        filesSkipped: 1,
      });
      expect(readdirSync(join(root, 'out'))).toEqual(['a.txt']);
      expect(existsSync(join(root, 'in', 'b.txt'))).toBe(true);

      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
