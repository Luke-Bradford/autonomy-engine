import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { addActivity, canvasNodes, fillSelectedNodeConfig, toolbox } from './support/canvasGraph';
import { fireAndSettle, openSeededCanvas, seedVersion } from './support/seedDoc';
import { pickConnection, properties } from './support/panels';
import { seedConnection } from './support/seedResources';

/**
 * #1600 OR41 C8a — Get metadata on a file system connection (activity
 * catalogue §4.3, ADF's Get Metadata activity).
 *
 * What only a browser can show: the palette offers it, its Settings tab draws
 * the field list as a grid of tick boxes inside 1440x900, the child item
 * settings appear only once Child items is ticked, the ticks save as ADF's
 * `fieldList` array, and the saved version runs and fills exactly the ticked
 * outputs.
 */

const tab = (page: Page, name: string) => properties(page).getByRole('tab', { name, exact: true });
const fieldList = (page: Page) => properties(page).getByRole('group', { name: 'Field list' });
const box = (page: Page, name: string) =>
  fieldList(page).getByRole('checkbox', { name, exact: true });

test.describe('#1600 C8a — Get metadata', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('ticks fields, saves them as the field list, and the run fills exactly those', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    // `realpathSync`: macOS `/var` is a symlink, and the fs connector refuses one.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1600-c8a-')));
    try {
      mkdirSync(join(root, 'in', 'archive'), { recursive: true });
      writeFileSync(join(root, 'in', 'b.csv'), 'id\n2\n');
      writeFileSync(join(root, 'in', 'a.csv'), 'id\n1\n');
      writeFileSync(join(root, 'in', 'notes.txt'), 'skip me');
      const fs = await seedConnection(page, {
        name: 'e2e 1600 c8a files',
        kind: 'fs',
        config: { roots: [root] },
      });
      const pipelineId = await openSeededCanvas(page, 'e2e 1600 c8a get metadata', { nodes: [] });

      await expect(
        toolbox(page).getByRole('button', { name: 'Get metadata', exact: true }),
      ).toHaveCount(1);
      await addActivity(page, 'Get metadata');
      await expect(canvasNodes(page)).toHaveCount(1);
      await canvasNodes(page).first().click();

      await tab(page, 'Settings').click();
      await expect(fieldList(page).getByRole('checkbox')).toHaveCount(8);
      // A new node ticks nothing, as ADF's does; the child settings wait.
      for (const name of ['Exists', 'Size', 'Child items']) {
        await expect(box(page, name)).not.toBeChecked();
      }
      const filter = properties(page).getByRole('textbox', { name: 'Filter', exact: true });
      await expect(filter).toHaveCount(0);

      // Measured at 1440x900: the boxes pack in columns, all in the viewport.
      const last = await box(page, 'Child items').boundingBox();
      const first = await box(page, 'Exists').boundingBox();
      expect(last, 'Child items has a box').not.toBeNull();
      expect(last!.y + last!.height).toBeLessThanOrEqual(900);
      expect(last!.y - first!.y, 'eight boxes do not stack eight deep').toBeLessThan(
        4 * first!.height + 4 * 8,
      );
      // A grid, not a wrapped line: equal columns, so the boxes in a row are
      // evenly spaced whatever their labels' lengths, and every later row
      // lines up under the first.
      const xs = await fieldList(page)
        .getByRole('checkbox')
        .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().x)));
      const ys = await fieldList(page)
        .getByRole('checkbox')
        .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().y)));
      const columns = xs.filter((_, i) => ys[i] === ys[0]);
      expect(columns.length, 'more than one column').toBeGreaterThan(1);
      const steps = columns.slice(1).map((x, i) => x - columns[i]!);
      for (const step of steps)
        expect(Math.abs(step - steps[0]!), `steps ${steps}`).toBeLessThan(2);
      for (const x of xs) expect(columns).toContain(x);

      await box(page, 'Child items').check();
      await box(page, 'Exists').check();
      await expect(filter).toBeVisible();
      await expect(
        properties(page).getByRole('combobox', { name: 'Child entries', exact: true }),
      ).toBeVisible();
      await properties(page)
        .getByRole('combobox', { name: 'Child entries', exact: true })
        .selectOption({ label: 'Files only' });
      await properties(page).getByRole('button', { name: 'Apply config', exact: true }).click();

      await tab(page, 'Source').click();
      await pickConnection(page, 'Connection', { id: fs });
      await fillSelectedNodeConfig(page, { 'File or folder path': 'in', Filter: '*.csv' });

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
      expect(latest.nodes.map((n) => n.type)).toEqual(['get_metadata']);
      // Written in the options' order, not the order they were ticked in.
      expect(latest.nodes[0]!.config).toMatchObject({
        path: 'in',
        fieldList: ['exists', 'childItems'],
        childFilter: '*.csv',
        childType: 'files',
      });

      const runId = await fireAndSettle(page, latest.id, 'e2e 1600 c8a');
      const events = (await (
        await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
      ).json()) as { type: string; payload: Record<string, unknown> }[];
      const done = events.find((e) => e.type === 'node.succeeded');
      expect(done, `events: ${JSON.stringify(events.map((e) => e.type))}`).toBeDefined();
      const outputs = done!.payload.outputs as Record<string, unknown>;
      expect(outputs).toMatchObject({
        exists: true,
        size: null,
        itemName: null,
        path: join(root, 'in'),
      });
      expect(
        (outputs.childItems as { name: string; type: string; size: number }[]).map((c) => [
          c.name,
          c.type,
          c.size,
        ]),
      ).toEqual([
        ['a.csv', 'file', 5],
        ['b.csv', 'file', 5],
      ]);

      // Back in the editor the boxes read what was saved.
      await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
      await canvasNodes(page).first().click();
      await tab(page, 'Settings').click();
      await expect(box(page, 'Exists')).toBeChecked();
      await expect(box(page, 'Child items')).toBeChecked();
      await expect(box(page, 'Size')).not.toBeChecked();
      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * #1600 C8b — catalogue §8. A stored List directory keeps running as it was.
   * Opened in the editor it IS Get metadata with Child items ticked, and every
   * read of its `entries` (a Filter's items, a ForEach's items) reads
   * `childItems`. Save writes all of that, and the saved version keeps the
   * Filter's answer.
   */
  test('a stored List directory runs as before, opens as Get metadata, and saves as one', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1600-c8b-')));
    try {
      mkdirSync(join(root, 'in', 'archive'), { recursive: true });
      writeFileSync(join(root, 'in', 'b.csv'), 'id\n2\n');
      writeFileSync(join(root, 'in', 'a.csv'), 'id\n1\n');
      const store = await seedConnection(page, {
        name: 'e2e 1600 c8b store',
        kind: 'fs',
        config: { roots: [root] },
      });
      const { pipelineId, pipelineVersionId } = await seedVersion(page, 'e2e 1600 c8b legacy', {
        nodes: [
          {
            id: 'list',
            type: 'file_list',
            position: { x: 0, y: 0 },
            connectionId: store,
            config: { path: 'in' },
          },
          {
            id: 'files',
            type: 'filter',
            position: { x: 260, y: 0 },
            config: {
              items: '${nodes.list.output.entries}',
              predicate: "${equals(item.type, 'file')}",
            },
          },
          { id: 'w', type: 'wait', position: { x: 540, y: 0 }, config: { seconds: '${1}' } },
        ],
        edges: [
          { id: 'e1', from: 'list', to: 'files', on: 'success' },
          { id: 'e2', from: 'list', to: 'each', on: 'success' },
        ],
        containers: [
          { id: 'each', kind: 'foreach', children: ['w'], items: '${nodes.list.output.entries}' },
        ],
      });
      const filtered = async (versionId: string, name: string) => {
        const runId = await fireAndSettle(page, versionId, name);
        const run = await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
        expect(run.status, `run: ${JSON.stringify(run)}`).toBe('success');
        const events = (await (
          await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
        ).json()) as {
          type: string;
          payload: { nodeId?: string; outputs?: { result?: unknown } };
        }[];
        const done = events.find(
          (e) => e.type === 'node.succeeded' && e.payload.nodeId === 'files',
        );
        return (done?.payload.outputs?.result as { name: string }[] | undefined)
          ?.map((f) => f.name)
          .sort();
      };
      // The stored version is untouched by the lowering: it runs as file_list.
      expect(await filtered(pipelineVersionId, 'e2e 1600 c8b old')).toEqual(['a.csv', 'b.csv']);

      await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
      // Three activities and the ForEach box.
      await expect(canvasNodes(page)).toHaveCount(4);
      await canvasNodes(page).filter({ hasText: 'Get metadata' }).click();
      await tab(page, 'Settings').click();
      await expect(box(page, 'Child items')).toBeChecked();
      await expect(box(page, 'Exists')).not.toBeChecked();
      // Any edit saves the node as its replacement. (Opening it is not one: the
      // canvas is not dirty, which canvasStore.test.ts asserts.)
      await tab(page, 'General').click();
      await properties(page)
        .getByRole('textbox', { name: 'Activity description' })
        .fill('lowered from List directory');
      await page.getByRole('button', { name: 'Save version' }).click();
      await expect(page.locator('.notice')).toHaveText('Saved v2.');

      const versions = (await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json()) as {
        id: string;
        version: number;
        nodes: { id: string; type: string; config: Record<string, unknown> }[];
        containers: { id: string; items?: string }[];
      }[];
      const latest = versions.sort((a, b) => b.version - a.version)[0]!;
      const byId = new Map(latest.nodes.map((n) => [n.id, n]));
      expect(byId.get('list')).toMatchObject({
        type: 'get_metadata',
        config: { path: 'in', fieldList: ['childItems'] },
      });
      expect(byId.get('files')!.config.items).toBe('${nodes.list.output.childItems}');
      expect(latest.containers[0]!.items).toBe('${nodes.list.output.childItems}');

      expect(await filtered(latest.id, 'e2e 1600 c8b new')).toEqual(['a.csv', 'b.csv']);
      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  /**
   * #1600 C8e — Include subfolders. Drawn only once Child items is ticked,
   * off for a new node, saved as `recursive`, and the run names each nested
   * item by its path below the folder, in tree order.
   */
  test('Include subfolders lists the whole tree, each item by its path', async ({ page }) => {
    const problems = collectPageProblems(page);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1600-c8e-')));
    try {
      mkdirSync(join(root, 'in', '2026', '10'), { recursive: true });
      writeFileSync(join(root, 'in', 'a.csv'), 'id\n1\n');
      writeFileSync(join(root, 'in', '2026', 'b.csv'), 'id\n2\n');
      writeFileSync(join(root, 'in', '2026', '10', 'c.csv'), 'id\n3\n');
      writeFileSync(join(root, 'in', '2026', 'skip.txt'), 'no');
      const fs = await seedConnection(page, {
        name: 'e2e 1600 c8e files',
        kind: 'fs',
        config: { roots: [root] },
      });
      const pipelineId = await openSeededCanvas(page, 'e2e 1600 c8e subfolders', { nodes: [] });
      await addActivity(page, 'Get metadata');
      await canvasNodes(page).first().click();
      await tab(page, 'Settings').click();

      const subfolders = properties(page).getByRole('checkbox', {
        name: 'Include subfolders',
        exact: true,
      });
      await expect(subfolders).toHaveCount(0);
      await box(page, 'Child items').check();
      await expect(subfolders).toBeVisible();
      await expect(subfolders).not.toBeChecked();
      await subfolders.check();
      await properties(page)
        .getByRole('combobox', { name: 'Child entries', exact: true })
        .selectOption({ label: 'Files only' });
      // Measured at 1440x900: the whole Settings tab fits, the new box included.
      const last = await properties(page)
        .getByRole('textbox', { name: 'Modified before', exact: true })
        .boundingBox();
      expect(last, 'Modified before is drawn').not.toBeNull();
      expect(last!.y + last!.height).toBeLessThanOrEqual(900);
      await properties(page).getByRole('button', { name: 'Apply config', exact: true }).click();

      await tab(page, 'Source').click();
      await pickConnection(page, 'Connection', { id: fs });
      await fillSelectedNodeConfig(page, { 'File or folder path': 'in', Filter: '*.csv' });
      await page.getByRole('button', { name: 'Save version' }).click();
      await expect(page.locator('.notice')).toHaveText('Saved v2.');

      const versions = (await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json()) as { id: string; version: number; nodes: { config: Record<string, unknown> }[] }[];
      const latest = versions.sort((a, b) => b.version - a.version)[0]!;
      expect(latest.nodes[0]!.config).toMatchObject({
        fieldList: ['childItems'],
        childFilter: '*.csv',
        childType: 'files',
        recursive: true,
      });

      const runId = await fireAndSettle(page, latest.id, 'e2e 1600 c8e');
      const events = (await (
        await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
      ).json()) as { type: string; payload: Record<string, unknown> }[];
      const done = events.find((e) => e.type === 'node.succeeded');
      expect(done, `events: ${JSON.stringify(events.map((e) => e.type))}`).toBeDefined();
      const items = (done!.payload.outputs as { childItems: { name: string }[] }).childItems;
      expect(items.map((c) => c.name)).toEqual(['2026/10/c.csv', '2026/b.csv', 'a.csv']);

      // Back in the editor the box reads what was saved.
      await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
      await canvasNodes(page).first().click();
      await tab(page, 'Settings').click();
      await expect(subfolders).toBeChecked();
      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
