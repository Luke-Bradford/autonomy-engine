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
import { pickConnection, problemsToggle, properties } from './support/panels';
import { seedConnection } from './support/seedResources';

/**
 * #1600 OR41 C1a — Copy · Files as-is (activity catalogue §4.1).
 *
 * ONE Copy in the palette; the *Copy mode* select leading its General tab (#1694 OR42 item 8)
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
      // #1694 OR42 item 8 — an activity-level choice: on General, not on Source.
      await tab(page, 'Source').click();
      const mode = properties(page).getByRole('combobox', { name: 'Copy mode', exact: true });
      await expect(mode).toHaveCount(0);
      await tab(page, 'General').click();
      await expect(mode).toHaveValue('copy');
      await expect(tab(page, 'Mapping')).toBeVisible();

      // Measured at 1440x900: the toggle is drawn inside the viewport, and it is
      // the FIRST control on General, above the description.
      const box = await mode.boundingBox();
      expect(box, 'Copy mode select has a box').not.toBeNull();
      expect(box!.y + box!.height).toBeLessThanOrEqual(900);
      const description = properties(page).getByRole('textbox', { name: 'Activity description' });
      expect(box!.y).toBeLessThan((await description.boundingBox())!.y);

      await mode.selectOption({ label: 'Files as-is' });
      await expect(mode).toHaveValue('copy_files');
      await expect(tab(page, 'Mapping')).toHaveCount(0);
      await tab(page, 'Source').click();
      await expect(properties(page).getByRole('combobox', { name: 'Path type' })).toBeVisible();
      await expect(properties(page).getByRole('combobox', { name: 'After copy' })).toBeVisible();
      await expect(properties(page).getByRole('combobox', { name: 'Source dataset' })).toHaveCount(
        0,
      );

      // #1686 — the dock draws only the fields that apply to the current
      // choices, and follows them as they change.
      const field = (role: 'textbox' | 'checkbox', name: string) =>
        properties(page).getByRole(role, { name, exact: true });
      const pathType = properties(page).getByRole('combobox', { name: 'Path type' });
      const afterCopy = properties(page).getByRole('combobox', { name: 'After copy' });
      await expect(field('textbox', 'Wildcard')).toBeVisible();
      await expect(field('checkbox', 'Include subfolders')).toBeVisible();
      await expect(field('textbox', 'File list path')).toHaveCount(0);
      await expect(field('textbox', 'Move to')).toHaveCount(0);
      await pathType.selectOption({ label: 'File list' });
      await expect(field('textbox', 'File list path')).toBeVisible();
      await expect(field('textbox', 'Wildcard')).toHaveCount(0);
      await expect(field('checkbox', 'Include subfolders')).toHaveCount(0);
      await afterCopy.selectOption({ label: 'Move source to' });
      await expect(field('textbox', 'Move to')).toBeVisible();
      await afterCopy.selectOption({ label: 'Keep source' });
      await expect(field('textbox', 'Move to')).toHaveCount(0);
      await pathType.selectOption({ label: 'Folder' });
      await expect(field('textbox', 'Wildcard')).toBeVisible();
      // Unset, the copy recurses, so the box shows ticked; unticking it is
      // saved as `false` below rather than dropped back to the default.
      await expect(field('checkbox', 'Include subfolders')).toBeChecked();
      await field('checkbox', 'Include subfolders').uncheck();

      await pickConnection(page, 'Source connection', { id: src });
      await tab(page, 'Sink').click();
      await expect(
        properties(page).getByRole('combobox', { name: 'If file exists' }),
      ).toBeVisible();
      // A folder copy keeps each file's own name, so File name is left out.
      await expect(
        properties(page).getByRole('textbox', { name: 'File name', exact: true }),
      ).toHaveCount(0);
      await pickConnection(page, 'Sink connection', { id: sink });
      await fillSelectedNodeConfig(page, { 'Source path': 'in', 'Sink folder': 'out' });

      await page.getByRole('button', { name: 'Save version' }).click();
      await expect(page.locator('.notice')).toHaveText('Saved v2.');

      // The saved version carries the type the toggle wrote.
      const versions = await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json();
      const latest = (
        versions as { version: number; nodes: { type: string; config: object }[] }[]
      ).sort((a, b) => b.version - a.version)[0]!;
      expect(latest.nodes.map((n) => n.type)).toEqual(['copy_files']);
      expect(latest.nodes[0]!.config).toMatchObject({ recursive: false });

      await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
      await expect(canvasNodes(page)).toHaveCount(1);
      await canvasNodes(page).first().click();
      await tab(page, 'General').click();
      await expect(
        properties(page).getByRole('combobox', { name: 'Copy mode', exact: true }),
      ).toHaveValue('copy_files');
      await tab(page, 'Source').click();
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

  /**
   * #1600 C1b — catalogue §8. A stored Move file keeps running as it was, on a
   * connection that never allowed writes. Opened in the editor it IS Copy ·
   * Files as-is (After copy Delete source), the Problems list says the run will
   * now need Allow writes, and Save writes it as `copy_files`, which runs once
   * writes are allowed.
   */
  test('a stored Move file runs as before, opens as Copy · Files as-is, and saves as one', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const root = tempRoot('1600-lower');
    try {
      mkdirSync(join(root, 'in'));
      mkdirSync(join(root, 'out'));
      writeFileSync(join(root, 'in', 'a.txt'), 'alpha\n');
      const store = await seedConnection(page, {
        name: 'e2e 1600 legacy store',
        kind: 'fs',
        config: { roots: [root] },
      });
      const doc = {
        nodes: [
          {
            id: 'n_move',
            type: 'file_move',
            position: { x: 0, y: 0 },
            connectionId: store,
            config: { source: 'in/a.txt', dest: 'out/a.txt' },
          },
        ],
      };
      const { pipelineId, pipelineVersionId } = await seedVersion(page, 'e2e 1600 legacy', doc);

      // The stored version is untouched by the lowering: it runs as file_move.
      const oldRun = await fireAndSettle(page, pipelineVersionId, 'e2e 1600 legacy run');
      const old = await (await page.request.get(`/api/runs/${encodeURIComponent(oldRun)}`)).json();
      expect(old.status, `run: ${JSON.stringify(old)}`).toBe('success');
      expect(existsSync(join(root, 'in', 'a.txt'))).toBe(false);
      expect(readFileSync(join(root, 'out', 'a.txt'), 'utf8')).toBe('alpha\n');
      rmSync(join(root, 'out', 'a.txt'));
      writeFileSync(join(root, 'in', 'a.txt'), 'alpha\n');

      await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
      await expect(canvasNodes(page)).toHaveCount(1);
      await canvasNodes(page).first().click();
      await tab(page, 'General').click();
      await expect(
        properties(page).getByRole('combobox', { name: 'Copy mode', exact: true }),
      ).toHaveValue('copy_files');
      await tab(page, 'Source').click();
      await expect(properties(page).getByRole('textbox', { name: 'Source path' })).toHaveValue(
        'in/a.txt',
      );
      await expect(properties(page).getByRole('combobox', { name: 'After copy' })).toHaveValue(
        'delete',
      );
      await tab(page, 'Sink').click();
      await expect(properties(page).getByRole('textbox', { name: 'Sink folder' })).toHaveValue(
        'out',
      );
      await expect(
        properties(page).getByRole('textbox', { name: 'File name', exact: true }),
      ).toHaveValue('a.txt');

      // Opening is not an edit; the Allow writes warning is listed, not blocking.
      await expect(page.getByRole('button', { name: 'Save version' })).toBeDisabled();
      const toggle = problemsToggle(page);
      await expect(toggle.locator('.count-badge').first()).toHaveText('1');
      await toggle.click();
      await expect(page.locator('.problems-panel')).toContainText(
        "the sink connection 'e2e 1600 legacy store' does not allow writes",
      );

      // Any edit saves the node as its replacement.
      await tab(page, 'General').click();
      await properties(page)
        .getByRole('textbox', { name: 'Activity description' })
        .fill('moved by the lowering');
      await page.getByRole('button', { name: 'Save version' }).click();
      await expect(page.locator('.notice')).toHaveText('Saved v2.');
      const versions = (await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json()) as {
        id: string;
        version: number;
        nodes: { type: string; connectionIds?: object; config: object }[];
      }[];
      const latest = versions.sort((a, b) => b.version - a.version)[0]!;
      expect(latest.nodes[0]).toMatchObject({
        type: 'copy_files',
        connectionIds: { source: store, sink: store },
        config: { pathType: 'file', sourcePath: 'in/a.txt', afterCopy: 'delete' },
      });

      // Allowed writes, the saved copy moves the file as the old version did.
      const allowed = await page.request.patch(`/api/connections/${encodeURIComponent(store)}`, {
        data: { config: { roots: [root], writable: true } },
      });
      expect(allowed.status(), await allowed.text()).toBe(200);
      const newRun = await fireAndSettle(page, latest.id, 'e2e 1600 lowered run');
      const now = await (await page.request.get(`/api/runs/${encodeURIComponent(newRun)}`)).json();
      expect(now.status, `run: ${JSON.stringify(now)}`).toBe('success');
      expect(existsSync(join(root, 'in', 'a.txt'))).toBe(false);
      expect(readFileSync(join(root, 'out', 'a.txt'), 'utf8')).toBe('alpha\n');
      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
