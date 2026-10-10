import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { openSeededCanvas, rectOf, type SeedDoc } from './support/seedDoc';

/**
 * #1475 OR27 slice 3 — the Activities toolbox is the operator's to size and to
 * fold. Before this it was a fixed 180px column with no hide, collapse or
 * resize (measured on `202f288d`).
 *
 * Folding gives the canvas the toolbox's width but keeps an icon RAIL, so
 * activities stay addable (U5). Boxes, not computed styles, and every
 * persistence claim is checked across a real reload.
 */

const seed: SeedDoc = {
  nodes: [
    {
      id: 'a',
      type: 'http_request',
      position: { x: 0, y: 0 },
      config: { url: 'https://a.example.test' },
    },
  ],
};

/** Not the nav pane's separator or the dock's, which are on this page too. */
function divider(page: Page) {
  return page.getByRole('separator', { name: 'Resize activities' });
}

function toolbox(page: Page) {
  return page.getByRole('region', { name: 'Activities', exact: true });
}

async function widths(page: Page) {
  const [box, flow] = await Promise.all([
    rectOf(page, '.activity-toolbox'),
    rectOf(page, '.react-flow'),
  ]);
  return { toolbox: Math.round(box.width), flow: Math.round(flow.width), flowLeft: flow.left };
}

test('#1475 dragging the toolbox divider widens it, the canvas gives up the same, and it stays after a reload', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededCanvas(page, `e2e 1475 toolbox drag ${Date.now()}`, seed);
  const before = await widths(page);
  expect(before.toolbox).toBe(180);

  const box = (await divider(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 30, y, { steps: 4 });
  await page.mouse.move(x + 60, y, { steps: 4 });
  await page.mouse.up();

  await expect.poll(async () => (await widths(page)).toolbox).toBe(240);
  const after = await widths(page);
  expect(before.flow - after.flow).toBe(60);
  await expect(divider(page)).toHaveAttribute('aria-valuenow', '240');

  await page.reload();
  await expect(page.locator('.react-flow')).toBeVisible();
  await expect.poll(async () => (await widths(page)).toolbox).toBe(240);
  await expect(divider(page)).toHaveAttribute('aria-valuenow', '240');
  await expectQuiet(page, problems);
});

test('#1475 the toolbox divider steps from the keyboard between its bounds, and the step survives a reload', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededCanvas(page, `e2e 1475 toolbox keys ${Date.now()}`, seed);

  await divider(page).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await widths(page)).toolbox).toBe(196);
  await page.reload();
  await expect.poll(async () => (await widths(page)).toolbox).toBe(196);

  await divider(page).focus();
  await page.keyboard.press('End');
  await expect.poll(async () => (await widths(page)).toolbox).toBe(360);
  await expect(divider(page)).toHaveAttribute('aria-valuemax', '360');
  await page.keyboard.press('Home');
  await expect.poll(async () => (await widths(page)).toolbox).toBe(140);
  await expect(divider(page)).toHaveAttribute('aria-valuemin', '140');
  await expectQuiet(page, problems);
});

test('#1475 a folded toolbox gives the canvas its width, keeps a rail that still adds activities, and stays folded after a reload', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await openSeededCanvas(page, `e2e 1475 toolbox rail ${Date.now()}`, seed);
  const open = await widths(page);

  await toolbox(page).getByRole('button', { name: 'Collapse activities' }).click();
  await expect.poll(async () => (await widths(page)).toolbox).toBe(48);
  const folded = await widths(page);
  // Everything the toolbox gave up went to the canvas.
  expect(folded.flow - open.flow).toBe(open.toolbox - 48);
  expect(folded.flowLeft).toBeLessThan(open.flowLeft);
  await expect(divider(page)).toHaveCount(0);
  await expect(toolbox(page).getByRole('searchbox')).toHaveCount(0);

  // The rail never scrolls sideways: every glyph button fits the 48px track.
  const overflow = await page
    .locator('.activity-toolbox')
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  await page.reload();
  await expect(page.locator('.react-flow')).toBeVisible();
  await expect.poll(async () => (await widths(page)).toolbox).toBe(48);
  const expand = toolbox(page).getByRole('button', { name: 'Expand activities' });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');

  // Still an authoring surface: a rail click adds the activity. (After the
  // reload, so the reload has no unsaved edit to ask about.)
  const nodes = page.locator('.react-flow__node');
  await expect(nodes).toHaveCount(1);
  await toolbox(page).getByRole('button', { name: 'Wait', exact: true }).click();
  await expect(nodes).toHaveCount(2);

  // Unfolding gives back the width it had.
  await expand.click();
  await expect.poll(async () => (await widths(page)).toolbox).toBe(open.toolbox);
  await expect(divider(page)).toBeVisible();
  await expectQuiet(page, problems);
});
