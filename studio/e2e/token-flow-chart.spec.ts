import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import {
  contrastRatio,
  fluentRootReady,
  resolvedPaletteColor,
  setTheme,
  surfaceBehind,
} from './support/theme';

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
    // #1025 — the per-side presence counts now arrive INSIDE `cost`, and
    // `RunCostSchema` is the live parser for this stubbed body, so a bucket
    // missing them fails the client's own parse rather than the assertion.
    inputReportedResponseCount: 0,
    outputReportedResponseCount: 0,
    complete: true,
  };
  const measured = {
    ...zeroCost,
    responseCount: 2,
    pricedResponseCount: 2,
    totalCostEstimate: 1.5,
    inputTokens: 800,
    outputTokens: 200,
    inputReportedResponseCount: 2,
    outputReportedResponseCount: 2,
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
    /* #988 — REQUIRED on the snapshot, so a stub without it is rejected by the
       client's schema and the page renders an error instead of a chart. Present
       and empty here on purpose: this spec is about the METERED series, and
       reported external activity plots no bar (it is billed to no connection). */
    external: {
      invocations: 0,
      completed: 0,
      notCompleted: 0,
      unknown: 0,
      inFlight: 0,
      lastAt: null,
      tokens: {
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        measuredInvocations: 0,
      },
      truncated: false,
      reporters: [],
    },
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
        },
        // genuinely empty: no exchanges at all, a MEASURED zero
        {
          bucketStart: 1_785_996_600_000,
          bucketEnd: 1_785_996_900_000,
          partial: false,
          cost: zeroCost,
        },
        // exchanges happened, NOBODY counted the tokens
        {
          bucketStart: 1_785_996_900_000,
          bucketEnd: 1_785_997_200_000,
          partial: false,
          cost: { ...zeroCost, responseCount: 3, unpricedResponseCount: 3 },
        },
        /*
         * ONE side counted, the other not — a stack, but a half-honest one.
         *
         * Its counted side is deliberately the FULL 1000 that sets the scale, so
         * this bucket's stack asks for the whole plot height PLUS the sliver and
         * the row gap. That is the only arrangement under which the sliver is
         * squeezed at all, and therefore the only one under which the geometry
         * assertions below can fail. At 400 they passed no matter what the CSS
         * said — checked by mutation, which is how this number got here.
         */
        {
          bucketStart: 1_785_997_200_000,
          bucketEnd: 1_785_997_500_000,
          partial: false,
          cost: { ...measured, inputTokens: 1000, outputTokens: 0, outputReportedResponseCount: 0 },
        },
        // still in progress
        {
          bucketStart: 1_785_997_500_000,
          bucketEnd: 1_785_997_600_000,
          partial: true,
          cost: { ...measured, inputTokens: 100, outputTokens: 50 },
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
    await expect(chart.locator('.token-flow-bucket')).toHaveCount(5);

    const buckets = chart.locator('.token-flow-bucket');
    // The unmeasured bucket (index 2) draws a marker, NOT a zero-height bar —
    // the whole reason the server carries token-presence counts.
    await expect(buckets.nth(2).locator('.token-flow-unmeasured')).toHaveCount(1);
    // The EMPTY one (index 1) does not, because "no exchanges" is a measured
    // zero — asserted on that bucket specifically, since a whole-chart count of
    // 1 would also pass if the marker had landed on the wrong bar.
    await expect(buckets.nth(1).locator('.token-flow-unmeasured')).toHaveCount(0);
    await expect(chart.locator('.token-flow-unmeasured')).toHaveCount(1);
    // Only the in-progress bucket (index 4) is marked partial.
    await expect(buckets.nth(4).locator('.token-flow-stack[data-partial="true"]')).toHaveCount(1);
    await expect(chart.locator('.token-flow-stack[data-partial="true"]')).toHaveCount(1);

    // The half case (index 3): input was counted, output was not. The counted
    // side is a bar; the omitted side is hatched, because `coalesce(sum(…), 0)`
    // would otherwise draw a measurement nobody made as a flat zero.
    const halfHonest = buckets.nth(3);
    await expect(halfHonest.locator('.token-flow-seg--out.token-flow-seg--unreported')).toHaveCount(
      1,
    );
    await expect(halfHonest.locator('.token-flow-seg--in.token-flow-seg--unreported')).toHaveCount(
      0,
    );
    await expect(chart.locator('.token-flow-seg--unreported')).toHaveCount(1);
    await expect(chart.getByText(/out not reported/)).toBeAttached();

    // Every value is reachable as TEXT, not only as a tooltip.
    await expect(chart.getByText(/3 exchanges, tokens not reported/)).toBeAttached();
    await expect(chart.getByText(/no billed exchanges/)).toBeAttached();

    // The legend names both series, so identity is never colour-alone.
    await expect(chart.getByText('Tokens in')).toBeVisible();
    await expect(chart.getByText('Tokens out')).toBeVisible();

    /*
     * #1035 — and it names the HATCH, the one mark whose meaning is not
     * self-evident and, until now, the only one with nothing explaining it. A
     * reader saw a hatched stub and could not learn it meant "nobody reported
     * this" rather than "almost zero".
     *
     * The stripes are ASSERTED, not assumed. The chart's own hatch rules are
     * two-class selectors (`.token-flow-seg.token-flow-seg--unreported`), so a
     * swatch that borrowed one of those class names would match nothing and
     * render as a plain grey square — a legend entry that explains a texture it
     * does not show. Its own single-class rule is what makes this pass.
     */
    const legend = chart.locator('.token-flow-legend');
    await expect(legend).toContainText('Not reported');
    const swatch = legend.locator('.token-flow-swatch--unreported');
    await expect(swatch).toHaveCount(1);
    const swatchPaint = await swatch.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        image: cs.backgroundImage,
        color: cs.backgroundColor,
        box: el.getBoundingClientRect().width,
      };
    });
    expect(swatchPaint.image).toContain('repeating-linear-gradient');
    expect(swatchPaint.color).not.toBe('rgba(0, 0, 0, 0)');
    // The swatch keeps the 10px legend box — it must not inherit the marks' own
    // `height: 6px` / `flex: none`, which encode "no magnitude" inside a stack.
    expect(swatchPaint.box).toBeCloseTo(10, 0);

    /*
     * GEOMETRY, MEASURED RATHER THAN REASONED ABOUT. The stack is a column flex
     * box whose two segments can sum to 100% of it, and it also carries a row
     * gap — so the laid-out content of the tallest bar asks for slightly more
     * room than the plot has. This asserts what the browser actually does with
     * that (shrink, not overflow), and that the fixed sliver is exempt: a marker
     * that shrinks under pressure would start encoding the magnitude it exists
     * to say nobody measured. One `evaluate`, every reading at once.
     */
    const geometry = await page.evaluate(() => {
      const bars = document.querySelector('.token-flow-bars');
      const stacks = Array.from(document.querySelectorAll('.token-flow-stack'));
      const laidOut = (stack: Element) => {
        const marks = Array.from(stack.querySelectorAll('.token-flow-seg, .token-flow-unmeasured'));
        const gap = parseFloat(getComputedStyle(stack).rowGap) || 0;
        const total = marks.reduce((n, m) => n + m.getBoundingClientRect().height, 0);
        return total + Math.max(0, marks.length - 1) * gap;
      };
      const sliver = document.querySelector('.token-flow-seg--unreported');
      return {
        plot: bars?.getBoundingClientRect().height ?? 0,
        tallest: Math.max(...stacks.map(laidOut)),
        sliver: sliver?.getBoundingClientRect().height ?? 0,
      };
    });
    expect(geometry.plot).toBeGreaterThan(0);
    expect(geometry.tallest).toBeLessThanOrEqual(geometry.plot);
    expect(geometry.sliver).toBeCloseTo(6, 1);

    await expectQuiet(page, problems);
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`both series paint their own palette token in ${theme} mode`, async ({ page }) => {
      const problems = collectPageProblems(page);
      await stubActivity(page);

      await page.goto('/#/monitor/ai');
      await fluentRootReady(page);
      await setTheme(page, theme);
      await expect(page.locator(CHART)).toBeVisible();

      const segments = await page.evaluate(() => {
        const seg = (cls: string) => {
          const el = document.querySelector(`.token-flow-seg--${cls}`);
          return el ? getComputedStyle(el).backgroundColor : '';
        };
        return { inColor: seg('in'), outColor: seg('out') };
      });
      /*
       * THE SURFACE THE BARS ARE ACTUALLY PAINTED ON, found by walking up for
       * the first ancestor that paints one — not a token named on the guess
       * that it is the one behind. `--panel` was that guess and it is wrong
       * twice over: nothing between the chart and `<body>` sets a background,
       * and the thing that does is neither of those — it is the FluentProvider
       * root, whose background comes from a Fluent token and not from this
       * app's palette at all. The walk is `surfaceBehind` in `support/theme.ts`;
       * it lived here as the only copy until #1027 needed the same measurement
       * for the status pills, and one definition with two callers is the rule
       * that file's own docblock argues for.
       */
      const surface = await surfaceBehind(page, '.token-flow');
      const measured = { ...segments, surface: surface.color, surfaceFrom: surface.from };

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
      // No "the walk found something" assertion: `surfaceBehind` now THROWS
      // naming the selector and the chain it climbed, which is strictly more
      // than an `expect(...).not.toBe('')` could say.
      // Both readings carry the colours they were taken from: a bare ratio in a
      // failure tells you the palette is wrong but not which pair to change,
      // and the surface is FOUND rather than named, so it is the one value a
      // reader cannot look up in `index.css`.
      const on = `on ${measured.surface} (${measured.surfaceFrom})`;
      expect(
        contrastRatio(measured.inColor, measured.surface),
        `tokens-in ${measured.inColor} ${on}`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(measured.outColor, measured.surface),
        `tokens-out ${measured.outColor} ${on}`,
      ).toBeGreaterThanOrEqual(3);
      /*
       * NO MUTUAL-CONTRAST ASSERTION BETWEEN THE TWO SERIES, deliberately.
       * WCAG contrast is a LUMINANCE ratio, and two categorical hues are
       * required to sit in the same lightness band — so their ratio is ~1.03
       * here BY DESIGN, and asserting otherwise would be demanding the palette
       * break the rule that makes it readable. What separates them is hue, whose
       * measure is perceptual distance: both pairs clear ΔE 20 under normal
       * vision and ΔE 20+ under protanopia and tritanopia, checked with the
       * palette validator when the hues were chosen and recorded in the
       * `index.css` docblock. Identity is never carried by colour alone anyway —
       * the legend and every bar's own text name the series.
       */

      await expectQuiet(page, problems);
    });
  }
});
