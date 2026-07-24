import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';

/**
 * U3r — compatibility redirects for the MVP's pre-hub URLs.
 *
 * What only a real browser can prove: that these redirects rewrite the ADDRESS
 * BAR. The unit tests mount the route tree under `createMemoryRouter`, which
 * has no URL at all — it can show where the router thinks it is, but not that
 * a `#/runs/run_x` bookmark typed into a real browser ends up as a real,
 * shareable `#/monitor/runs/run_x`. A hash-router bug (or a stray
 * `basename`/HTML5-history change) would pass every unit test and still break
 * every old bookmark.
 *
 * The path pairs are hard-coded rather than imported from `routes.tsx`, in the
 * same spirit as this suite's other specs: an e2e test observes the shipped
 * contract from the outside. If someone moves a hub, this should FAIL rather
 * than quietly follow the new value.
 */
const LEGACY_PATHS = [
  { legacy: '#/connections', landed: '#/manage/connections', heading: 'Connections' },
  { legacy: '#/pipelines', landed: '#/author/pipelines', heading: 'Pipelines' },
  { legacy: '#/triggers', landed: '#/manage/triggers', heading: 'Triggers' },
  { legacy: '#/runs', landed: '#/monitor/runs', heading: 'Runs' },
] as const;

/** The `#…` part of the current URL, i.e. the in-app route. */
function hash(page: Page): string {
  return new URL(page.url()).hash;
}

test.describe('U3r legacy route compatibility', () => {
  for (const { legacy, landed, heading } of LEGACY_PATHS) {
    test(`${legacy} redirects to ${landed} in the address bar`, async ({ page }) => {
      const problems = collectPageProblems(page);
      await page.goto(`/${legacy}`);
      await fluentRootReady(page);

      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      expect(hash(page)).toBe(landed);

      await expectQuiet(page, problems);
    });
  }

  /**
   * The sharp case. Before U3r the catch-all sent this to Home, so the run id
   * — the entire payload of the URL someone shared — was silently dropped.
   */
  test('an old run-detail bookmark reaches that run, id intact', async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.goto('/#/runs/run_legacy_42');
    await fluentRootReady(page);

    expect(hash(page)).toBe('#/monitor/runs/run_legacy_42');
    // The page renders the id it was routed with, so this proves the id
    // survived the hop rather than merely that some run page opened.
    await expect(page.getByText('run_legacy_42').first()).toBeVisible();

    await expectQuiet(page, problems);
  });

  /**
   * A redirect that PUSHED would leave the dead legacy URL in history: Back
   * would return to it and be bounced straight forward again, stranding the
   * user. Arriving from a real previous page is the only way to see it — the
   * redirect must replace the legacy entry, so Back reaches Home.
   */
  test('Back escapes a legacy redirect instead of bouncing', async ({ page }) => {
    await page.goto('/#/');
    await fluentRootReady(page);
    await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();

    await page.goto('/#/connections');
    await expect(page.getByRole('heading', { name: 'Connections' })).toBeVisible();
    expect(hash(page)).toBe('#/manage/connections');

    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
    expect(hash(page)).toBe('#/');
  });

  /**
   * The rail's active state has ONE source (`NavLink`'s `isActive`), so a hub
   * reached BY REDIRECT must light up with no extra code. This is the check
   * that the redirect lands on a real hub route rather than something that
   * merely renders the right page.
   */
  test('a hub reached by a legacy redirect lights up in the rail', async ({ page }) => {
    await page.goto('/#/triggers');
    await fluentRootReady(page);

    const manage = page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Manage' });
    await expect(manage).toHaveAttribute('aria-current', 'page');
  });
});
