import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { editorMenuTrigger, openCanvas } from './support/canvas';
import { addActivity, canvasNodes, toolbox } from './support/canvasGraph';
import { nodeMenuAction, properties } from './support/panels';
import { openRowMenu } from './support/authorPane';
import {
  expectEveryHelpNoteUnobstructed,
  expectEveryPopupUnobstructed,
  expectEveryTooltipUnobstructed,
  expectOverlayUnobstructed,
  openFrom,
  openOverlay,
} from './support/occlusion';
import { answerConfirm } from './support/confirmDialog';
import { createPipelineFromList } from './support/pipelinesPage';
import { chooseRowAction } from './support/rowMenu';

/**
 * #1695 OR43 — every overlay renders on top.
 *
 * The defect: `.app-fluent-root { display: contents }` (the theme bridge) was
 * copied by Fluent onto every portal mount node at the end of `<body>`, so the
 * mount node had no box and its `z-index` never applied. Every menu, list and
 * popover then painted UNDER anything in the app with a positive `z-index`:
 * the node `⋯` menu under the dock's sticky tab strip, and wholly under the
 * Problems panel with the dock expanded.
 *
 * This is the standing gate, not a test of one menu. The triggers are found by
 * role (`aria-haspopup`, `combobox`) and the activities read off the toolbox,
 * so a new activity, tab or menu is swept the day it ships. Each overlay is
 * hit-tested at five points, held inside the viewport, and checked against
 * every clipping ancestor (`support/occlusion.ts`).
 */

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1000 },
] as const;
const DOCKS = ['docked', 'expanded'] as const;

/** Put the dock in `dock` mode; Escape on an overlay may not take it back. */
async function setDock(page: Page, dock: (typeof DOCKS)[number]): Promise<void> {
  const expand = page.getByRole('button', { name: 'Expand properties', exact: true });
  const back = page.getByRole('button', { name: 'Back to dock', exact: true });
  if (dock === 'expanded' && (await expand.isVisible())) await expand.click();
  if (dock === 'docked' && (await back.isVisible())) await back.click();
  await expect(dock === 'expanded' ? back : expand).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  for (const dock of DOCKS) {
    const layout = `${viewport.width}x${viewport.height}, ${dock}`;

    test(`the editor's overlays are unobstructed — ${layout}`, async ({ page }) => {
      test.setTimeout(240_000);
      const problems = collectPageProblems(page);
      await page.setViewportSize(viewport);
      const name = `or43 overlays ${viewport.width} ${dock}`;
      await openCanvas(page, name);

      // The canvas's own right-click menu, on the empty pane.
      const pane = await openFrom(page, () =>
        // In a corner: an empty canvas centres its starter card.
        page.locator('.react-flow__pane').click({ button: 'right', position: { x: 24, y: 24 } }),
      );
      await expectOverlayUnobstructed(pane, 'canvas context menu');
      await page.keyboard.press('Escape');

      // Every activity the toolbox offers, containers included.
      const activities = await toolbox(page).getByRole('list').getByRole('button').allInnerTexts();
      const containers = await toolbox(page)
        .getByRole('list', { name: 'Containers', exact: true })
        .getByRole('button')
        .allInnerTexts();
      expect(activities.length).toBeGreaterThan(15);
      expect(containers.length).toBeGreaterThan(1);

      let popups = 0;
      let notes = 0;
      // Activities one at a time: each is swept, then deleted from its own
      // menu, so none hides another. Containers have no `⋯` and are opened
      // with their Configure button; they stay, and are drawn as boxes.
      for (const title of activities.map((t) => t.trim())) {
        const container = containers.some((c) => c.trim() === title);
        // The expanded dock covers the canvas, so select with it docked.
        await setDock(page, 'docked');
        await addActivity(page, title);
        const panel = properties(page);
        if (container) {
          await page
            .getByRole('button', { name: new RegExp(`^Configure ${title} \\d+$`) })
            .last()
            .click();
          await expect(
            panel.getByRole('heading', { name: new RegExp(`^${title} \\d+$`) }),
          ).toBeVisible();
          await setDock(page, dock);
        } else {
          await expect(canvasNodes(page)).toHaveCount(1);
          await canvasNodes(page).first().click();
          const more = panel.getByRole('button', { name: 'More node actions', exact: true });
          await expect(more).toBeVisible();
          await setDock(page, dock);
          const menu = await openFrom(page, () => more.click());
          await expectOverlayUnobstructed(menu, `${title}: More node actions`);
          await page.keyboard.press('Escape');
          await setDock(page, dock);
        }

        const tabs = panel.getByRole('tablist').first().getByRole('tab');
        for (let t = 0; t < (await tabs.count()); t += 1) {
          await tabs.nth(t).click();
          popups += await expectEveryPopupUnobstructed(page, panel, title, () =>
            setDock(page, dock),
          );
          notes += await expectEveryHelpNoteUnobstructed(panel, title);
        }
        if (!container) {
          await nodeMenuAction(page, 'Delete node');
          await expect(canvasNodes(page)).toHaveCount(0);
        }
      }
      // The sweep reached the dock's lists and notes, not just the menus.
      expect(popups).toBeGreaterThan(0);
      expect(notes).toBeGreaterThan(0);

      // An activity's right-click menu, and its Move into ▸ submenu, which a
      // container on the canvas enables.
      await setDock(page, 'docked');
      await addActivity(page, activities[0]!.trim());
      const activity = page.locator('.react-flow__node:not(.react-flow__node-container)');
      const nodeMenu = await openFrom(page, () => activity.click({ button: 'right' }));
      await expectOverlayUnobstructed(nodeMenu, 'node context menu');
      await page.getByRole('menuitem', { name: /^Move into/ }).click();
      await expect(page.locator('.fui-MenuPopover:visible')).toHaveCount(2);
      await expectOverlayUnobstructed(openOverlay(page), 'node context menu: Move into');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await setDock(page, dock);

      // The editor's header: the page ⋯, Trigger ▾ and any other menu there.
      await expect(editorMenuTrigger(page)).toBeVisible();
      // The smallest box holding both the page ⋯ and Trigger ▾.
      const header = editorMenuTrigger(page).locator(
        'xpath=ancestor::*[.//button[normalize-space()="Trigger"]][1]',
      );
      expect(
        await expectEveryPopupUnobstructed(page, header, 'editor header', () =>
          setDock(page, dock),
        ),
      ).toBeGreaterThan(1);

      // The pipeline tree's More actions, revealed on hover.
      const treeMenu = await openFrom(page, () => openRowMenu(page, name));
      await expectOverlayUnobstructed(treeMenu, 'pipeline tree: More actions');
      await page.keyboard.press('Escape');

      await expectQuiet(page, problems);
    });
  }
}

