import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { computedStyleOf, contrastRatio, fluentRootReady, isOpaque } from './support/theme';

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

/**
 * ── Bug sweep 3 ──────────────────────────────────────────────────────────────
 *
 * The browser-observable half of #483 and #720. Both are invisible to vitest for
 * the usual reason (jsdom resolves no cascade and has no address bar), and #720
 * additionally needs TWO views of the same pipeline mounted at once, which is
 * only true in the real shell.
 */

/** The pipelines tree inside the Author pane. */
function authorTree(page: import('@playwright/test').Page) {
  return page
    .getByRole('navigation', { name: 'Author sections' })
    .getByRole('list', { name: 'Pipelines' });
}

test.describe('#483 held/parked node pills', () => {
  /**
   * Asserts the STYLESHEET contract, not a live run: reaching a real
   * `retry_pending` node from the browser needs a transient failure and a
   * wall-clock hold, which belongs in a server test, not here. What only a
   * browser can answer is whether the two pills the fix introduces actually
   * PAINT — a missing rule, a typo'd class, or a `--warning` token declared in
   * one theme block and not the other computes to `rgb(0, 0, 0)` (or inherits
   * the row's colour) with every unit test still green.
   */
  const PILLS = ['node-status-retrying', 'node-status-waiting'] as const;

  async function pillColours(page: import('@playwright/test').Page) {
    return page.evaluate((classes) => {
      const host = document.createElement('div');
      document.body.append(host);
      try {
        return classes.map((cls) => {
          const el = document.createElement('span');
          el.className = `node-status ${cls}`;
          host.append(el);
          const cs = getComputedStyle(el);
          return { cls, color: cs.color, background: cs.backgroundColor };
        });
      } finally {
        host.remove();
      }
    }, PILLS);
  }

  for (const theme of ['dark', 'light'] as const) {
    test(`both pills paint a legible colour in ${theme} mode`, async ({ page }) => {
      const problems = collectPageProblems(page);

      await page.goto('/#/runs');
      await fluentRootReady(page);
      await page.evaluate((t) => {
        document.documentElement.dataset['theme'] = t;
      }, theme);

      const surface = await computedStyleOf(page, 'body', 'background-color');
      expect(isOpaque(surface), `body background is not opaque in ${theme}`).toBe(true);

      for (const { cls, color } of await pillColours(page)) {
        expect(isOpaque(color), `${cls} paints a transparent colour`).toBe(true);
        // The pills are 0.72rem — small text, so WCAG AA asks 4.5:1. This is the
        // assertion that fails if a theme block forgets the light override: the
        // dark amber would then be read on the light surface, or vice versa.
        expect(
          contrastRatio(color, surface),
          `${cls} on the ${theme} surface is below AA for small text (${color} on ${surface})`,
        ).toBeGreaterThanOrEqual(4.5);
      }

      // ...and the two states are visually TELLABLE APART, which is the whole
      // point of #483: a held node must not read like a routine park.
      const [retrying, waiting] = await pillColours(page);
      expect(retrying!.color).not.toBe(waiting!.color);

      await expectQuiet(page, problems);
    });
  }
});

test.describe('#720 the open canvas follows a rename', () => {
  /**
   * Needs the real shell: the pane and the canvas are mounted SIMULTANEOUSLY
   * over the same pipeline, and the defect was that only one of them heard the
   * rename. A unit test can drive the store directly (and does), but only this
   * proves the two live views actually agree in the shipped app.
   */
  test('renaming in the tree updates the heading of the canvas already open', async ({ page }) => {
    const problems = collectPageProblems(page);

    // Deliberately free of the substring "name": the suite shares one SQLite
    // file, and a pipeline called "…rename…" is matched by any substring locator
    // a LATER spec aims at the create form. `openCanvas` was hardened for that,
    // but not seeding the trap is the cheaper half of the fix.
    const before = `sweep3-retitle-a-${Date.now()}`;
    const after = `sweep3-retitle-b-${Date.now()}`;

    await page.goto('/#/author/pipelines');
    await page.getByRole('heading', { name: 'Pipelines' }).waitFor();
    await fluentRootReady(page);

    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(before);
    await page.getByRole('button', { name: 'Create pipeline' }).click();
    await page.getByRole('link', { name: `Open ${before}` }).click();

    // The canvas is open, on its own route, showing the ORIGINAL name.
    await expect(page.locator('.react-flow')).toBeVisible();
    await expect(page.getByRole('heading', { name: before })).toBeVisible();

    const row = authorTree(page).getByRole('listitem').filter({ hasText: before }).first();
    await row.hover();
    await row.getByRole('button', { name: `More actions for ${before}` }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const field = page.getByRole('textbox', { name: 'Pipeline name' });
    await expect(field).toHaveValue(before);
    await field.fill(after);
    await page.getByRole('button', { name: 'Rename', exact: true }).click();

    // Before the fix this heading kept the OLD name until a full reload.
    await expect(page.getByRole('heading', { name: after })).toBeVisible();
    await expect(page.getByRole('heading', { name: before })).toHaveCount(0);
    // The canvas did not navigate away or remount onto a different pipeline.
    await expect(page.locator('.react-flow')).toBeVisible();

    await expectQuiet(page, problems);
  });
});
