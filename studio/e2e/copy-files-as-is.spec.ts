import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { addActivity, canvasNodes, fillSelectedNodeConfig } from './support/canvasGraph';
import { fireAndSettle, openSeededCanvas, seedVersion } from './support/seedDoc';
import { pickConnection, properties } from './support/panels';
import { seedConnection } from './support/seedResources';

/**
 * #1600 OR41 C1a — Copy · Files as-is (activity catalogue §4.1).
 *
 * ONE Copy in the palette; the *Copy mode* select at the top of its Source tab
 * switches the node between Rows (`copy`) and Files as-is (`copy_files`). What
 * only a browser can show: the toggle is reachable at 1440x900 without
 * scrolling, Files as-is drops the Mapping tab and draws its own fields, and
 * the type the toggle wrote survives the client parse, Save and a reload.
 *
 * The second test runs a real copy through the server: bytes, not rows (a
 * binary file is part of the set), the folder's subfolder preserved, and every
 * source moved after it is written.
 */

const tab = (page: Page, name: string) => properties(page).getByRole('tab', { name, exact: true });

function tempRoot(tag: string): string {
  // `realpathSync`: macOS `/var` is a symlink, and the fs connector refuses one.
  return realpathSync(mkdtempSync(join(tmpdir(), `e2e-${tag}-`)));
}

test.describe('#1600 C1a — Copy · Files as-is', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the Copy mode toggle switches a Copy node to files as-is, and it survives a save', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const root = tempRoot('1600-author');
    try {
      const src = await seedConnection(page, {
        name: 'e2e 1600 landing',
        kind: 'fs',
        config: { roots: [root] },
      });
      const sink = await seedConnection(page, {
        name: 'e2e 1600 archive',
        kind: 'fs',
        config: { roots: [root], writable: true },
      });
      const pipelineId = await openSeededCanvas(page, 'e2e 1600 files as-is', { nodes: [] });

      // ONE Copy in the toolbox, and it lands in Rows mode.
      await addActivity(page, 'Copy data');
      await expect(canvasNodes(page)).toHaveCount(1);
      await canvasNodes(page).first().click();
      await tab(page, 'Source').click();
      const mode = properties(page).getByRole('combobox', { name: 'Copy mode', exact: true });
      await expect(mode).toHaveValue('copy');
      await expect(tab(page, 'Mapping')).toBeVisible();

      // Measured at 1440x900: the toggle is drawn inside the viewport, and it is
      // the FIRST control on the Source tab, above the connection picker.
      const box = await mode.boundingBox();
      expect(box, 'Copy mode select has a box').not.toBeNull();
      expect(box!.y + box!.height).toBeLessThanOrEqual(900);
      const picker = properties(page).getByRole('combobox', { name: 'Source connection' });
      expect(box!.y).toBeLessThan((await picker.boundingBox())!.y);

      await mode.selectOption({ label: 'Files as-is' });
      await expect(mode).toHaveValue('copy_files');
      await expect(tab(page, 'Mapping')).toHaveCount(0);
      await expect(properties(page).getByRole('combobox', { name: 'Path type' })).toBeVisible();
      await expect(properties(page).getByRole('combobox', { name: 'After copy' })).toBeVisible();
      await expect(properties(page).getByRole('combobox', { name: 'Source dataset' })).toHaveCount(
        0,
      );

      await pickConnection(page, 'Source connection', { id: src });
      await tab(page, 'Sink').click();
      await expect(
        properties(page).getByRole('combobox', { name: 'If file exists' }),
      ).toBeVisible();
      await pickConnection(page, 'Sink connection', { id: sink });
      await fillSelectedNodeConfig(page, { 'Source path': 'in', 'Sink folder': 'out' });

      await page.getByRole('button', { name: 'Save version' }).click();
      await expect(page.locator('.notice')).toHaveText('Saved v2.');

      // The saved version carries the type the toggle wrote.
      const versions = await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json();
      const latest = (versions as { version: number; nodes: { type: string }[] }[]).sort(
        (a, b) => b.version - a.version,
      )[0]!;
      expect(latest.nodes.map((n) => n.type)).toEqual(['copy_files']);

      await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
      await expect(canvasNodes(page)).toHaveCount(1);
      await canvasNodes(page).first().click();
      await tab(page, 'Source').click();
      await expect(
        properties(page).getByRole('combobox', { name: 'Copy mode', exact: true }),
      ).toHaveValue('copy_files');
      await expect(properties(page).getByRole('textbox', { name: 'Source path' })).toHaveValue(
        'in',
      );
      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a files-as-is copy writes the bytes, keeps the subfolders and moves each source', async ({
    page,
  }) => {
    const root = tempRoot('1600-run');
    try {
      const inDir = join(root, 'in');
      mkdirSync(join(inDir, 'sub'), { recursive: true });
      const binary = Buffer.from([0, 255, 13, 10, 0x80, 0x7f, 0]);
      writeFileSync(join(inDir, 'a.txt'), 'alpha\n');
      writeFileSync(join(inDir, 'b.bin'), binary);
      writeFileSync(join(inDir, 'sub', 'c.txt'), 'gamma\n');

      // Move after copy needs writes on the SOURCE too (fail-closed `writable`).
      const store = await seedConnection(page, {
        name: 'e2e 1600 run store',
        kind: 'fs',
        config: { roots: [root], writable: true },
      });
      const { pipelineVersionId } = await seedVersion(page, 'e2e 1600 files run', {
        nodes: [
          {
            id: 'n_copy',
            type: 'copy_files',
            position: { x: 0, y: 0 },
            connectionIds: { source: store, sink: store },
            config: {
              pathType: 'folder',
              sourcePath: 'in',
              sinkFolder: 'out',
              afterCopy: 'move',
              moveTo: 'done',
            },
          },
        ],
      });

      const runId = await fireAndSettle(page, pipelineVersionId, 'e2e 1600 run');
      const run = await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
      expect(run.status, `run: ${JSON.stringify(run)}`).toBe('success');

      expect(readFileSync(join(root, 'out', 'a.txt'), 'utf8')).toBe('alpha\n');
      expect(readFileSync(join(root, 'out', 'b.bin')).equals(binary)).toBe(true);
      expect(readFileSync(join(root, 'out', 'sub', 'c.txt'), 'utf8')).toBe('gamma\n');
      for (const rel of ['a.txt', 'b.bin', join('sub', 'c.txt')]) {
        expect(existsSync(join(inDir, rel)), `${rel} left the source`).toBe(false);
        expect(existsSync(join(root, 'done', rel)), `${rel} moved to done`).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
