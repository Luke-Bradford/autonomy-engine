import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';

/**
 * Regression net for the browser-observable half of the first bug sweep:
 * #717 (favicon), #721 (one icon-button treatment) and #698 (route-level
 * code-splitting).
 *
 * Each of these is invisible to the unit suites for the same underlying reason:
 * jsdom paints nothing, resolves no cascade, and fetches no subresources. A
 * rule that collapsed a button to zero, a chunk that never loaded, or a missing
 * static file would pass every vitest run in the repo.
 */

/** The three elements that share the `.icon-button` treatment. */
const ICON_BUTTONS = [
  '.command-bar__pane-toggle',
  '.factory-resources__icon-button',
  '.factory-resources__disclosure',
] as const;

test.describe('#717 favicon', () => {
  /**
   * The console guard CANNOT cover this, which is why it is asserted directly.
   * Playwright's browser context does not issue the implicit `/favicon.ico`
   * request a normal browsing session makes, so the 404 this ticket is about
   * never reaches `collectPageProblems` — the guard was honest about app code
   * and blind to this class of resource miss.
   */
  test('serves the declared icon, so no browser falls back to /favicon.ico', async ({
    page,
    request,
  }) => {
    await page.goto('/');

    const href = await page.locator('link[rel="icon"]').getAttribute('href');
    expect(href, 'index.html must declare an icon').toBe('/favicon.svg');

    const res = await request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image/svg+xml');
  });
});

test.describe('#721 one icon-button treatment', () => {
  test('the command bar and pane icon buttons agree on the shared treatment', async ({ page }) => {
    await page.goto('/#/author/pipelines');
    await page.getByRole('heading', { name: 'Pipelines' }).waitFor();
    await fluentRootReady(page);

    const measured = await page.evaluate(
      (selectors) => {
        return selectors.map((sel) => {
          const el = document.querySelector(sel);
          if (el === null) return { sel, missing: true };
          const cs = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          return {
            sel,
            missing: false,
            radius: cs.borderRadius,
            borderStyle: cs.borderTopStyle,
            display: cs.display,
            // A box of zero would mean the shared reset ate a call site's size —
            // the specific regression a source-order mistake would cause, since
            // every rule involved is a single class and ties break on order.
            width: Math.round(box.width),
            height: Math.round(box.height),
          };
        });
      },
      ICON_BUTTONS as unknown as string[],
    );

    for (const m of measured) {
      expect(m.missing, `${m.sel} should be present on this page`).toBe(false);
      expect(m.radius, `${m.sel} radius`).toBe('4px');
      expect(m.borderStyle, `${m.sel} border`).toBe('none');
      expect(m.display, `${m.sel} display`).toBe('flex');
      expect(m.width, `${m.sel} width`).toBeGreaterThan(0);
      expect(m.height, `${m.sel} height`).toBeGreaterThan(0);
    }
  });

  test('a keyboard-focused icon button has a visible focus ring', async ({ page }) => {
    await page.goto('/#/author/pipelines');
    await page.getByRole('heading', { name: 'Pipelines' }).waitFor();

    const toggle = page.getByRole('button', { name: /navigation pane/i });
    await toggle.focus();

    const ring = await toggle.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { width: cs.outlineWidth, style: cs.outlineStyle, offset: cs.outlineOffset };
    });
    expect(ring.style).toBe('solid');
    expect(parseFloat(ring.width)).toBeGreaterThan(0);
    // Drawn INSIDE the box: the command bar and pane clip their overflow, so a
    // ring at a positive offset is sliced off at both edges.
    expect(parseFloat(ring.offset)).toBeLessThan(0);
  });
});

test.describe('#698 route-level code-splitting', () => {
  /**
   * The canvas route is `React.lazy`, so its chunk is fetched on navigation.
   * The failure this guards against is not "slower" but "blank": a broken
   * dynamic import, or a `<Suspense>` boundary placed above the shell, leaves
   * the workspace empty with nothing thrown.
   */
  test('the lazy canvas route mounts, with the shell still painted around it', async ({ page }) => {
    const problems = collectPageProblems(page);

    await page.goto('/#/author/pipelines');
    await page.getByRole('heading', { name: 'Pipelines' }).waitFor();

    // Author a pipeline through the page so the route has a real id to open.
    const name = `sweep-canvas-${Date.now()}`;
    await page.getByRole('textbox', { name: 'Name' }).fill(name);
    await page.getByRole('button', { name: 'Create pipeline' }).click();
    await page.getByRole('link', { name: `Open ${name}` }).click();

    // The lazily-loaded canvas actually arrives.
    await expect(page.locator('.react-flow')).toBeVisible();

    // ...and the chrome outside `<main>` never suspended with it.
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByRole('button', { name: /navigation pane/i })).toBeVisible();

    await expectQuiet(page, problems);
  });
});
