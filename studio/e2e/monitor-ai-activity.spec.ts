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
 * Counts every request the page makes to `glob`, passing each one through. Two
 * different questions are asked with it: that an endpoint is NEVER called, and
 * that one stops being called — so it counts rather than merely flagging.
 */
async function countEndpointCalls(page: Page, glob: string): Promise<() => number> {
  let calls = 0;
  await page.route(glob, (route) => {
    calls += 1;
    return route.continue();
  });
  return () => calls;
}

/**
 * Counts every request to the SPEND GUARD's endpoint. The browser has no reason
 * to call it and must not: it is the surface that carries no last-known value,
 * and the one whose consumer is `loop/drive.sh`.
 */
async function countGuardEndpointCalls(page: Page): Promise<() => number> {
  return countEndpointCalls(page, '**/api/quota');
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
   * #1023 — the shape the provider actually sends for most of the day.
   *
   * There is no 5-hour window while there is no active session, and the reset
   * instant of a window with no active period comes back as a literal `null`.
   * Both used to make the entire reading UNREADABLE, which is what left the
   * spend guard's primary source on `unrecognized_payload` for 31 reads in
   * three days.
   *
   * The two failures this pins are the quiet ones. A 5-hour row rendered with a
   * blank or zeroed cell would state a figure nobody reported, and "0%" here
   * means "wide open, spend freely". A null reset coalesced to `0` renders as a
   * perfectly plausible 1970 date — which is why the year is asserted rather
   * than the mere presence of text.
   */
  test('renders a partly-reported reading: the window that came, and no fiction for the one that did not', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await stubQuota(page, {
      generated_at: Math.floor(Date.now() / 1000),
      account: { claude: { seven_day: { utilization: 0.96, resets_at: null } } },
    });
    await page.goto('/#/monitor/ai');
    await fluentRootReady(page);

    const panel = quotaPanel(page);
    // The window that WAS reported reads exactly as it would in a full reading.
    await expect(panel.getByRole('row', { name: /7-day/ })).toContainText('96%');
    // The one that was not is ABSENT — not a blank row, not a zero.
    await expect(panel.getByRole('row', { name: /5-hour/ })).toHaveCount(0);
    // An unknown reset instant is an em-dash, and never epoch 0. `1970` is the
    // canary: the sibling test above asserts `2099` for a real instant, so these
    // two together pin both directions of the seconds/ms conversion.
    const sevenDay = panel.getByRole('row', { name: /7-day/ });
    await expect(sevenDay).toContainText('—');
    await expect(sevenDay).not.toContainText('1970');
    // No relative countdown computed against an instant we do not have.
    await expect(sevenDay).not.toContainText('(in ');
    // Still a reading. The whole defect was this saying UNREADABLE.
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
   * #989 — the poller stops when you navigate AWAY.
   *
   * The tab on this page crashed once and auto-reloaded, which is an OOM or a
   * runaway allocation rather than an exception, and an orphan poller surviving
   * unmount is the shape that produces it: cost grows with how many times the
   * page has been VISITED instead of staying flat with elapsed time, so a long
   * session degrades and a short one looks fine.
   *
   * The hook's own teardown is pinned in `usePolledResource.test.ts`, and this
   * is deliberately NOT a duplicate of it. That suite unmounts with
   * `renderHook().unmount()`, which always runs React's cleanup; the question
   * only production can answer is whether the route swap unmounts the page AT
   * ALL. Hence a CLICK through the hub pane rather than a `page.goto` — a full
   * navigation would tear down the whole JS context and this would hold
   * vacuously.
   *
   * WHAT THIS PINS, EXACTLY, because the mutation testing was surprising: it
   * reds when the effect's cleanup does not run (an orphan poller then issues
   * REAL requests after the swap). It does NOT red when only `stop()` is
   * removed from that cleanup — the orphan interval still fires, but
   * `controller.abort()` has already run, so each tick's `fetch` rejects on an
   * aborted signal without touching the network and nothing is counted here.
   * That single-line case is caught by the hook suite, which counts fetcher
   * INVOCATIONS rather than network traffic. Neither level subsumes the other,
   * and this comment is here so the next reader does not assume this one covers
   * the case it cannot see.
   *
   * The test has two halves, and the second is the one the ticket asked for: the
   * freeze proves the poller STOPS, and the revisit loop proves coming back does
   * not make it cost more. A leak that survives cleanup would pass the first and
   * fail the second.
   */
  test('stops polling activity once you navigate away, and revisits cost what one visit costs', async ({
    page,
  }) => {
    // Three real 12s observation windows plus four route swaps. Well past the
    // 30s default, and the default is what this would otherwise inherit.
    test.setTimeout(150_000);

    const problems = collectPageProblems(page);
    await stubQuota(page, {
      generated_at: Math.floor(Date.now() / 1000),
      account: { claude: null },
      unavailable: { claude: 'no_credential' },
    });

    const activityCalls = await countEndpointCalls(page, '**/api/monitor/ai-activity*');
    const aiLink = page.getByRole('link', { name: 'AI activity', exact: true });
    const runsLink = page.getByRole('link', { name: 'Runs', exact: true });
    const onAiPage = async (): Promise<void> => {
      await expect(page.getByRole('heading', { name: 'AI activity', exact: true })).toBeVisible();
    };

    await page.goto('/#/monitor/ai');
    await fluentRootReady(page);
    await onAiPage();

    // Long enough for several 5s polls. Asserting the count ROSE is what keeps
    // the freeze below non-vacuous: a page that never polled at all would also
    // "stop polling", and would pass an assertion that only checked for silence.
    await page.waitForTimeout(12_000);
    const whileOpen = activityCalls();
    expect(whileOpen).toBeGreaterThan(1);

    await runsLink.click();
    await expect.poll(() => new URL(page.url()).hash).toBe('#/monitor/runs');

    // Settle before reading the baseline. A tick issued just BEFORE the swap is
    // counted when its route handler runs, which is a CDP round trip after the
    // browser issued it — so reading the count the instant the hash changes can
    // attribute a pre-swap request to the post-swap window and fail spuriously.
    // This cannot mask a real orphan: an orphan polls every 5s, so 500ms of
    // grace at most moves ONE tick into the baseline, and the 12s below still
    // catches two more.
    await page.waitForTimeout(500);

    // The count is frozen from the moment the route swapped — not merely slower.
    const atNavigation = activityCalls();
    await page.waitForTimeout(12_000);
    expect(activityCalls()).toBe(atNavigation);

    /*
     * THE ARITHMETIC THE TICKET ACTUALLY ASKS FOR: "navigate away and back a few
     * times, then count requests" — the rate must stay proportional to ELAPSED
     * TIME, not to visit count. The freeze above cannot show this. A cleanup
     * that ran but left something behind (a listener that re-registers, a timer
     * the next mount does not replace) would still freeze while the page is
     * unmounted and then poll at 2x, 3x, 4x once you come back, which is
     * precisely the profile of a tab that dies only after a long session.
     *
     * Three round trips take the mount count to FOUR (each `aiLink` click is a
     * fresh mount), and the click after the loop makes the measured one the
     * FIFTH. Counting matters here only because the numbers are the claim, so
     * they are spelled out rather than left to the reader.
     *
     * The window is then the same 12s as the first visit. Comparing
     * window-to-window rather than to a hardcoded number keeps this honest on a
     * slow runner, where every window shifts together.
     */
    for (let revisit = 0; revisit < 3; revisit += 1) {
      await aiLink.click();
      await expect.poll(() => new URL(page.url()).hash).toBe('#/monitor/ai');
      await onAiPage();
      await runsLink.click();
      await expect.poll(() => new URL(page.url()).hash).toBe('#/monitor/runs');
    }

    await aiLink.click();
    await expect.poll(() => new URL(page.url()).hash).toBe('#/monitor/ai');
    await onAiPage();

    const beforeFinalWindow = activityCalls();
    await page.waitForTimeout(12_000);
    const fifthVisitCost = activityCalls() - beforeFinalWindow;

    // `whileOpen` counted the same 12s window on visit one, including its
    // load-on-mount. The fifth visit gets ONE tick of slack for where the window
    // happens to fall against the interval — not five times the traffic.
    expect(fifthVisitCost).toBeGreaterThan(1);
    expect(fifthVisitCost).toBeLessThanOrEqual(whileOpen + 1);

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

  /**
   * #990 — codex on the panel, through the real render path.
   *
   * The unit tests pin the derivation; these pin that a body carrying a second
   * provider actually reaches the DOM, that an absent one leaves no trace, and
   * that an unreadable one still puts no number on screen.
   */
  test.describe('codex quota (#990)', () => {
    const CLAUDE = {
      five_hour: { utilization: 0.08, resets_at: RESETS_AT_SECONDS },
      seven_day: { utilization: 0.07, resets_at: RESETS_AT_SECONDS },
    };

    test('renders codex beside claude, with its reset instant and its scrape age', async ({
      page,
    }) => {
      const problems = collectPageProblems(page);
      const generatedAt = Math.floor(Date.now() / 1000);
      await stubQuota(page, {
        generated_at: generatedAt,
        account: {
          claude: CLAUDE,
          codex: {
            seven_day: { utilization: 0.64, resets_at: RESETS_AT_SECONDS },
            read_at: generatedAt - 750,
          },
        },
      });

      await page.goto('/#/monitor/ai');
      const panel = quotaPanel(page);

      await expect(panel).toContainText('Codex');
      await expect(panel).toContainText('64%');
      // Both providers, not one displacing the other.
      await expect(panel).toContainText('Claude');
      await expect(panel).toContainText('7%');
      // The reset INSTANT, which is the thing a bare percentage cannot say.
      await expect(panel).toContainText('2099');
      // And the age, because this figure is scraped rather than polled.
      await expect(panel).toContainText('12m 30s ago');
      await expectQuiet(page, problems);
    });

    test('says nothing whatsoever about codex when it is absent from the host', async ({
      page,
    }) => {
      const problems = collectPageProblems(page);
      await stubQuota(page, {
        generated_at: Math.floor(Date.now() / 1000),
        account: { claude: CLAUDE },
      });

      await page.goto('/#/monitor/ai');
      const panel = quotaPanel(page);

      await expect(panel).toContainText('Claude');
      await expect(panel).not.toContainText('Codex');
      await expect(panel).not.toContainText('UNREADABLE');
      await expectQuiet(page, problems);
    });

    test('an unreadable codex names a reason and puts no number on the page', async ({ page }) => {
      const problems = collectPageProblems(page);
      await stubQuota(page, {
        generated_at: Math.floor(Date.now() / 1000),
        account: { claude: null, codex: null },
        unavailable: { claude: 'rate_limited', codex: 'no_reading' },
      });

      await page.goto('/#/monitor/ai');
      const panel = quotaPanel(page);

      await expect(panel).toContainText('Codex quota UNREADABLE.');
      await expect(panel).toContainText('has not run recently enough');
      // Neither provider has a reading, and neither may show a percentage —
      // "0%" would read as wide open, the opposite of "unknown".
      await expect(panel).not.toContainText('%');
      await expectQuiet(page, problems);
    });
  });
});
