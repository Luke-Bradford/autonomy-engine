import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';

/**
 * #917 — Monitor › AI activity.
 *
 * WHY THE QUOTA HALF IS STUBBED AND THE ACTIVITY HALF IS NOT. The activity panel
 * reads the server's own SQLite, so the real endpoint is exercised end to end.
 * The quota panel reads the PROVIDER through the macOS Keychain, which means the
 * real endpoint answers `no_credential` forever on CI (Linux) and answers
 * something different, and unrepeatable, on the operator's Mac. Intercepting the
 * response is what makes BOTH renderings — a real reading and an unreadable one —
 * assertable at all; without it the most important behaviour on this page (an
 * unreadable quota never rendering as a number) could only ever be observed by
 * luck.
 */

/** A reading far enough in the future that the relative "in …" half is stable. */
const RESETS_AT_SECONDS = Math.floor(Date.UTC(2099, 0, 1) / 1000);

/**
 * #987 — the panel reads `/api/quota/display`, NOT `/api/quota`.
 *
 * Playwright matches a route glob against the path EXACTLY, so stubbing the
 * guard's endpoint here would intercept nothing and every assertion below would
 * pass or fail for reasons unrelated to what it stubbed — the UNREADABLE ones
 * vacuously, because CI's real endpoint genuinely answers `no_credential`.
 */
async function stubQuota(page: Page, body: unknown): Promise<void> {
  await page.route('**/api/quota/display', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    }),
  );
}

/**
 * Counts every request to the SPEND GUARD's endpoint. The browser has no reason
 * to call it and must not: it is the surface that carries no last-known value,
 * and the one whose consumer is `loop/drive.sh`.
 */
async function countGuardEndpointCalls(page: Page): Promise<() => number> {
  let calls = 0;
  await page.route('**/api/quota', (route) => {
    calls += 1;
    return route.continue();
  });
  return () => calls;
}

function quotaPanel(page: Page) {
  return page.getByRole('region', { name: 'Account quota' });
}

