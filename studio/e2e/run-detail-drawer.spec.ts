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
 * #1594 OR40 S3e — where there is room (≥1280px) the drawer is a named region
 * that PUSHES the page: nothing of the run page runs under it. Narrower, it is
 * a non-modal dialog over the page, which then does not move. Either way it is
 * held inside the viewport, under the command bar.
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

    await opens.nth(1).click();
    const drawer = page.locator('#run-detail-drawer');
    const panel = drawer.getByRole('complementary');
    await expect(panel).toBeVisible();
    await expect(panel).toBeFocused();

    // Every reading in one evaluate: a round trip per assertion is what costs.
    const second = await page.evaluate(() => {
      const d = document.getElementById('run-detail-drawer')!;
      const box = d.getBoundingClientRect();
      const parts = [...document.querySelector('.run-page')!.children].filter(
        (c) => c !== d && c.getBoundingClientRect().width > 0,
      );
      return {
        text: d.textContent ?? '',
        role: d.getAttribute('role'),
        name: d.getAttribute('aria-label'),
        position: getComputedStyle(d).position,
        width: Math.round(box.width),
        // The drawer's box against the viewport and the command bar.
        top: box.top - document.querySelector('.command-bar')!.getBoundingClientRect().bottom,
        right: window.innerWidth - box.right,
        bottom: window.innerHeight - box.bottom,
        // How far the page reaches into the drawer's column (≤ 0 is clear).
        under: Math.max(...parts.map((c) => c.getBoundingClientRect().right)) - box.left,
        gridUnder:
          document.querySelector('.activity-runs__scroll')!.getBoundingClientRect().right -
          box.left,
        // The page's scroller (`.content`) has nothing to scroll sideways.
        overflowX: ((c) => c.scrollWidth - c.clientWidth)(document.querySelector('.content')!),
        openRows: document.querySelectorAll('.activity-runs__table tr[data-open]').length,
        splitter: d.querySelector('[role="separator"]')?.getAttribute('aria-label') ?? null,
      };
    });
    expect(second.text).toContain('Item 2 of 2');
    expect(second.text).toContain('folder-b');
    expect(second.text).not.toContain('folder-a');
    // A named region, held inside the viewport under the command bar.
    expect(second.role).toBe('region');
    expect(second.name).toBe('Activity run details');
    expect(second.position).toBe('fixed');
    expect([second.top, second.right, second.bottom]).toEqual([0, 0, 0]);
    expect(second.overflowX).toBe(0);
    expect(second.width).toBeGreaterThanOrEqual(320);
    // It pushes: no part of the run page, the activity runs grid included, runs
    // under it.
    expect(second.under).toBeLessThanOrEqual(0);
    expect(second.gridUnder).toBeLessThanOrEqual(0);
    expect(second.openRows).toBe(1);
    expect(second.splitter).toBe('Resize activity run details');

    // Another row swaps the record in place.
    await opens.nth(0).click();
    await expect(panel).toContainText('Item 1 of 2');
    await expect(panel).toContainText('folder-a');
    await expect(panel).not.toContainText('folder-b');

    // The width is the operator's: the keyboard resizes it, and it is remembered.
    const splitter = drawer.getByRole('separator', { name: 'Resize activity run details' });
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

    /* Narrower than 1280px there is no room to push: the drawer is a non-modal
       dialog over the page, which stays where it was, and it is still held
       inside the viewport. Resizing the window with it open switches it. */
    await page.setViewportSize({ width: 1200, height: 900 });
    await expect(drawer).toHaveAttribute('role', 'dialog');
    const narrow = await page.evaluate(() => {
      const d = document.getElementById('run-detail-drawer')!;
      const box = d.getBoundingClientRect();
      return {
        modal: d.getAttribute('aria-modal'),
        name: d.getAttribute('aria-label'),
        right: window.innerWidth - box.right,
        bottom: window.innerHeight - box.bottom,
        overflowX: ((c) => c.scrollWidth - c.clientWidth)(document.querySelector('.content')!),
        page: document.querySelector('.run-page')!.getBoundingClientRect().right,
        content: document.querySelector('.content')!.getBoundingClientRect().right,
        padding: getComputedStyle(document.querySelector('.run-page')!).paddingRight,
      };
    });
    expect(narrow.modal).toBe('false');
    expect(narrow.name).toBe('Activity run details');
    expect([narrow.right, narrow.bottom, narrow.overflowX]).toEqual([0, 0, 0]);
    // Over the page: the run page keeps its whole width.
    expect(narrow.padding).toBe('0px');
    expect(narrow.page).toBeGreaterThan(narrow.content - 40);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(drawer).toHaveAttribute('role', 'region');

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
