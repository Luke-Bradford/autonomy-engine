import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { canvasNodes } from './support/canvasGraph';
import { nodeById, openSeededCanvas, rectOf } from './support/seedDoc';
import { setTheme } from './support/theme';
import { properties } from './support/panels';

/**
 * #1477 OR29 — the property dock EXPANDED into a full-height drawer over the
 * canvas, for long forms, and Escape back. What is load-bearing, each measured:
 * - the drawer is the full height of the editor's column, on its right, OVER
 *   the canvas (the topmost element there is the dock), leaving a strip of
 *   canvas on the left;
 * - it is the SAME panel element throughout, so an unapplied edit survives
 *   both ways (a remount would drop the draft);
 * - Escape closes an open picker list first, and only then the drawer;
 * - in both dock positions, and painted on an opaque surface in dark mode.
 */

const seed = {
  nodes: [
    { id: 'l', type: 'llm_call', position: { x: 0, y: 0 }, config: { prompt: 'Hello' } },
    {
      id: 'h',
      type: 'http_request',
      position: { x: 320, y: 0 },
      config: { url: 'https://a.example.test' },
    },
  ],
};

const tabs = (page: Page) => properties(page).getByRole('tablist', { name: 'Activity properties' });

async function boxes(page: Page) {
  const [dock, wrap, column] = await Promise.all([
    rectOf(page, '.property-dock'),
    rectOf(page, '.canvas-wrap'),
    rectOf(page, '.canvas-main'),
  ]);
  return { dock, wrap, column };
}

/** Remember the panel element, to prove later that it was never remounted. */
async function markPanel(page: Page) {
  await page.locator('.property-panel').evaluate((el) => {
    (window as unknown as { dockPanel: Element }).dockPanel = el;
  });
}

function samePanel(page: Page) {
  return page
    .locator('.property-panel')
    .evaluate((el) => el === (window as unknown as { dockPanel: Element }).dockPanel);
}

/** The topmost element at the drawer's centre, and whether it is in the dock. */
function dockOnTop(page: Page) {
  return page.locator('.property-dock').evaluate((dock) => {
    const r = dock.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== null && dock.contains(hit);
  });
}

async function expectExpanded(page: Page) {
  await expect
    .poll(async () => {
      const { dock, column } = await boxes(page);
      return Math.round(column.bottom - dock.bottom) === 0 && Math.round(dock.top - column.top);
    })
    .toBe(0);
  const { dock, wrap, column } = await boxes(page);
  // Full height of the column, flush with its right edge, over the canvas…
  expect(Math.abs(dock.right - column.right)).toBeLessThanOrEqual(1);
  expect(dock.width).toBeGreaterThanOrEqual(600);
  expect(dock.left).toBeLessThan(wrap.right - 600);
  // …which now has the column to itself underneath, with a strip left showing.
  expect(Math.round(wrap.height)).toBe(Math.round(column.height));
  expect(dock.left - column.left).toBeGreaterThanOrEqual(100);
  expect(await dockOnTop(page)).toBe(true);
  // The divider is not drawn over the drawer.
  await expect(page.locator('.dock-splitter')).toBeHidden();
}

test.describe('#1477 OR29 — Expand properties', () => {
  test('expands the same panel over the canvas, keeps an unapplied edit, and Escape docks it', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSeededCanvas(page, `e2e 1477 expand ${String(Date.now())}`, seed);
    await nodeById(page, 'l').click();
    await tabs(page).getByRole('tab', { name: 'Prompt' }).click();

    const docked = await boxes(page);
    expect(docked.dock.top).toBeGreaterThanOrEqual(docked.wrap.bottom);

    // An edit that is NOT applied: only the panel's own draft holds it.
    const prompt = properties(page).getByRole('textbox', { name: /^Prompt/ });
    await prompt.fill('Hello, a long prompt that wants room');
    const apply = properties(page).getByRole('button', { name: 'Apply config' });
    await expect(apply).toBeEnabled();
    await markPanel(page);

    await page.getByRole('button', { name: 'Expand properties' }).click();
    await expectExpanded(page);
    // Moving the dock means nothing while it is expanded, so it is not offered.
    await expect(page.getByRole('button', { name: /^Dock to / })).toHaveCount(0);
    expect(await samePanel(page)).toBe(true);
    await expect(prompt).toHaveValue('Hello, a long prompt that wants room');
    await expect(apply).toBeEnabled();
    // The canvas draft is untouched: still the two seeded activities.
    await expect(canvasNodes(page)).toHaveCount(2);

    // Escape from the field docks it again, with the draft still there.
    await prompt.press('Escape');
    await expect
      .poll(async () => {
        const { dock, wrap } = await boxes(page);
        return dock.top >= wrap.bottom;
      })
      .toBe(true);
    const back = await boxes(page);
    expect(Math.round(back.dock.height)).toBe(Math.round(docked.dock.height));
    expect(await samePanel(page)).toBe(true);
    await expect(prompt).toHaveValue('Hello, a long prompt that wants room');
    await expect(prompt).toBeFocused();
    await expect(page.getByRole('button', { name: 'Expand properties' })).toBeVisible();
    await expectQuiet(page, problems);
  });

  test('Escape closes an open picker list before the drawer', async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSeededCanvas(page, `e2e 1477 expand picker ${String(Date.now())}`, seed);
    await nodeById(page, 'l').click();
    await tabs(page).getByRole('tab', { name: 'Model' }).click();
    await page.getByRole('button', { name: 'Expand properties' }).click();
    await expectExpanded(page);

    const picker = properties(page).getByRole('combobox', { name: /connection/i });
    await picker.click();
    await expect(page.getByRole('listbox')).toBeVisible();
    await picker.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    // Still expanded: that Escape was the list's.
    await expectExpanded(page);
    await picker.press('Escape');
    await expect(page.getByRole('button', { name: 'Expand properties' })).toBeVisible();
    await expectQuiet(page, problems);
  });

  test('expands from the right-hand dock, and folding the dock ends it', async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSeededCanvas(page, `e2e 1477 expand right ${String(Date.now())}`, seed);
    await nodeById(page, 'h').click();
    await page.getByRole('button', { name: 'Dock to right' }).click();
    await setTheme(page, 'dark');

    await page.getByRole('button', { name: 'Expand properties' }).click();
    // Wider than the right-hand dock's own cap: the expanded rules win there.
    await expectExpanded(page);
    // Selecting another activity in the strip of canvas shows it in the drawer.
    await nodeById(page, 'l').click({ position: { x: 8, y: 8 } });
    await expect(tabs(page).getByRole('tab', { name: 'Model' })).toBeVisible();
    await expectExpanded(page);

    // On an opaque panel, not see-through over the canvas, in dark mode too.
    const surface = await page.locator('.property-dock').evaluate((el) => {
      const panel = getComputedStyle(document.documentElement).getPropertyValue('--panel').trim();
      const probe = document.createElement('div');
      probe.style.backgroundColor = panel;
      document.body.append(probe);
      const expected = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { background: getComputedStyle(el).backgroundColor, expected };
    });
    expect(surface.background).toBe(surface.expected);
    expect(surface.background).not.toBe('rgba(0, 0, 0, 0)');

    // Folding ends the mode: unfolded, it is the right-hand dock again.
    await page.getByRole('button', { name: 'Hide properties' }).click();
    await page.getByRole('button', { name: /^Show properties/ }).click();
    await expect(page.getByRole('button', { name: 'Expand properties' })).toBeVisible();
    const right = await boxes(page);
    expect(right.dock.left).toBeGreaterThanOrEqual(right.wrap.right);
    await expectQuiet(page, problems);
  });
});
