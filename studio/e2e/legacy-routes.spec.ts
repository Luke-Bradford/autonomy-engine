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
      // `expect.poll`, not a bare read — the same reason `hub-nav.spec.ts`
      // gives: `page.url()` is updated from an out-of-band navigation event,
      // and a legacy path rewrites the address bar TWICE (once for the entry
      // itself, once for the redirect). A bare read races the second write.
      await expect
        .poll(() => hash(page), { message: `${legacy} did not land on ${landed}` })
        .toBe(landed);

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

    await expect
      .poll(() => hash(page), { message: 'legacy run path did not carry its id across' })
      .toBe('#/monitor/runs/run_legacy_42');
    // The page renders the id it was routed with, so this proves the id
    // survived the hop rather than merely that some run page opened.
    await expect(page.getByText('run_legacy_42').first()).toBeVisible();

    /*
     * `expectQuiet` cannot be used here, and the reason is the point of the
     * test: an id from an OLD bookmark need not still exist, and this one does
     * not — the e2e database is wiped before the suite. `RunDetailPage` fetches
     * it, the server correctly answers 404, and Chromium reports the failed
     * request as a `console.error`. That error is the truthful outcome, not a
     * defect, so asserting silence would make this test unsatisfiable (it was,
     * until the pre-PR review caught it).
     *
     * Everything else must still be quiet, though — an uncaught exception here
     * would mean the redirect landed somewhere that then broke, which is
     * exactly the failure a green routing assertion could otherwise hide.
     */
    await page.waitForTimeout(150); // the same flush `expectQuiet` performs
    const EXPECTED_404 =
      'console.error: Failed to load resource: the server responded with a status of 404 (Not Found)';
    expect(problems.filter((p) => p !== EXPECTED_404)).toEqual([]);
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
    await expect.poll(() => hash(page)).toBe('#/manage/connections');

    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
    await expect.poll(() => hash(page)).toBe('#/');
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
