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
              // #1600 OR41 C6f-1 — the five a Copy saved before its complete
              // outputs declares. The editor re-seeds them on load, so Save
              // writes today's contract and the run may yield `consistency`.
              outputs: [
                { name: 'rowsRead', type: 'number' },
                { name: 'rowsWritten', type: 'number' },
                { name: 'rowsFailed', type: 'number' },
                { name: 'bytesRead', type: 'number' },
                { name: 'truncated', type: 'boolean' },
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

      // Off by default, beside Skip incompatible rows on one row (short fields
      // pack, UI standard rule 5) and above the Session log (the spec's Settings
      // order), inside the 900px viewport.
      await expect(verify).not.toBeChecked();
      const skipBox = await pane
        .getByRole('checkbox', { name: 'Skip incompatible rows', exact: true })
        .boundingBox();
      const verifyBox = await verify.boundingBox();
      const levelBox = await pane.getByRole('combobox', { name: 'Session log' }).boundingBox();
      expect(skipBox && verifyBox && levelBox, 'all three fields have a box').toBeTruthy();
      expect(Math.abs(skipBox!.y - verifyBox!.y)).toBeLessThan(1);
      expect(skipBox!.x).toBeLessThan(verifyBox!.x);
      expect(verifyBox!.y + verifyBox!.height).toBeLessThanOrEqual(levelBox!.y);
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
      expect(
        (copy['config'] as { outputs: { name: string }[] }).outputs.map((o) => o.name),
      ).toEqual([
        'rowsRead',
        'rowsWritten',
        'rowsSkipped',
        'rowsFailed',
        'bytesRead',
        'truncated',
        'durationMs',
        'throughput',
        'consistency',
        // C6f-2.
        'usedParallelCopies',
        // C6c-1b.
        'logPath',
        // C5a, declared for every new copy; yielded under Load Incremental only.
        'watermark',
      ]);

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
      // C6f-1 — ADF's InconsistentData Found, reported ahead of the failure.
      const consistency = events.find(
        (e) => e.type === 'node.output' && e.payload['name'] === 'consistency',
      );
      expect(consistency?.payload['value']).toEqual({ verified: true, result: 'found' });
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

/**
 * #1600 OR41 C6e-2 — Copy · Files as-is's Verify copied files and Skip
 * inconsistent files (ADF's `validateDataConsistency` and
 * `skipErrorFile.dataInconsistency` for binary files,
 * https://learn.microsoft.com/azure/data-factory/copy-activity-data-consistency),
 * set on the Settings tab and run for real. A file changing while it is read
 * is a race a browser cannot time, so its failure and skip are unit-tested
 * (`fs-files-copy-interleave.test.ts`); here a verified copy of files that do
 * not change succeeds.
 */
test.describe('#1600 C6e-2 — Copy · Files as-is Verify copied files', () => {
  test('drawn under Preserve hierarchy, with its skip once it is on, and a verified copy runs', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const problems = collectPageProblems(page);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1600-c6e2-')));
    try {
      mkdirSync(join(root, 'in', 'sub'), { recursive: true });
      writeFileSync(join(root, 'in', 'a.txt'), 'alpha\n');
      writeFileSync(join(root, 'in', 'sub', 'b.txt'), 'beta\n');
      const store = await seedConnection(page, {
        name: 'e2e 1600 c6e2 store',
        kind: 'fs',
        config: { roots: [root], writable: true },
      });
      const pipelineId = await openSeededCanvas(page, 'e2e 1600 c6e2 verify copied files', {
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
      const verify = pane.getByRole('checkbox', { name: 'Verify copied files', exact: true });
      const skip = pane.getByRole('checkbox', { name: 'Skip inconsistent files', exact: true });
      const level = pane.getByRole('combobox', { name: 'Session log' });

      // Not drawn under Flatten, which ADF does not verify.
      await pane.getByRole('tab', { name: 'Sink', exact: true }).click();
      const behaviour = pane.getByRole('combobox', { name: 'Copy behaviour' });
      await behaviour.selectOption('flatten');
      await settingsTab.click();
      await expect(level).toBeVisible();
      await expect(verify).toHaveCount(0);
      await pane.getByRole('tab', { name: 'Sink', exact: true }).click();
      await behaviour.selectOption('preserve');
      await settingsTab.click();

      // Off by default, and its skip is drawn only once it is on.
      await expect(verify).not.toBeChecked();
      await expect(skip).toHaveCount(0);
      await verify.check();
      await expect(skip).not.toBeChecked();
      // Short fields pack side by side, three to a row at this width (UI
      // standard 5), in order: the skip is the cell after the check it depends
      // on, and the Session log the one after that, all above the fold.
      const verifyBox = await verify.boundingBox();
      const skipBox = await skip.boundingBox();
      const levelBox = await level.boundingBox();
      expect(verifyBox && skipBox && levelBox, 'each control has a box').toBeTruthy();
      const after = (a: { x: number; y: number }, b: { x: number; y: number }) =>
        a.y > b.y + 1 || (Math.abs(a.y - b.y) < 8 && a.x > b.x);
      expect(after(skipBox!, verifyBox!), `skip ${JSON.stringify(skipBox)}`).toBe(true);
      expect(after(levelBox!, skipBox!), `level ${JSON.stringify(levelBox)}`).toBe(true);
      expect(levelBox!.y + levelBox!.height).toBeLessThanOrEqual(900);
      await skip.check();
      await pane.getByRole('button', { name: 'Apply config' }).click();

      await page.getByRole('button', { name: 'Save version' }).click();
      await expect(page.locator('.notice')).toHaveText('Saved v2.');
      const versions = (await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json()) as { id: string; version: number; nodes: Record<string, unknown>[] }[];
      const latest = versions.sort((a, b) => b.version - a.version)[0]!;
      const copy = latest.nodes.find((n) => n['id'] === 'copy1')!;
      expect(copy['config']).toMatchObject({
        validateDataConsistency: true,
        skipInconsistentFiles: true,
      });

      const runId = await fireAndSettle(page, latest.id, 'e2e 1600 c6e2');
      const run = await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
      expect(run.status, `run: ${JSON.stringify(run)}`).toBe('success');
      const events = (await (
        await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
      ).json()) as { type: string; payload: Record<string, unknown> }[];
      const succeeded = events.find((e) => e.type === 'node.succeeded');
      expect(succeeded?.payload['outputs']).toMatchObject({
        filesRead: 2,
        filesWritten: 2,
        filesSkipped: 0,
        // C6f-1 — the run's measures.
        durationMs: expect.any(Number),
        consistency: { verified: true, result: 'none' },
      });
      expect(readFileSync(join(root, 'out', 'a.txt'), 'utf8')).toBe('alpha\n');
      expect(readFileSync(join(root, 'out', 'sub', 'b.txt'), 'utf8')).toBe('beta\n');

      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
