import {
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
import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { addActivity, canvasNodes, fillSelectedNodeConfig, toolbox } from './support/canvasGraph';
import { fireAndSettle, openSeededCanvas, seedVersion } from './support/seedDoc';
import { pickConnection, properties } from './support/panels';
import { seedConnection } from './support/seedResources';

/**
 * #1600 OR41 C9a — Delete on a file system connection (activity catalogue §4.4,
 * ADF's Delete activity).
 *
 * What only a browser can show: the palette offers Delete, its Source and
 * Settings tabs draw inside 1440x900, Delete empty folders appears only once
 * Include subfolders is ticked, the form saves the config, and the saved version
 * deletes exactly the matching files and the folders they leave empty.
 */

const tab = (page: Page, name: string) => properties(page).getByRole('tab', { name, exact: true });
const checkbox = (page: Page, name: string) =>
  properties(page).getByRole('checkbox', { name, exact: true });

test.describe('#1600 C9a — Delete', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('deletes the matching files and the subfolders they leave empty', async ({ page }) => {
    const problems = collectPageProblems(page);
    // `realpathSync`: macOS `/var` is a symlink, and the fs connector refuses one.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1600-c9a-')));
    try {
      mkdirSync(join(root, 'in', 'day1'), { recursive: true });
      mkdirSync(join(root, 'in', 'day2'), { recursive: true });
      writeFileSync(join(root, 'in', 'a.txt'), 'a');
      writeFileSync(join(root, 'in', 'keep.csv'), 'k');
      writeFileSync(join(root, 'in', 'day1', 'b.txt'), 'b');
      writeFileSync(join(root, 'in', 'day2', 'c.txt'), 'c');
      writeFileSync(join(root, 'in', 'day2', 'keep.csv'), 'k');
      const fs = await seedConnection(page, {
        name: 'e2e 1600 c9a files',
        kind: 'fs',
        config: { roots: [root], writable: true },
      });
      const pipelineId = await openSeededCanvas(page, 'e2e 1600 c9a delete', { nodes: [] });

      await expect(toolbox(page).getByRole('button', { name: 'Delete', exact: true })).toHaveCount(
        1,
      );
      await addActivity(page, 'Delete');
      await expect(canvasNodes(page)).toHaveCount(1);
      await canvasNodes(page).first().click();

      // Delete empty folders waits for Include subfolders.
      await tab(page, 'Settings').click();
      // Empty shows the default, as every defaulted field does.
      await expect(
        properties(page).getByRole('textbox', { name: 'Max concurrent deletes', exact: true }),
      ).toHaveAttribute('placeholder', '1');
      await expect(checkbox(page, 'Fail if nothing matched')).not.toBeChecked();
      await expect(checkbox(page, 'Delete empty folders')).toHaveCount(0);

      await tab(page, 'Source').click();
      await pickConnection(page, 'Connection', { id: fs });
      // Unset, it names its schema default (#1732).
      await expect(
        properties(page)
          .getByRole('combobox', { name: 'Path type', exact: true })
          .locator('option:checked'),
      ).toHaveText('Folder (default)');
      await checkbox(page, 'Include subfolders').check();

      await tab(page, 'Settings').click();
      await expect(checkbox(page, 'Delete empty folders')).toBeVisible();
      // Measured at 1440x900: the whole Settings tab is in the docked pane's view.
      const last = await checkbox(page, 'Delete empty folders').boundingBox();
      expect(last, 'Delete empty folders has a box').not.toBeNull();
      expect(last!.y + last!.height).toBeLessThanOrEqual(900);
      await checkbox(page, 'Delete empty folders').check();
      await fillSelectedNodeConfig(page, { 'File or folder path': 'in', Wildcard: '*.txt' });

      await page.getByRole('button', { name: 'Save version' }).click();
      await expect(page.locator('.notice')).toHaveText('Saved v2.');

      const versions = (await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json()) as {
        id: string;
        version: number;
        nodes: { type: string; config: Record<string, unknown> }[];
      }[];
      const latest = versions.sort((a, b) => b.version - a.version)[0]!;
      expect(latest.nodes.map((n) => n.type)).toEqual(['delete']);
      expect(latest.nodes[0]!.config).toMatchObject({
        path: 'in',
        wildcard: '*.txt',
        recursive: true,
        deleteEmptyFolders: true,
      });

      const runId = await fireAndSettle(page, latest.id, 'e2e 1600 c9a');
      const events = (await (
        await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
      ).json()) as { type: string; payload: Record<string, unknown> }[];
      const done = events.find((e) => e.type === 'node.succeeded');
      expect(done, `events: ${JSON.stringify(events.map((e) => e.type))}`).toBeDefined();
      expect(done!.payload.outputs).toEqual({
        path: join(root, 'in'),
        filesDeleted: 3,
        foldersDeleted: 1,
      });
      // day1 is emptied and goes; day2 keeps its csv; the folder at the path stays.
      expect(readdirSync(join(root, 'in')).sort()).toEqual(['day2', 'keep.csv']);
      expect(readdirSync(join(root, 'in', 'day2'))).toEqual(['keep.csv']);
      expect(existsSync(join(root, 'in'))).toBe(true);
      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * #1600 C9b — catalogue §8. A stored Delete file keeps running as it was.
   * Opened in the editor it IS Delete, Path type File and Fail if nothing
   * matched ticked, and Delete file is gone from the palette. Save writes it as
   * Delete, and the saved version deletes the file as the stored one did.
   */
  test('a stored Delete file runs as before, opens as Delete, and saves as one', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1600-c9b-')));
    try {
      mkdirSync(join(root, 'in'));
      writeFileSync(join(root, 'in', 'old.csv'), 'o');
      const fs = await seedConnection(page, {
        name: 'e2e 1600 c9b files',
        kind: 'fs',
        config: { roots: [root], writable: true },
      });
      const { pipelineId, pipelineVersionId } = await seedVersion(page, 'e2e 1600 c9b legacy', {
        nodes: [
          {
            id: 'del',
            type: 'file_delete',
            position: { x: 0, y: 0 },
            connectionId: fs,
            config: { path: 'in/old.csv' },
          },
        ],
      });
      const outputsOf = async (versionId: string, name: string) => {
        const runId = await fireAndSettle(page, versionId, name);
        const events = (await (
          await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
        ).json()) as { type: string; payload: { nodeId?: string; outputs?: unknown } }[];
        const done = events.find((e) => e.type === 'node.succeeded' && e.payload.nodeId === 'del');
        expect(done, `events: ${JSON.stringify(events.map((e) => e.type))}`).toBeDefined();
        return done!.payload.outputs;
      };
      // The stored version is untouched by the lowering: it runs as file_delete.
      expect(await outputsOf(pipelineVersionId, 'e2e 1600 c9b old')).toEqual({
        path: join(root, 'in', 'old.csv'),
      });
      expect(existsSync(join(root, 'in', 'old.csv'))).toBe(false);

      await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
      await expect(canvasNodes(page)).toHaveCount(1);
      await expect(
        toolbox(page).getByRole('button', { name: 'Delete file', exact: true }),
      ).toHaveCount(0);
      await canvasNodes(page).filter({ hasText: 'Delete' }).click();
      await tab(page, 'Source').click();
      await expect(
        properties(page)
          .getByRole('combobox', { name: 'Path type', exact: true })
          .locator('option:checked'),
      ).toHaveText('File');
      await expect(
        properties(page).getByRole('textbox', { name: 'File or folder path', exact: true }),
      ).toHaveValue('in/old.csv');
      await tab(page, 'Settings').click();
      await expect(checkbox(page, 'Fail if nothing matched')).toBeChecked();
      // Any edit saves the node as its replacement.
      await tab(page, 'General').click();
      await properties(page)
        .getByRole('textbox', { name: 'Activity description' })
        .fill('lowered from Delete file');
      await page.getByRole('button', { name: 'Save version' }).click();
      await expect(page.locator('.notice')).toHaveText('Saved v2.');

      const versions = (await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json()) as {
        id: string;
        version: number;
        nodes: { id: string; type: string; config: Record<string, unknown> }[];
      }[];
      const latest = versions.sort((a, b) => b.version - a.version)[0]!;
      expect(latest.nodes[0]).toMatchObject({
        id: 'del',
        type: 'delete',
        config: { pathType: 'file', path: 'in/old.csv', failIfNothingMatched: true },
      });

      writeFileSync(join(root, 'in', 'old.csv'), 'o');
      writeFileSync(join(root, 'in', 'keep.csv'), 'k');
      expect(await outputsOf(latest.id, 'e2e 1600 c9b new')).toEqual({
        path: join(root, 'in', 'old.csv'),
        filesDeleted: 1,
        foldersDeleted: 0,
      });
      expect(readdirSync(join(root, 'in'))).toEqual(['keep.csv']);
      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
