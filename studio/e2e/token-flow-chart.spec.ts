import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { contrastRatio, fluentRootReady, resolvedPaletteColor } from './support/theme';

/**
 * #967 — the token-flow chart on Monitor › AI activity.
 *
 * TWO KINDS OF ASSERTION HERE, and they need different setups.
 *
 * The COLOUR half needs no data. It probes the stylesheet directly, in both
 * themes, because the failure it guards is a palette one: a chart hue that has
 * no `[data-theme='light']` override keeps its dark value on a white panel, and
 * that is invisible to anything that only checks the markup. Values are compared
 * as COMPUTED colours on both sides — the expected token is resolved through the
 * same engine — so the check cannot pass or fail on hex-vs-rgb serialization.
 *
 * The RENDERING half stubs `/api/monitor/ai-activity`, which the neighbouring
 * spec deliberately does not do. The reason is specific to this chart: its whole
 * point is drawing UNMEASURED and PARTIAL buckets differently from empty ones,
 * and CI's database has no metered events at all, so the real endpoint can only
 * ever produce the empty case. Stubbing is what makes the honesty cases
 * observable rather than a thing the suite hopes it got right.
 */

const CHART = '.token-flow';

/** A snapshot with one bucket of each kind the chart must tell apart. */
function seriesSnapshot() {
  const zeroCost = {
    currency: 'USD',
    totalCostEstimate: 0,
    responseCount: 0,
    pricedResponseCount: 0,
    unpricedResponseCount: 0,
    costUnknownResponseCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    complete: true,
  };
  const measured = {
    ...zeroCost,
    responseCount: 2,
    pricedResponseCount: 2,
    totalCostEstimate: 1.5,
    inputTokens: 800,
    outputTokens: 200,
  };
  return {
    generatedAt: 1_786_000_000_000,
    since: '1h',
    windowStart: 1_785_996_400_000,
    runs: { pending: 0, queued: 0, running: 1, waiting: 0 },
    models: [
      {
        provider: 'anthropic_api',
        model: 'claude-opus-4-8',
        lastAt: 1_786_000_000_000,
        cost: measured,
      },
    ],
    agentCli: { invocations: 0, completed: 0, notCompleted: 0, lastAt: null },
    totals: measured,
    series: {
      bucketMs: 300_000,
      buckets: [
        // measured, and the tallest — sets the scale
        {
          bucketStart: 1_785_996_300_000,
          bucketEnd: 1_785_996_600_000,
          partial: false,
          cost: measured,
          inputReportedResponseCount: 2,
          outputReportedResponseCount: 2,
        },
        // genuinely empty: no exchanges at all, a MEASURED zero
        {
          bucketStart: 1_785_996_600_000,
          bucketEnd: 1_785_996_900_000,
          partial: false,
          cost: zeroCost,
          inputReportedResponseCount: 0,
          outputReportedResponseCount: 0,
        },
        // exchanges happened, NOBODY counted the tokens
        {
          bucketStart: 1_785_996_900_000,
          bucketEnd: 1_785_997_200_000,
          partial: false,
          cost: { ...zeroCost, responseCount: 3, unpricedResponseCount: 3 },
          inputReportedResponseCount: 0,
          outputReportedResponseCount: 0,
        },
        // still in progress
        {
          bucketStart: 1_785_997_200_000,
          bucketEnd: 1_785_997_300_000,
          partial: true,
          cost: { ...measured, inputTokens: 100, outputTokens: 50 },
          inputReportedResponseCount: 2,
          outputReportedResponseCount: 2,
        },
      ],
    },
  };
}

async function stubActivity(page: Page): Promise<void> {
  await page.route('**/api/monitor/ai-activity*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(seriesSnapshot()),
    }),
  );
}

test.describe('token-flow chart', () => {
  test('draws a bar per bucket and distinguishes unmeasured from empty', async ({ page }) => {
    const problems = collectPageProblems(page);
    await stubActivity(page);

    await page.goto('/#/monitor/ai');
    await fluentRootReady(page);

    const chart = page.locator(CHART);
    await expect(chart).toBeVisible();
    await expect(chart.locator('.token-flow-bucket')).toHaveCount(4);

    // The unmeasured bucket draws a marker, NOT a zero-height bar — the whole
    // reason the server carries token-presence counts.
    await expect(chart.locator('.token-flow-unmeasured')).toHaveCount(1);
    // ...and the empty one does not, because "no exchanges" is a measured zero.
    await expect(chart.locator('.token-flow-stack[data-partial="true"]')).toHaveCount(1);

    // Every value is reachable as TEXT, not only as a tooltip.
    await expect(chart.getByText(/3 exchanges, tokens not reported/)).toBeAttached();
    await expect(chart.getByText(/no billed exchanges/)).toBeAttached();

    // The legend names both series, so identity is never colour-alone.
    await expect(chart.getByText('Tokens in')).toBeVisible();
    await expect(chart.getByText('Tokens out')).toBeVisible();

    expectQuiet(problems);
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`both series paint their own palette token in ${theme} mode`, async ({ page }) => {
      const problems = collectPageProblems(page);
      await stubActivity(page);

      await page.goto('/#/monitor/ai');
      await fluentRootReady(page);
      await page.evaluate((t) => {
        document.documentElement.dataset['theme'] = t;
      }, theme);
      await expect(page.locator(CHART)).toBeVisible();

      const measured = await page.evaluate(() => {
        const seg = (cls: string) => {
          const el = document.querySelector(`.token-flow-seg--${cls}`);
          return el ? getComputedStyle(el).backgroundColor : '';
        };
        const panel = document.createElement('div');
        panel.style.color = 'var(--panel)';
        document.body.append(panel);
        const panelColor = getComputedStyle(panel).color;
        panel.remove();
        return { inColor: seg('in'), outColor: seg('out'), panelColor };
      });

      // Each segment paints exactly the token it claims to, resolved through the
      // same engine so both sides are computed values.
      expect(measured.inColor).toBe(await resolvedPaletteColor(page, '--chart-tokens-in'));
      expect(measured.outColor).toBe(await resolvedPaletteColor(page, '--chart-tokens-out'));

      // Neither is transparent or unresolved — the white-in-dark failure mode.
      expect(measured.inColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(measured.outColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(measured.inColor).not.toBe(measured.outColor);

      // A bar is a GRAPHICAL OBJECT, so WCAG 1.4.11 asks 3:1 against the surface
      // behind it — in BOTH themes, which is the point of running this twice.
      expect(contrastRatio(measured.inColor, measured.panelColor)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(measured.outColor, measured.panelColor)).toBeGreaterThanOrEqual(3);
      // ...and the two series must be distinguishable from EACH OTHER, not just
      // from the background, or the stack is one indistinguishable block.
      expect(contrastRatio(measured.inColor, measured.outColor)).toBeGreaterThanOrEqual(1.4);

      expectQuiet(problems);
    });
  }
});
