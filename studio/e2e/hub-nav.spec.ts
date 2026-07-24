import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { CANVAS_TOKEN, FLUENT_PORTAL_ROOT, fluentRootReady } from './support/theme';

/**
 * U2 — the hub rail and the hash route tree.
 *
 * What only a real browser can prove here: that the rail's four links reach
 * four real, rendering hubs; that the hub-index REDIRECTS actually rewrite the
 * address bar (jsdom has no address bar, so a unit test can only inspect the
 * router's own idea of where it is); that the rail survives a hub change rather
 * than being remounted per route; and that the whole shell stays free of
 * console errors on every hub — the class of breakage that leaves a page
 * looking right while doing nothing.
 *
 * The hub list is hard-coded rather than imported from `shell/hubs.ts`, in the
 * same spirit as `support/theme.ts`'s `FLUENT_ROOT`: an e2e spec observes the
 * shipped contract from outside. If someone renames a hub or moves its path,
 * this should FAIL, not silently follow along.
 */
const HUBS = [
  { label: 'Home', path: '#/', heading: 'Home' },
  { label: 'Author', path: '#/author/pipelines', heading: 'Pipelines' },
  { label: 'Monitor', path: '#/monitor/runs', heading: 'Runs' },
  { label: 'Manage', path: '#/manage/connections', heading: 'Connections' },
] as const;

/** The rail's own links — the Home page signposts the same hubs in its body. */
function railLink(page: Page, label: string) {
  return page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: label });
}

/** The `#…` part of the current URL, i.e. the in-app route. */
function hash(page: Page): string {
  return new URL(page.url()).hash;
}

