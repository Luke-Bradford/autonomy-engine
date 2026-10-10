import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { openSeededCanvas, rectOf, type SeedDoc } from './support/seedDoc';
import { properties } from './support/panels';

/**
 * #1475 OR27 slice 2 — the property dock is the operator's to size.
 *
 * Measured on `202f288d`: with "Copy data 1" selected at 1440×900 the dock's
 * fixed `clamp(200px, 42%, 460px)` hid 1013 of 1272px of its properties, and
 * it could be folded but not resized; neither the fold nor the Problems toggle
 * survived a reload.
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

/** Not the nav pane's separator, which is on this page too. */
function divider(page: Page) {
  return page.getByRole('separator', { name: 'Resize properties' });
}

async function heights(page: Page) {
  const [dock, flow, column] = await Promise.all([
    rectOf(page, '.property-dock'),
    rectOf(page, '.react-flow'),
    rectOf(page, '.canvas-main'),
  ]);
  return { dock: Math.round(dock.height), flow: flow.height, column: column.height };
}

test('#1475 dragging the divider up makes the dock taller, and it stays after a reload', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededCanvas(page, `e2e 1475 dock drag ${Date.now()}`, seed);
  const before = await heights(page);

  const box = (await divider(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 60, { steps: 4 });
  await page.mouse.move(x, y - 120, { steps: 4 });
  await page.mouse.up();

  await expect.poll(async () => (await heights(page)).dock).toBe(before.dock + 120);
  const after = await heights(page);
  // The canvas gave up exactly what the dock took: nothing else in the column moved.
  expect(Math.round(before.flow - after.flow)).toBe(120);
  await expect(divider(page)).toHaveAttribute('aria-valuenow', String(before.dock + 120));

  await page.reload();
  await expect(page.locator('.react-flow')).toBeVisible();
  await expect.poll(async () => (await heights(page)).dock).toBe(before.dock + 120);
  await expect(divider(page)).toHaveAttribute('aria-valuenow', String(before.dock + 120));
  await expectQuiet(page, problems);
});

test('#1475 the divider steps from the keyboard, stops at its cap, and maximises on double-click', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededCanvas(page, `e2e 1475 dock keys ${Date.now()}`, seed);
  const start = (await heights(page)).dock;

  await divider(page).focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await heights(page)).dock).toBe(start + 16);

  await page.reload();
  await expect.poll(async () => (await heights(page)).dock).toBe(start + 16);

  // End is the cap: three quarters of the column at this size, and the canvas
  // keeps its floor (`canvas-fills-viewport.spec.ts`: > 200px) at any size.
  await divider(page).focus();
  await page.keyboard.press('End');
  await expect.poll(async () => (await heights(page)).dock).toBeGreaterThan(start + 100);
  const capped = await heights(page);
  expect(capped.dock).toBeLessThanOrEqual(Math.round(capped.column * 0.75) + 1);
  expect(capped.flow).toBeGreaterThan(200);
  await expect(divider(page)).toHaveAttribute('aria-valuemax', String(capped.dock));

  // Already at the cap, a double-click puts it back to the default share —
  // the operator reached the cap by keyboard, not by maximising.
  await divider(page).dblclick();
  await expect.poll(async () => (await heights(page)).dock).toBe(start);
  // From there a double-click maximises, and the next one restores.
  await divider(page).dblclick();
  await expect.poll(async () => (await heights(page)).dock).toBe(capped.dock);
  await divider(page).dblclick();
  await expect.poll(async () => (await heights(page)).dock).toBe(start);

  await expectQuiet(page, problems);
});

/**
 * The cap belongs to the column, not the stored value: a dock sized on a tall
 * window keeps its preference, but a shorter window still leaves the canvas
 * its floor. That is the CSS `max-height`, the only thing that sees a resize
 * the operator made somewhere else; the divider then reports what is drawn.
 */
test('#1475 a dock sized on a tall window still leaves the canvas its floor on a short one', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededCanvas(page, `e2e 1475 dock short ${Date.now()}`, seed);
  await divider(page).focus();
  await page.keyboard.press('End');
  const tall = await heights(page);
  expect(tall.dock).toBeGreaterThan(450);

  await page.setViewportSize({ width: 1280, height: 600 });
  await expect.poll(async () => (await heights(page)).dock).toBeLessThan(tall.dock - 100);
  const short = await heights(page);
  expect(short.flow).toBeGreaterThan(200);
  await expect(divider(page)).toHaveAttribute('aria-valuenow', String(short.dock));
  await expect(divider(page)).toHaveAttribute('aria-valuemax', String(short.dock));

  // The preference itself was kept: back on the tall window, the tall dock.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => (await heights(page)).dock).toBe(tall.dock);
  await expectQuiet(page, problems);
});

test('#1475 a folded dock and a closed Problems column stay that way after a reload', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededCanvas(page, `e2e 1475 dock fold ${Date.now()}`, seed);

  await page.getByRole('button', { name: /^Problems/ }).click();
  await expect(page.getByRole('complementary', { name: 'Problems' })).toBeHidden();
  await page.reload();
  await expect(properties(page)).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Problems' })).toBeHidden();

  const open = await heights(page);
  await page.getByRole('button', { name: 'Hide properties' }).click();
  await expect(divider(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Show properties' })).toBeVisible();
  await expect(properties(page)).toBeHidden();
  await expect(divider(page)).toHaveCount(0);
  // Folded, the canvas has the dock's height (and the divider's).
  await expect.poll(async () => (await heights(page)).flow).toBeGreaterThan(open.flow + 150);

  // Unfolded again, Problems is still the operator's choice: closed.
  await page.getByRole('button', { name: 'Show properties' }).click();
  await expect(properties(page)).toBeVisible();
  await expect(divider(page)).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Problems' })).toBeHidden();

  await expectQuiet(page, problems);
});
