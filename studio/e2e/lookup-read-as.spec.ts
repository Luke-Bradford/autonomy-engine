import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { addActivity, canvasNodes, fillSelectedNodeConfig, toolbox } from './support/canvasGraph';
import { openSeededCanvas } from './support/seedDoc';
import { pickConnection, properties } from './support/panels';
import { seedConnection } from './support/seedResources';

/**
 * #1600 OR41 C7b — Lookup · *Read as* (activity catalogue §4.2).
 *
 * ONE Lookup in the palette, and no Read file beside it; the *Read as* select
 * leading its General tab switches the node between Rows (`lookup`) and Whole
 * file as text (`file_read`), as Copy mode does for Copy. What only a browser
 * can show: the select is reachable at 1440x900, the text mode has a Source
 * tab with the file path and no Settings, the type survives Save and a
 * reload, and a connection the text mode cannot use names that mode.
 */

const tab = (page: Page, name: string) => properties(page).getByRole('tab', { name, exact: true });
const readAs = (page: Page) =>
  properties(page).getByRole('combobox', { name: 'Read as', exact: true });

test.describe('#1600 C7b — Lookup · Read as', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('Read as switches a Lookup to a whole-file read, and it survives a save', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    // `realpathSync`: macOS `/var` is a symlink, and the fs connector refuses one.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1600-c7b-')));
    try {
      const fs = await seedConnection(page, {
        name: 'e2e 1600 c7b files',
        kind: 'fs',
        config: { roots: [root] },
      });
      await seedConnection(page, {
        name: 'e2e 1600 c7b db',
        kind: 'sqlite',
        config: { roots: [root], path: join(root, 'c7b.db') },
      });
      const pipelineId = await openSeededCanvas(page, 'e2e 1600 c7b read as', { nodes: [] });

      // ONE Lookup in the toolbox; Read file is its other mode, not an entry.
      await expect(toolbox(page).getByRole('button', { name: 'Read file' })).toHaveCount(0);
      await expect(toolbox(page).getByRole('button', { name: 'Lookup', exact: true })).toHaveCount(
        1,
      );
      await addActivity(page, 'Lookup');
      await expect(canvasNodes(page)).toHaveCount(1);
      await canvasNodes(page).first().click();
      await tab(page, 'General').click();
      await expect(readAs(page)).toHaveValue('lookup');
      await expect(tab(page, 'Settings')).toBeVisible();

      // Measured at 1440x900: drawn in the viewport, the first control on General.
      const box = await readAs(page).boundingBox();
      expect(box, 'Read as select has a box').not.toBeNull();
      expect(box!.y + box!.height).toBeLessThanOrEqual(900);
      const description = properties(page).getByRole('textbox', { name: 'Activity description' });
      expect(box!.y).toBeLessThan((await description.boundingBox())!.y);

      await readAs(page).selectOption({ label: 'Whole file as text' });
      await expect(readAs(page)).toHaveValue('file_read');
      await expect(tab(page, 'Settings')).toHaveCount(0);
      await tab(page, 'Source').click();
      await expect(properties(page).getByRole('combobox', { name: 'Source dataset' })).toHaveCount(
        0,
      );

      // A sqlite connection is listed, refused for THIS mode by name: a Lookup
      // reading rows would take it.
      await properties(page).getByRole('combobox', { name: 'Connection', exact: true }).click();
      await expect(
        page.getByRole('listbox').getByRole('option').filter({ hasText: 'e2e 1600 c7b db' }),
      ).toContainText("Lookup (whole file as text) can't use this kind yet");
      await page.keyboard.press('Escape');
      await expect(page.getByRole('listbox')).toHaveCount(0);

      await pickConnection(page, 'Connection', { id: fs });
      await fillSelectedNodeConfig(page, { 'File path': 'notes.txt' });

      await page.getByRole('button', { name: 'Save version' }).click();
      await expect(page.locator('.notice')).toHaveText('Saved v2.');

      // The saved version carries the type the select wrote, and its contract.
      const versions = await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json();
      const latest = (
        versions as {
          version: number;
          nodes: { type: string; connectionId?: string; config: Record<string, unknown> }[];
        }[]
      ).sort((a, b) => b.version - a.version)[0]!;
      expect(latest.nodes.map((n) => n.type)).toEqual(['file_read']);
      expect(latest.nodes[0]!.connectionId).toBe(fs);
      expect(latest.nodes[0]!.config).toMatchObject({
        path: 'notes.txt',
        outputs: [{ name: 'content' }, { name: 'path' }],
      });

      await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
      await expect(canvasNodes(page)).toHaveCount(1);
      await expect(canvasNodes(page).first()).toContainText('Lookup');
      await canvasNodes(page).first().click();
      await tab(page, 'General').click();
      await expect(readAs(page)).toHaveValue('file_read');
      await tab(page, 'Source').click();
      await expect(
        properties(page).getByRole('textbox', { name: 'File path', exact: true }),
      ).toHaveValue('notes.txt');

      // Back to rows starts as a new Lookup: First row only, on Settings.
      await tab(page, 'General').click();
      await readAs(page).selectOption({ label: 'Rows' });
      await tab(page, 'Settings').click();
      await expect(
        properties(page).getByRole('checkbox', { name: 'First row only', exact: true }),
      ).toBeChecked();
      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