test.describe('U2 hub rail', () => {
  test('every rail link reaches its hub, and lights up when it does', async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.goto('/');
    await fluentRootReady(page);

    for (const hub of HUBS) {
      await railLink(page, hub.label).click();
      await expect(page.getByRole('heading', { name: hub.heading })).toBeVisible();
      // `expect.poll`, not a bare read: `page.url()` is updated from an
      // out-of-band navigation event, and for the three redirecting hubs the
      // address bar changes TWICE. A bare read races the second write.
      await expect
        .poll(() => hash(page), { message: `${hub.label} did not land on ${hub.path}` })
        .toBe(hub.path);

      // Active on the hub it navigated to, and on that one only — a rail that
      // marked everything (or nothing) would still pass the heading check.
      for (const other of HUBS) {
        const current = await railLink(page, other.label).getAttribute('aria-current');
        expect(current, `${other.label} aria-current while on ${hub.label}`).toBe(
          other.label === hub.label ? 'page' : null,
        );
      }
    }

    await expectQuiet(page, problems);
  });

  test.describe('hub index redirects', () => {
    for (const [entered, landed] of [
      ['#/author', '#/author/pipelines'],
      ['#/monitor', '#/monitor/runs'],
      ['#/manage', '#/manage/connections'],
    ] as const) {
      test(`${entered} redirects to ${landed} in the address bar`, async ({ page }) => {
        await page.goto(`/${entered}`);
        await fluentRootReady(page);
        await expect.poll(() => hash(page)).toBe(landed);
      });
    }
  });

  /**
   * The redirect must REPLACE, not push. If it pushed, Back from the default
   * child would return to the bare hub path and be bounced straight forward
   * again — a history trap the user cannot escape with the Back button.
   */
  test('Back escapes a hub index redirect instead of bouncing', async ({ page }) => {
    // Start on a CONCRETE route, not `/`. A bare `/` has no hash at all, so
    // "Back landed somewhere other than the hub index" could not be told apart
    // from "Back did nothing".
    await page.goto('/#/manage/connections');
    await fluentRootReady(page);
    await expect(page.getByRole('heading', { name: 'Connections' })).toBeVisible();

    await page.goto('/#/monitor');
    await expect.poll(() => hash(page)).toBe('#/monitor/runs');

    // If the redirect had PUSHED, this would land on `#/monitor` and be bounced
    // straight forward to `#/monitor/runs` again — the trap under test.
    await page.goBack();
    await expect.poll(() => hash(page)).toBe('#/manage/connections');
    await expect(page.getByRole('heading', { name: 'Connections' })).toBeVisible();
  });

  test('an unknown route lands on Home rather than a blank page', async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.goto('/#/no/such/route');
    await fluentRootReady(page);

    await expect.poll(() => hash(page)).toBe('#/');
    await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
    await expectQuiet(page, problems);
  });

  /**
   * The spec's accessibility criteria require a VISIBLE focus ring, and the
   * rail is the one place it is easy to lose: the links fill the rail's width
   * and `.hub-rail` clips its overflow, so a ring drawn outside the border box
   * is sliced off on both edges. Only a real browser computes this — jsdom
   * reports no outline at all.
   */
  test('a keyboard-focused rail link has a visible focus ring', async ({ page }) => {
    await page.goto('/');
    await fluentRootReady(page);

    const monitor = railLink(page, 'Monitor');
    await monitor.focus();

    const ring = await monitor.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { style: cs.outlineStyle, width: cs.outlineWidth, offset: cs.outlineOffset };
    });

    // Deliberately NOT `outlineStyle !== 'none'` — a mutation check showed that
    // assertion passing with the rule deleted, because Chromium's own default
    // is `outline: auto` at offset 0. That default is exactly the ring the
    // rail's `overflow: hidden` clips, so "some outline exists" proves nothing
    // here. Pin the rule we actually wrote instead.
    expect(ring.style).toBe('solid');
    expect(parseFloat(ring.width)).toBeGreaterThan(0);
    // STRICTLY negative: drawn inside the border box, where the clip cannot
    // reach it. The UA default sits at 0 and would be sliced off.
    expect(parseFloat(ring.offset)).toBeLessThan(0);
  });

  /**
   * The rail is a layout route, so it must persist across a hub change rather
   * than unmount and remount. Proved by state that only survives if the DOM
   * node does: focus the link, navigate with the keyboard, and check focus is
   * still on a rail element afterwards.
   */
  test('the rail persists across a hub change', async ({ page }) => {
    await page.goto('/');
    await fluentRootReady(page);

    const monitor = railLink(page, 'Monitor');
    await monitor.focus();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
    await expect(monitor).toBeFocused();
  });

  /**
   * The rail is where U2 moved the theme toggle, and it is the one control on
   * screen whose value the poll/tick cannot clobber but a remount could. Assert
   * the shell's own state survives a route change — a rail rebuilt per route
   * would reset it.
   */
  test('the theme toggle in the rail survives navigating between hubs', async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.goto('/');
    await fluentRootReady(page);

    const toggle = page.getByRole('switch', { name: 'Dark mode' });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();

    await railLink(page, 'Manage').click();
    await expect(page.getByRole('heading', { name: 'Connections' })).toBeVisible();

    await expect(page.getByRole('switch', { name: 'Dark mode' })).not.toBeChecked();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe('light');
    await expectQuiet(page, problems);
  });

  /**
   * The rail is pinned at 48px by the spec's shell diagram, and the workspace
   * beside it must keep the `.content` semantics `index.css` hangs off that
   * class — in particular `:has(.canvas-page)`, which removes the 900px reading
   * cap so the authoring canvas is full-bleed. jsdom computes no layout, so
   * this is only observable here.
   */
  test('the shell is a 48px rail beside the workspace', async ({ page }) => {
    await page.goto('/');
    await fluentRootReady(page);

    const railBox = await page.locator('.hub-rail').boundingBox();
    expect(railBox?.width).toBe(48);

    const shellColumns = await page.evaluate(
      () => getComputedStyle(document.querySelector('.app-shell')!).gridTemplateColumns,
    );
    expect(shellColumns.startsWith('48px ')).toBe(true);
  });

  /**
   * The rail's tooltips are the app's first PORTALLED Fluent surface, which the
   * U0 spike pinned a policy for: flyouts go to Fluent's default body portal and
   * are never reparented into the React Flow viewport. Fluent copies the
   * provider's class onto that mount node, so the design tokens — and the
   * `--xy-*` bridge keyed on the same class — resolve inside it. That is what
   * makes U6+'s canvas menus themeable, and it is invisible to jsdom.
   */
  test('portalled Fluent surfaces mount to body with the theme intact', async ({ page }) => {
    await page.goto('/');
    await fluentRootReady(page);

    // The HOVER is load-bearing, and the first cut of this test lacked it.
    // Fluent only force-mounts a tooltip's portal when it must anchor an
    // `aria-describedby`/`aria-labelledby` id (`useTooltipBase.js:214-228`); a
    // `relationship="label"` tooltip with STRING content — which is every
    // tooltip in the rail — renders nothing until it opens. Without the hover
    // this asserted on whichever portal happened to exist, and deleting all
    // four hub tooltips left it green.
    await railLink(page, 'Monitor').hover();
    await expect(page.getByRole('tooltip', { name: 'Monitor' })).toBeVisible();

    const portal = page.locator(FLUENT_PORTAL_ROOT);
    await expect(portal).toBeAttached();

    // Directly under <body> — NOT inside the React Flow viewport, whose
    // transform would be double-applied to anything mounted within it.
    const parentIsBody = await page.evaluate(
      (sel) => document.querySelector(sel)?.parentElement === document.body,
      FLUENT_PORTAL_ROOT,
    );
    expect(parentIsBody).toBe(true);

    const portalToken = await page.evaluate(
      ([sel, prop]) =>
        getComputedStyle(document.querySelector(sel!)!).getPropertyValue(prop!).trim(),
      [FLUENT_PORTAL_ROOT, CANVAS_TOKEN],
    );
    expect(portalToken).not.toBe('');
  });
});
