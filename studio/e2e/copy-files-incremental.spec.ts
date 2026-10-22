import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, nodeById, openSeededCanvas } from './support/seedDoc';
import { properties } from './support/panels';
import { seedConnection } from './support/seedResources';

/**
 * #1600 OR41 C5b — a Files as-is Copy's Load Incremental, *Modified since last
 * successful run* (catalogue §4.1): Load on the Source tab, Modified between
 * drawn only under Full, and a second run copying only the file written since
 * the first. The copy's cutoff is 2 s behind the clock (the settle margin), so
 * each run waits that out after its files are written.
 */
const SETTLE_MS = 2_100;

test.describe('#1600 C5b — Copy · Files as-is Load Incremental', () => {
  test('Load Incremental on the Source tab saves, and a second run copies only the new file', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const problems = collectPageProblems(page);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1600-c5b-')));
    try {
      const src = join(root, 'src');
      const dst = join(root, 'dst');
      mkdirSync(join(src, 'in'), { recursive: true });
      mkdirSync(dst);
      writeFileSync(join(src, 'in', 'a.csv'), 'a');
      const source = await seedConnection(page, {
        name: 'e2e 1600 c5b source',
        kind: 'fs',
        config: { roots: [src] },
      });
      const sink = await seedConnection(page, {
        name: 'e2e 1600 c5b sink',
        kind: 'fs',
        config: { roots: [dst], writable: true },
      });
      const pipelineId = await openSeededCanvas(page, 'e2e 1600 c5b incremental', {
        nodes: [
          {
            id: 'copy1',
            type: 'copy_files',
            config: { sourcePath: 'in' },
            connectionIds: { source, sink },
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
      });

      await nodeById(page, 'copy1').click();
      const pane = properties(page);
      await pane.getByRole('tab', { name: 'Source', exact: true }).click();
      const load = pane.getByRole('combobox', { name: 'Load', exact: true });
      const from = pane.getByLabel('Modified from', { exact: true });
      const before = pane.getByLabel('Modified before', { exact: true });
      const sourcePath = pane.getByRole('textbox', { name: 'Source path', exact: true });
      await expect(load).toBeVisible();
      await expect(load.locator('option:checked')).toHaveText(/Full/);
      // Under Full, the explicit window is drawn.
      await expect(from).toHaveCount(1);
      await expect(before).toHaveCount(1);
      // Load sits directly under the required Source path, inside the 1440x900 view.
      const [pathBox, loadBox] = await Promise.all([sourcePath.boundingBox(), load.boundingBox()]);
      expect(pathBox && loadBox, 'each control has a box').toBeTruthy();
      expect(loadBox!.y).toBeGreaterThan(pathBox!.y);
      expect(loadBox!.y + loadBox!.height).toBeLessThanOrEqual(900);

      await load.selectOption('incremental');
      // Incremental sets the window itself.
      await expect(from).toHaveCount(0);
      await expect(before).toHaveCount(0);
      await pane.getByRole('button', { name: 'Apply config' }).click();

      await page.getByRole('button', { name: 'Save version' }).click();
      await expect(page.locator('.notice')).toHaveText('Saved v2.');
      const versions = (await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json()) as { id: string; version: number; nodes: Record<string, unknown>[] }[];
      const latest = versions.sort((a, b) => b.version - a.version)[0]!;
      const copy = latest.nodes.find((n) => n['id'] === 'copy1')!;
      expect(copy['config']).toMatchObject({ sourcePath: 'in', load: 'incremental' });

      const outputsOf = async (runId: string) => {
        const run = await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
        expect(run.status, `run: ${JSON.stringify(run)}`).toBe('success');
        const events = (await (
          await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
        ).json()) as { type: string; payload: Record<string, unknown> }[];
        const done = events.find((e) => e.type === 'node.succeeded')?.payload;
        return (done?.['outputs'] ?? {}) as Record<string, unknown>;
      };

      await page.waitForTimeout(SETTLE_MS);
      const first = await outputsOf(await fireAndSettle(page, latest.id, 'e2e 1600 c5b first'));
      expect(first).toMatchObject({ filesWritten: 1, watermark: { old: null } });
      const firstCutoff = (first['watermark'] as { new: string }).new;
      expect(Number.isNaN(Date.parse(firstCutoff))).toBe(false);
      expect(readdirSync(dst)).toEqual(['a.csv']);

      // The sink is emptied so the second run's writes are all it holds.
      rmSync(join(dst, 'a.csv'));
      writeFileSync(join(src, 'in', 'b.csv'), 'b');
      await page.waitForTimeout(SETTLE_MS);
      const second = await outputsOf(await fireAndSettle(page, latest.id, 'e2e 1600 c5b second'));
      expect(second).toMatchObject({ filesWritten: 1, watermark: { old: firstCutoff } });
      expect(readdirSync(dst)).toEqual(['b.csv']);

      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
