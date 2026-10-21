import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, nodeById, openSeededCanvas } from './support/seedDoc';
import { properties } from './support/panels';
import { seedConnection } from './support/seedResources';

/**
 * #1600 OR41 C6f-2 — Copy · Files as-is's Degree of copy parallelism (ADF's
 * `parallelCopies`, parallel by file between file stores, and the
 * `usedParallelCopies` it reports,
 * https://learn.microsoft.com/azure/data-factory/copy-activity-performance-features#parallel-copy),
 * set on the Settings tab and run for real. That the files really are copied
 * at once is a timing a browser cannot see, so it is unit-tested
 * (`fs-files-copy-interleave.test.ts`); here the degree is saved and reported.
 */
test.describe('#1600 C6f-2 — Copy · Files as-is Degree of copy parallelism', () => {
  test('leads the Settings tab, not under Merge, and a run reports the copies it used', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const problems = collectPageProblems(page);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1600-c6f2-')));
    try {
      mkdirSync(join(root, 'in', 'sub'), { recursive: true });
      writeFileSync(join(root, 'in', 'a.txt'), 'alpha\n');
      writeFileSync(join(root, 'in', 'b.txt'), 'bravo\n');
      writeFileSync(join(root, 'in', 'sub', 'c.txt'), 'charlie\n');
      const store = await seedConnection(page, {
        name: 'e2e 1600 c6f2 store',
        kind: 'fs',
        config: { roots: [root], writable: true },
      });
      const pipelineId = await openSeededCanvas(page, 'e2e 1600 c6f2 parallel copies', {
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
      const sinkTab = pane.getByRole('tab', { name: 'Sink', exact: true });
      const degree = pane.getByRole('textbox', { name: 'Degree of copy parallelism', exact: true });
      const skipMissing = pane.getByRole('checkbox', { name: 'Skip missing files', exact: true });

      // Not drawn under Merge, which writes one file.
      await sinkTab.click();
      const behaviour = pane.getByRole('combobox', { name: 'Copy behaviour' });
      await behaviour.selectOption('merge');
      await settingsTab.click();
      await expect(skipMissing).toBeVisible();
      await expect(degree).toHaveCount(0);
      await sinkTab.click();
      await behaviour.selectOption('preserve');
      await settingsTab.click();

      // First on the tab, as in ADF's Settings, and sized as a number (UI
      // standard 5), above the fold.
      await expect(degree).toBeVisible();
      const degreeBox = await degree.boundingBox();
      const skipBox = await skipMissing.boundingBox();
      expect(degreeBox && skipBox, 'each control has a box').toBeTruthy();
      expect(
        degreeBox!.y < skipBox!.y - 1 ||
          (Math.abs(degreeBox!.y - skipBox!.y) < 8 && degreeBox!.x < skipBox!.x),
        `degree ${JSON.stringify(degreeBox)} skip ${JSON.stringify(skipBox)}`,
      ).toBe(true);
      expect(degreeBox!.width).toBeLessThanOrEqual(160);
      expect(degreeBox!.y + degreeBox!.height).toBeLessThanOrEqual(900);

      await degree.fill('2');
      await pane.getByRole('button', { name: 'Apply config' }).click();
      await page.getByRole('button', { name: 'Save version' }).click();
      await expect(page.locator('.notice')).toHaveText('Saved v2.');
      const versions = (await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json()) as { id: string; version: number; nodes: Record<string, unknown>[] }[];
      const latest = versions.sort((a, b) => b.version - a.version)[0]!;
      const copy = latest.nodes.find((n) => n['id'] === 'copy1')!;
      expect(copy['config']).toMatchObject({ parallelCopies: 2 });

      const runId = await fireAndSettle(page, latest.id, 'e2e 1600 c6f2');
      const run = await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
      expect(run.status, `run: ${JSON.stringify(run)}`).toBe('success');
      const events = (await (
        await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
      ).json()) as { type: string; payload: Record<string, unknown> }[];
      const succeeded = events.find((e) => e.type === 'node.succeeded');
      expect(succeeded?.payload['outputs']).toMatchObject({
        filesRead: 3,
        filesWritten: 3,
        usedParallelCopies: 2,
      });
      expect(readFileSync(join(root, 'out', 'a.txt'), 'utf8')).toBe('alpha\n');
      expect(readFileSync(join(root, 'out', 'b.txt'), 'utf8')).toBe('bravo\n');
      expect(readFileSync(join(root, 'out', 'sub', 'c.txt'), 'utf8')).toBe('charlie\n');

      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
