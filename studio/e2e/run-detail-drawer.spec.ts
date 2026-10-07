import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion } from './support/seedDoc';
import { seedConnection } from './support/seedResources';
import { fluentRootReady } from './support/theme';
import { openRunView } from './support/panels';

/**
 * #1484 OR35 M2 — the run page's detail drawer. A two-item ForEach lists a
 * different folder per item, so each item's activity run has its own input.
 * Opening a row shows THAT item's record, beside the table rather than pushing
 * it down, and the drawer is resizable and closes on Escape.
 *
 * `file_list` over a local `fs` connection: it is dispatched, so it records the
 * input it ran with, and it needs no network.
 */
test('#1484 M2 — an activity run opens in a drawer, with its own item’s input', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-1484-drawer-')));
  try {
    const dirA = join(root, 'folder-a');
    const dirB = join(root, 'folder-b');
    mkdirSync(dirA);
    mkdirSync(dirB);
    const connectionId = await seedConnection(page, {
      name: '#1484 drawer files',
      kind: 'fs',
      config: { roots: [root] },
    });
    const { pipelineVersionId } = await seedVersion(page, 'M2 drawer', {
      nodes: [
        {
          id: 'ls',
          type: 'file_list',
          connectionId,
          config: { path: '${item}' },
          position: { x: 0, y: 0 },
        },
      ],
      containers: [
        {
          id: 'each',
          kind: 'foreach' as const,
          children: ['ls'],
          items: `\${createArray('${dirA}', '${dirB}')}`,
        },
      ],
    });
    const runId = await fireAndSettle(page, pipelineVersionId);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
    await fluentRootReady(page);
    const opens = page.locator('.activity-runs__table .activity-runs__open');
    await expect(opens).toHaveCount(2);
    const tableBox = await page.locator('.activity-runs__table').boundingBox();

    await opens.nth(1).click();
    const drawer = page.locator('#run-detail-drawer');
    const panel = drawer.getByRole('complementary');
    await expect(panel).toBeVisible();
    await expect(panel).toBeFocused();

    // Every reading in one evaluate: a round trip per assertion is what costs.
    const second = await page.evaluate(() => {
      const d = document.getElementById('run-detail-drawer')!;
      const style = getComputedStyle(d);
      const box = d.getBoundingClientRect();
      const t = document.querySelector('.activity-runs__table')!.getBoundingClientRect();
      return {
        text: d.textContent ?? '',
        position: style.position,
        right: Math.round(window.innerWidth - box.right),
        width: Math.round(box.width),
        tableTop: t.top,
        tableHeight: t.height,
        openRows: document.querySelectorAll('.activity-runs__table tr[data-open]').length,
        splitter: d.querySelector('[role="separator"]')?.getAttribute('aria-label') ?? null,
      };
    });
    expect(second.text).toContain('Item 2 of 2');
    expect(second.text).toContain('folder-b');
    expect(second.text).not.toContain('folder-a');
    // Over the page, on its right edge, and the table did not move.
    expect(second.position).toBe('fixed');
    expect(second.right).toBe(0);
    expect(second.width).toBeGreaterThanOrEqual(320);
    expect(second.tableTop).toBe(tableBox!.y);
    expect(second.tableHeight).toBe(tableBox!.height);
    expect(second.openRows).toBe(1);
    expect(second.splitter).toBe('Resize activity details');

    // Another row swaps the record in place.
    await opens.nth(0).click();
    await expect(panel).toContainText('Item 1 of 2');
    await expect(panel).toContainText('folder-a');
    await expect(panel).not.toContainText('folder-b');

    // The width is the operator's: the keyboard resizes it, and it is remembered.
    const splitter = drawer.getByRole('separator', { name: 'Resize activity details' });
    await splitter.focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect
      .poll(async () => Math.round((await drawer.boundingBox())!.width))
      .toBe(second.width + 32);

    // Escape closes it and puts focus back on the row that opened it.
    await panel.focus();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(opens.nth(0)).toBeFocused();

    // Remembered: after a reload the drawer opens at the width it was left at.
    await page.reload();
    await fluentRootReady(page);
    await opens.nth(0).click();
    await expect
      .poll(async () => Math.round((await drawer.boundingBox())!.width))
      .toBe(second.width + 32);

    /* The graph opens the same drawer. The node is one box for both items, so
       it opens its last run (neither failed): item 2. That row is the open one
       and the node is marked, and opening from the graph leaves the page where
       the operator is, rather than scrolling up to the table. */
    await drawer.getByRole('complementary').focus();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await openRunView(page, 'Graph');
    const nodeOpen = page.locator('.run-canvas .run-node-open');
    await expect(nodeOpen).toHaveCount(1);
    await nodeOpen.scrollIntoViewIfNeeded();
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await nodeOpen.click();
    await expect(panel).toBeFocused();
    await expect(panel).toContainText('Item 2 of 2');
    await expect(panel).toContainText('folder-b');
    await expect(opens.nth(1)).toHaveAttribute('aria-expanded', 'true');
    const fromGraph = await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>('.run-canvas .run-node-open')!;
      const card = button.closest<HTMLElement>('.run-node')!;
      return {
        scrollY: window.scrollY,
        openRows: document.querySelectorAll('.activity-runs__table tr[data-open]').length,
        selected: card.classList.contains('run-node--selected'),
        label: button.getAttribute('aria-label'),
        /* Over the whole card inside its border, adding nothing to it. Layout
           sizes, which the canvas zoom does not scale. */
        cover: [button.offsetWidth, button.offsetHeight, card.clientWidth, card.clientHeight],
      };
    });
    expect(fromGraph.scrollY).toBe(scrollBefore);
    expect(fromGraph.openRows).toBe(1);
    expect(fromGraph.selected).toBe(true);
    // The node's own name, status and selection, as the node itself says them.
    expect(fromGraph.label).toMatch(/^Open activity run: .+, success, selected$/);
    const [bw, bh, cw, ch] = fromGraph.cover;
    expect([bw, bh]).toEqual([cw, ch]);
    expect(cw).toBeGreaterThan(0);
    // Escape hands focus back to the node that opened it.
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(nodeOpen).toBeFocused();

    await expectQuiet(page, problems);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