test.describe('#917 Monitor › AI activity', () => {
  test('is reachable from the Monitor hub pane', async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.goto('/');
    await fluentRootReady(page);

    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Monitor' })
      .click();
    // The section link lives in the secondary pane — the only thing that makes a
    // hub's second section reachable by clicking rather than by typing a URL.
    await page.getByRole('link', { name: 'AI activity', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'AI activity', exact: true })).toBeVisible();
    await expect.poll(() => new URL(page.url()).hash).toBe('#/monitor/ai');

    await expectQuiet(page, problems);
  });

  test('reports an empty window truthfully rather than as blank panels', async ({ page }) => {
    const problems = collectPageProblems(page);
    await stubQuota(page, {
      generated_at: Math.floor(Date.now() / 1000),
      account: { claude: null },
      unavailable: { claude: 'no_credential' },
    });
    await page.goto('/#/monitor/ai');
    await fluentRootReady(page);

    // A fresh e2e DB has no runs at all, so this is the real server's real answer.
    await expect(page.getByText('No AI or agent activity in this window.')).toBeVisible();
    await expect(page.getByText('No agent CLI subprocesses in this window.')).toBeVisible();
    await expect(page.getByText(/Runs executing/)).toBeVisible();

    await expectQuiet(page, problems);
  });

  test('renders a real quota reading with its reset instant, not just a percentage', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await stubQuota(page, {
      generated_at: Math.floor(Date.now() / 1000),
      account: {
        claude: {
          five_hour: { utilization: 0.08, resets_at: RESETS_AT_SECONDS },
          seven_day: { utilization: 0.96, resets_at: RESETS_AT_SECONDS },
        },
      },
    });
    await page.goto('/#/monitor/ai');
    await fluentRootReady(page);

    const panel = quotaPanel(page);
    // The wire carries FRACTIONS. 0.08 must read as 8%, not 0.08%.
    await expect(panel.getByRole('row', { name: /5-hour/ })).toContainText('8%');
    // …and its headroom, which is the number an operator actually acts on.
    await expect(panel.getByRole('row', { name: /5-hour/ })).toContainText('92%');
    await expect(panel.getByRole('row', { name: /7-day/ })).toContainText('96%');

    // THE RESET INSTANT — the ticket's explicit requirement. `resets_at` is epoch
    // SECONDS, so a missing ×1000 would date this to 1970; asserting the year is
    // what catches that, since either way renders a plausible-looking date.
    const fiveHour = panel.getByRole('row', { name: /5-hour/ });
    await expect(fiveHour).toContainText('2099');
    await expect(fiveHour).toContainText(/\(in .+\)/);

    // A reading is a reading: no "unreadable" wording anywhere near it.
    await expect(panel).not.toContainText('UNREADABLE');

    await expectQuiet(page, problems);
  });

  /**
   * The one that matters most. "0%" on this panel means "wide open, spend
   * freely" — the exact opposite of "I could not read it" — so an unreadable
   * quota must reach NO percentage at all.
   */
  test('renders an unreadable quota as a named reason and never as a number', async ({ page }) => {
    const problems = collectPageProblems(page);
    await stubQuota(page, {
      generated_at: Math.floor(Date.now() / 1000),
      account: { claude: null },
      unavailable: { claude: 'rate_limited' },
    });
    await page.goto('/#/monitor/ai');
    await fluentRootReady(page);

    const panel = quotaPanel(page);
    await expect(panel).toContainText('Claude quota UNREADABLE.');
    // The REASON, in the operator's terms — a contended account is not a broken
    // reader, and the panel has to be able to tell them that.
    await expect(panel).toContainText(/rate-limiting/i);

    // No percentage anywhere in the panel, and no quota table to hold one.
    await expect(panel).not.toContainText('%');
    await expect(panel.getByRole('table')).toHaveCount(0);

    await expectQuiet(page, problems);
  });

  test('does not poll the provider on a timer while the page sits open', async ({ page }) => {
    const problems = collectPageProblems(page);
    let quotaCalls = 0;
    await page.route('**/api/quota/display', (route) => {
      quotaCalls += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generated_at: Math.floor(Date.now() / 1000),
          account: { claude: null },
          unavailable: { claude: 'no_credential' },
        }),
      });
    });

    await page.goto('/#/monitor/ai');
    await fluentRootReady(page);
    await expect(quotaPanel(page)).toContainText('Claude quota UNREADABLE.');
    const afterMount = quotaCalls;

    // Long enough for several activity polls (5s) to have gone out. The quota
    // endpoint reaches the provider, and exactly one process may poll it — so
    // this must NOT rise on its own.
    await page.waitForTimeout(12_000);
    expect(quotaCalls).toBe(afterMount);

    // …but an explicit click still refreshes it, which is the whole trade.
    await quotaPanel(page).getByRole('button', { name: 'Refresh quota' }).click();
    await expect.poll(() => quotaCalls).toBe(afterMount + 1);

    await expectQuiet(page, problems);
  });

  /**
   * #987 — the panel said "Quota UNREADABLE" while the build loop's spend guard
   * had read 58% minutes earlier. The reader deliberately keeps no last-good
   * value, which is right for a gate and useless for a person; the split is in
   * the contract, and these walk both halves of it.
   */
  test.describe('#987 a last-known reading, with its age', () => {
    const LAST_KNOWN_BODY = (ageSeconds: number) => {
      const generatedAt = Math.floor(Date.now() / 1000);
      return {
        generated_at: generatedAt,
        account: { claude: null },
        unavailable: { claude: 'rate_limited' },
        last_known: {
          claude: {
            five_hour: { utilization: 0.31, resets_at: RESETS_AT_SECONDS },
            seven_day: { utilization: 0.58, resets_at: RESETS_AT_SECONDS },
          },
          read_at: generatedAt - ageSeconds,
        },
      };
    };

    test('shows the number beneath the UNREADABLE statement, aged', async ({ page }) => {
      const problems = collectPageProblems(page);
      const guardCalls = await countGuardEndpointCalls(page);
      await stubQuota(page, LAST_KNOWN_BODY(750));

      await page.goto('/#/monitor/ai');
      await fluentRootReady(page);

      const panel = quotaPanel(page);
      // BOTH facts on screen at once: it is unreadable NOW, and this is what it
      // was. Neither displaces the other.
      await expect(panel).toContainText('Claude quota UNREADABLE.');
      await expect(panel).toContainText('Last known reading');
      await expect(panel).toContainText('12m 30s ago');
      await expect(panel).toContainText('not a current figure');
      await expect(panel).toContainText('58%');
      // Past the reader's own refresh cadence, so it says so in words rather
      // than leaving the operator to judge from a duration.
      await expect(panel).toContainText('has been failing for a while');
      // The freshness claim attached to the NUMBER is the number's own age; the
      // request stamp names what it stamps.
      await expect(panel).toContainText('Last checked');
      await expect(panel).not.toContainText('Quota as of');

      // The guard's endpoint is not something a browser has any business
      // calling — this is the honest replacement for the stub that used to
      // sit on that path.
      expect(guardCalls()).toBe(0);

      await expectQuiet(page, problems);
    });

    test('still shows no number when nothing has ever been read', async ({ page }) => {
      const problems = collectPageProblems(page);
      await stubQuota(page, {
        generated_at: Math.floor(Date.now() / 1000),
        account: { claude: null },
        unavailable: { claude: 'no_credential' },
      });

      await page.goto('/#/monitor/ai');
      await fluentRootReady(page);

      const panel = quotaPanel(page);
      await expect(panel).toContainText('Claude quota UNREADABLE.');
      // No last-known block, no manufactured percentage. "Nothing has been
      // read" is a real state and stays representable.
      await expect(panel).not.toContainText('Last known reading');
      await expect(panel).not.toContainText('%');
      await expect(panel.getByRole('table')).toHaveCount(0);

      await expectQuiet(page, problems);
    });
  });
});
