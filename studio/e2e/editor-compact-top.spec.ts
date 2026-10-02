import { expect, test, type Page } from '@playwright/test';
import { openCanvas } from './support/canvas';
import { collectPageProblems, expectQuiet } from './support/console-guard';

/**
 * #1475 OR27 slice 1 — the editor gives its height to the canvas.
 *
 * Measured on `202f288d`: 172px sat above the canvas at every viewport (19% of
 * 1440×900), and about 76px of that held nothing — page padding, the h2's
 * browser margins, and a 36px notice strip that is empty most of the time.
 * The bar is ≤ 88px: the command bar plus ONE toolbar row that carries the
 * title, the notices and the actions.
 *
 * WHY TWO VIEWPORTS. The waste was a constant, so a fix that only works at one
 * size (a viewport-relative cap, say) would pass a single check.
 *
 * Boxes, not computed styles: `canvas-fills-viewport.spec.ts` records why —
 * only `getBoundingClientRect()` describes what was rendered.
 */
const TOP_BUDGET_PX = 88;

async function read(page: Page) {
  return page.evaluate(() => {
    const rect = (sel: string) => {
      const el = document.querySelector(sel);
      return el ? el.getBoundingClientRect() : null;
    };
    const header = rect('.canvas-page > .page-header');
    const strip = rect('[data-testid="editor-status-strip"]');
    return {
      flowTop: rect('.react-flow')?.top ?? null,
      toolboxTop: rect('.activity-toolbox')?.top ?? null,
      headerTop: header?.top ?? null,
      headerBottom: header?.bottom ?? null,
      stripTop: strip?.top ?? null,
      stripBottom: strip?.bottom ?? null,
      stripInHeader:
        document.querySelector(
          '.canvas-page > .page-header [data-testid="editor-status-strip"]',
        ) !== null,
    };
  });
}

for (const [width, height] of [
  [1440, 900],
  [1280, 720],
] as const) {
  test(`#1475 the canvas starts within ${String(TOP_BUDGET_PX)}px of the top at ${String(width)}×${String(height)}`, async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width, height });
    await openCanvas(page, `e2e 1475 top ${String(width)} ${Date.now()}`);
    await expect(page.locator('.react-flow')).toBeVisible();

    const m = await read(page);
    expect(m.flowTop).not.toBeNull();
    expect(m.flowTop!, 'canvas top').toBeLessThanOrEqual(TOP_BUDGET_PX);
    // The toolbox shares the canvas row, so it starts with it rather than
    // under a band of its own.
    expect(Math.abs(m.toolboxTop! - m.flowTop!)).toBeLessThanOrEqual(1);

    // The notice strip is a slot IN the toolbar row, not a band under it: it
    // costs no height when it is empty, which is most of the time.
    expect(m.stripInHeader, 'strip is inside the header row').toBe(true);
    expect(m.stripTop!).toBeGreaterThanOrEqual(m.headerTop! - 1);
    expect(m.stripBottom!).toBeLessThanOrEqual(m.headerBottom! + 1);

    // A notice arriving in that slot moves nothing (#1393's guarantee, kept).
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(
      page.locator('.editor-status-strip .notice', { hasText: /Saved v\d+\./ }),
    ).toBeVisible();
    const after = await read(page);
    expect(Math.abs(after.flowTop! - m.flowTop!), 'canvas top after a notice').toBeLessThanOrEqual(
      1,
    );

    await expectQuiet(page, problems);
  });
}
