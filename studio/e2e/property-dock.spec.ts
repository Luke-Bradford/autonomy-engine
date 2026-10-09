import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { deselect } from './support/canvasGraph';
import { nodeById, openSeededCanvas, rectOf } from './support/seedDoc';
import {
  computedStyleOf,
  contrastRatio,
  luminanceOf,
  setTheme,
  surfaceBehind,
} from './support/theme';
import { properties } from './support/panels';

/**
 * #852 / #844 — U7's BOTTOM property dock. The properties used to be a third,
 * 320px column beside the canvas; they now sit UNDER it, tabbed, and one dock
 * serves both an activity's form and the pipeline's params/outputs.
 *
 * What is load-bearing here, each asserted rather than eyeballed:
 * - the dock is BELOW the canvas and spans its width (the layout itself);
 * - the canvas keeps a usable height with the dock open, and gets more back
 *   when the dock is folded away;
 * - a tab choice survives selecting ANOTHER activity (the panel is keyed per
 *   node, so the choice is lifted above it);
 * - the tab strip is legible in dark mode (Fluent tokens resolve on the dock).
 */

const seed = {
  nodes: [
    {
      id: 'a',
      type: 'http_request',
      position: { x: 0, y: 0 },
      config: { url: 'https://a.example.test' },
    },
    {
      id: 'b',
      type: 'http_request',
      position: { x: 320, y: 0 },
      config: { url: 'https://b.example.test' },
    },
  ],
};

test.describe('#852 — the bottom property dock', () => {
  test('sits under the canvas and spans its width', async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSeededCanvas(page, 'dock layout', seed);

    const canvas = await rectOf(page, '.canvas-wrap');
    const dock = await rectOf(page, '.property-dock');
    // Below, not beside: the dock starts where the canvas ends (plus the gap).
    expect(dock.top).toBeGreaterThanOrEqual(canvas.bottom);
    expect(dock.top - canvas.bottom).toBeLessThanOrEqual(16);
    // The same column: left edges and widths agree.
    expect(Math.abs(dock.left - canvas.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(dock.width - canvas.width)).toBeLessThanOrEqual(1);
    // The Properties landmark is IN the dock, not a separate column.
    await expect(
      page.locator('.property-dock').getByRole('complementary', { name: 'Properties' }),
    ).toBeVisible();
    // The canvas keeps a usable height with the dock open.
    expect(canvas.height).toBeGreaterThan(300);

    await expectQuiet(page, problems);
  });

  test('folds away to give the canvas the height, and back', async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSeededCanvas(page, 'dock collapse', seed);

    const open = await rectOf(page, '.react-flow');
    const toggle = page.getByRole('button', { name: 'Hide properties' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();

    await expect(properties(page)).toBeHidden();
    const show = page.getByRole('button', { name: 'Show properties' });
    await expect(show).toHaveAttribute('aria-expanded', 'false');
    // React Flow re-measures its container: the canvas took the dock's height.
    await expect
      .poll(async () => (await rectOf(page, '.react-flow')).height)
      .toBeGreaterThan(open.height + 150);

    // A selection made while folded is answered on the toggle; the dock stays
    // folded, because a click or a drag on the canvas selects.
    await nodeById(page, 'a').click();
    await expect(show).toHaveText('Show properties (1 selected)');
    await expect(properties(page)).toBeHidden();

    await show.click();
    await expect(properties(page)).toBeVisible();
    await expect
      .poll(async () => Math.round((await rectOf(page, '.react-flow')).height))
      .toBe(Math.round(open.height));

    await expectQuiet(page, problems);
  });

  test('an activity opens on its first type tab, and a chosen tab survives selecting another', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'dock tabs', seed);

    await nodeById(page, 'a').click();
    await expect(properties(page).getByRole('heading', { name: /HTTP Request/ })).toBeVisible();
    // #1477 — an HTTP node's first type tab is Request.
    await expect(properties(page).getByRole('tab', { name: 'Request' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(properties(page).getByRole('button', { name: 'Apply config' })).toBeVisible();
    await expect(properties(page).getByRole('group', { name: 'Run policy' })).toHaveCount(0);

    await expect(
      properties(page).getByRole('textbox', { name: 'Request URL', exact: true }),
    ).toBeVisible();

    await properties(page).getByRole('tab', { name: 'General' }).click();
    await expect(properties(page).getByRole('group', { name: 'Run policy' })).toBeVisible();
    // #1477 — Apply is in the pinned header, so it is reachable from any tab.
    await expect(properties(page).getByRole('button', { name: 'Apply config' })).toBeVisible();

    // Another activity: the panel remounts (it is keyed per node) and must land
    // on the tab the operator was using, not snap back to its first type tab.
    await nodeById(page, 'b').click();
    await expect(properties(page).getByRole('tab', { name: 'General' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(properties(page).getByRole('group', { name: 'Run policy' })).toBeVisible();

    // The pipeline's own tabs: Parameters first, Outputs beside it.
    await deselect(page);
    await expect(properties(page).getByRole('tab', { name: 'Parameters' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(properties(page).getByRole('button', { name: 'Add param' })).toBeVisible();
    await properties(page).getByRole('tab', { name: 'Outputs' }).click();
    await expect(properties(page).getByRole('button', { name: 'Add output' })).toBeVisible();
    await expect(properties(page).getByRole('button', { name: 'Add param' })).toBeHidden();

    await expectQuiet(page, problems);
  });

  test('the tab strip is legible in dark mode', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'dock dark', seed);
    await setTheme(page, 'dark');
    await nodeById(page, 'a').click();

    const tab = '.property-dock [role="tab"][aria-selected="true"]';
    await expect(page.locator(tab)).toBeVisible();
    const color = await computedStyleOf(page, `${tab} .fui-Tab__content`, 'color');
    const { color: behind } = await surfaceBehind(page, tab);
    // Dark surface, light text — the strip is not white-on-white or black-on-black.
    expect(luminanceOf(behind)).toBeLessThan(0.2);
    expect(contrastRatio(color, behind)).toBeGreaterThanOrEqual(4.5);

    await expectQuiet(page, problems);
  });
});
