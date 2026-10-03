import { expect, test, type Page } from '@playwright/test';
import { editorMenuItem } from './support/canvas';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { openSeededCanvas, rectOf, type SeedDoc } from './support/seedDoc';
import { properties } from './support/panels';

/**
 * #1475 OR27 — the property dock can sit BESIDE the canvas instead of under
 * it: a per-viewer preference (CONFIG OVER DECISIONS), bottom by default.
 *
 * Boxes, not computed styles (`canvas-fills-viewport.spec.ts` records why), and
 * every persistence claim is checked across a real reload.
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

function divider(page: Page) {
  return page.getByRole('separator', { name: 'Resize properties' });
}

async function boxes(page: Page) {
  const [dock, wrap, column] = await Promise.all([
    rectOf(page, '.property-dock'),
    rectOf(page, '.canvas-wrap'),
    rectOf(page, '.canvas-main'),
  ]);
  return { dock, wrap, column };
}

test('#1475 the dock moves beside the canvas, keeps its tree, and stays there after a reload', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededCanvas(page, `e2e 1475 dock right ${Date.now()}`, seed);
  const bottom = await boxes(page);
  expect(bottom.dock.top).toBeGreaterThan(bottom.wrap.bottom - 1);

  // The SAME element before and after: the dock holds unapplied drafts, so the
  // move must be a layout change, never a remount.
  await page.locator('.property-panel').evaluate((el) => {
    (window as unknown as { dockPanel: Element }).dockPanel = el;
  });
  await page.getByRole('button', { name: 'Dock to right' }).click();

  await expect
    .poll(async () => (await boxes(page)).dock.left)
    .toBeGreaterThan(bottom.wrap.left + 200);
  const right = await boxes(page);
  // Beside the canvas, on its right, the full height of the column.
  expect(right.dock.left).toBeGreaterThanOrEqual(right.wrap.right);
  expect(Math.round(right.dock.top)).toBe(Math.round(right.wrap.top));
  expect(Math.round(right.dock.height)).toBe(Math.round(right.column.height));
  expect(right.wrap.height).toBeGreaterThan(bottom.wrap.height + 150);
  expect(right.dock.width).toBeGreaterThanOrEqual(320);
  expect(
    await page
      .locator('.property-panel')
      .evaluate((el) => el === (window as unknown as { dockPanel: Element }).dockPanel),
  ).toBe(true);
  // Problems is stacked under the properties, not beside them.
  const panel = await rectOf(page, '.property-panel');
  const list = await rectOf(page, '.problems-panel');
  expect(list.top).toBeGreaterThanOrEqual(panel.bottom);
  await expect(page.getByRole('separator', { name: 'Resize Problems' })).toHaveCount(0);

  await page.reload();
  await expect(properties(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dock to bottom' })).toBeVisible();
  const reloaded = await boxes(page);
  expect(reloaded.dock.left).toBeGreaterThanOrEqual(reloaded.wrap.right);

  // And back: under the canvas, at the height it had there.
  await page.getByRole('button', { name: 'Dock to bottom' }).click();
  await expect
    .poll(async () => Math.round((await boxes(page)).dock.height))
    .toBe(Math.round(bottom.dock.height));
  expect((await boxes(page)).dock.top).toBeGreaterThan((await boxes(page)).wrap.bottom - 1);
  await expectQuiet(page, problems);
});

test('#1475 the right-hand divider drags, steps, caps and maximises, and leaves the bottom height alone', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededCanvas(page, `e2e 1475 dock right size ${Date.now()}`, seed);
  const bottomHeight = Math.round((await boxes(page)).dock.height);
  await page.getByRole('button', { name: 'Dock to right' }).click();
  await expect(divider(page)).toHaveAttribute('aria-orientation', 'vertical');
  const start = Math.round((await boxes(page)).dock.width);

  // Dragging LEFT, toward the canvas, widens the dock by exactly the travel.
  const box = (await divider(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 50, y, { steps: 4 });
  await page.mouse.move(x - 100, y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await boxes(page)).dock.width)).toBe(start + 100);
  await expect(divider(page)).toHaveAttribute('aria-valuenow', String(start + 100));

  await page.reload();
  await expect.poll(async () => Math.round((await boxes(page)).dock.width)).toBe(start + 100);

  await divider(page).focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => Math.round((await boxes(page)).dock.width)).toBe(start + 84);

  // End is the cap: at most 60% of the row, and the canvas keeps 240px.
  await page.keyboard.press('End');
  await expect.poll(async () => (await boxes(page)).dock.width).toBeGreaterThan(start + 150);
  const capped = await boxes(page);
  expect(capped.dock.width).toBeLessThanOrEqual(Math.round(capped.column.width * 0.6) + 1);
  expect(capped.wrap.width).toBeGreaterThanOrEqual(240);
  await expect(divider(page)).toHaveAttribute(
    'aria-valuemax',
    String(Math.round(capped.dock.width)),
  );

  // Reached by keyboard, the cap's double-click goes back to the default
  // share; from there it maximises, and the next one restores.
  await divider(page).dblclick();
  await expect.poll(async () => Math.round((await boxes(page)).dock.width)).toBe(start);
  await divider(page).dblclick();
  await expect
    .poll(async () => Math.round((await boxes(page)).dock.width))
    .toBe(Math.round(capped.dock.width));
  await divider(page).dblclick();
  await expect.poll(async () => Math.round((await boxes(page)).dock.width)).toBe(start);

  // The height the bottom dock had is untouched by any of this.
  await page.getByRole('button', { name: 'Dock to bottom' }).click();
  await expect(divider(page)).toHaveAttribute('aria-orientation', 'horizontal');
  await expect.poll(async () => Math.round((await boxes(page)).dock.height)).toBe(bottomHeight);
  await expectQuiet(page, problems);
});

test('#1475 a folded right-hand dock gives the canvas the whole width, and a narrow screen keeps the canvas floor', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededCanvas(page, `e2e 1475 dock right fold ${Date.now()}`, seed);
  await page.getByRole('button', { name: 'Dock to right' }).click();
  const open = await boxes(page);

  await page.getByRole('button', { name: 'Hide properties' }).click();
  await expect(divider(page)).toHaveCount(0);
  const folded = await boxes(page);
  // The bar sits under the canvas, so the canvas has the row's full width.
  expect(Math.round(folded.wrap.width)).toBe(Math.round(folded.column.width));
  expect(folded.wrap.width).toBeGreaterThan(open.wrap.width + 300);
  expect(folded.dock.top).toBeGreaterThanOrEqual(folded.wrap.bottom);
  await page.getByRole('button', { name: 'Show properties' }).click();
  await expect(properties(page)).toBeVisible();

  // A narrow laptop with version history open: the canvas keeps its 240px.
  await page.setViewportSize({ width: 1280, height: 720 });
  await (await editorMenuItem(page, /^Show version history/)).click();
  await expect(page.locator('#version-history-panel')).toBeVisible();
  const narrow = await boxes(page);
  expect(narrow.wrap.width).toBeGreaterThanOrEqual(240);
  expect(narrow.dock.width).toBeGreaterThanOrEqual(320);
  expect(narrow.dock.left).toBeGreaterThanOrEqual(narrow.wrap.right);
  await expectQuiet(page, problems);
});
