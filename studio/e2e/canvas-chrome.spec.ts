import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems } from './support/console-guard';

/**
 * The payoff half of the U0 bridge, asserted where it is actually observable:
 * React Flow MOUNTED, with its own chrome painted.
 *
 * `theme-bridge.spec.ts` proves the `--xy-*` overrides resolve to Fluent
 * tokens; this proves React Flow then CONSUMES them. Those are different
 * failures — RF renames a var between versions and the override becomes dead
 * while still resolving perfectly — so the two specs are not redundant. This is
 * the one that would have caught the shipped-but-white-in-dark bug end to end.
 *
 * Reaching a mounted canvas needs a pipeline to exist, so this spec drives the
 * real authoring flow (create -> open) rather than seeding through the API:
 * it is the same number of steps and it exercises the path a user takes.
 */

/** sRGB relative luminance of an `rgb(...)`/`rgba(...)` computed colour. */
function luminanceOf(color: string): number {
  const parts = color.match(/[\d.]+/g);
  if (!parts || parts.length < 3) throw new Error(`unparseable colour: ${color}`);
  const [r, g, b] = parts.slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function backgroundOf(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`no element matched ${sel}`);
    return getComputedStyle(el).backgroundColor;
  }, selector);
}

async function openCanvas(page: Page, name: string): Promise<void> {
  await page.goto('/#/pipelines');
  await page.getByRole('heading', { name: 'Pipelines' }).waitFor();
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create pipeline' }).click();
  await page.getByRole('button', { name: `Open ${name}` }).click();
  // The RF viewport, not just the wrapper — the chrome below is its child.
  await page.locator('.react-flow__renderer').waitFor();
}

/**
 * The surfaces React Flow PAINTS, each of which renders white without the
 * bridge because RF's own `--xy-*-default` fallbacks are light.
 *
 * `.react-flow__pane` is deliberately absent: it computes to
 * `rgba(0, 0, 0, 0)` in BOTH themes (the surface colour is painted by
 * `.react-flow` itself), so a luminance assertion on it reads 0 and would pass
 * whatever the theme did — a green assertion testing nothing.
 */
const PAINTED_SURFACES = [
  ['canvas surface', '.react-flow'],
  ['controls button', '.react-flow__controls-button'],
  ['minimap', '.react-flow__minimap'],
] as const;

test.describe('React Flow chrome follows the Fluent theme', () => {
  test('canvas chrome is DARK in the dark theme', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'e2e dark canvas');

    for (const [name, selector] of PAINTED_SURFACES) {
      const color = await backgroundOf(page, selector);
      expect(
        luminanceOf(color),
        `${name} rendered LIGHT (${color}) in the dark theme`,
      ).toBeLessThan(0.5);
    }

    expect(problems).toEqual([]);
  });

  test('canvas chrome follows the toggle into the light theme', async ({ page }) => {
    await openCanvas(page, 'e2e light canvas');
    const before = await Promise.all(PAINTED_SURFACES.map(([, sel]) => backgroundOf(page, sel)));

    await page.getByRole('switch', { name: 'Dark mode' }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe('light');

    for (const [i, [name, selector]] of PAINTED_SURFACES.entries()) {
      // Not merely "different": each surface must now be LIGHT. A bridge that
      // re-resolved to some other dark token would change the value while
      // leaving the canvas unreadable against a light page.
      await expect
        .poll(async () => luminanceOf(await backgroundOf(page, selector)), {
          message: `${name} did not become light`,
        })
        .toBeGreaterThan(0.5);
      expect(await backgroundOf(page, selector)).not.toBe(before[i]);
    }
  });
});