/** The hubs' menus, lists and `?` notes: every one each page offers. */
const PAGES = [
  '/#/manage/connections',
  '/#/manage/datasets',
  '/#/manage/triggers',
  '/#/manage/secrets',
  '/#/monitor/runs',
  '/#/author/pipelines',
] as const;

for (const viewport of VIEWPORTS) {
  test(`Monitor and Manage overlays are unobstructed — ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await page.setViewportSize(viewport);
    // Rows to open menus on.
    expect((await page.request.post('/api/demo/seed')).ok()).toBe(true);
    let checked = 0;
    let notes = 0;
    for (const path of PAGES) {
      await page.goto(path);
      await page.getByRole('heading', { level: 1 }).waitFor();
      checked += await expectEveryPopupUnobstructed(page, page.locator('.content'), path);
      notes += await expectEveryHelpNoteUnobstructed(page.locator('.content'), path);
    }
    expect(checked).toBeGreaterThan(PAGES.length);
    expect(notes).toBeGreaterThan(0);

    // The Fluent tooltips: the hub rail's links, theme switch and version
    // (drawn over the page beside it), the command bar's buttons, and the
    // Author pane's New pipeline.
    const tipped = page
      .locator(
        '.hub-rail a, .hub-rail [role="switch"], .version-badge, .command-bar button[aria-label], #factory-new-pipeline',
      )
      .filter({ visible: true });
    expect(await expectEveryTooltipUnobstructed(page, tipped, 'shell')).toBeGreaterThan(5);

    // A drawer: New connection's kind gallery.
    await page.goto('/#/manage/connections');
    await page.getByRole('button', { name: 'New connection' }).click();
    const drawer = page.getByRole('dialog', { name: 'New connection' });
    await expectOverlayUnobstructed(drawer, 'New connection drawer');
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    // A dialog: the confirmation a new pipeline's Delete raises, answered
    // Cancel. New, because one with run history refuses without asking.
    await page.goto('/#/author/pipelines');
    const name = `or43 dialog ${viewport.width} ${Date.now()}`;
    await createPipelineFromList(page, name);
    await page.goto('/#/author/pipelines');
    await chooseRowAction(page.getByRole('row').filter({ hasText: name }), 'Delete');
    await expectOverlayUnobstructed(page.getByRole('alertdialog'), 'Delete confirmation');
    await answerConfirm(page, 'cancel');
    await expectQuiet(page, problems);
  });
}
