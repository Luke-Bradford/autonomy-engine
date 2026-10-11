import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import { CONTROL_H, DENSITIES, expectAppearance, preferAppearance } from './support/appearance';
import { expectInlineRow } from './support/inlineRow';
import { offRampText } from './support/typeRamp';
import { fireAndSettle, seedVersion } from './support/seedDoc';

/**
 * #1594 OR40 S6e — the Pipelines list's grid and filter bar on the design
 * system, at 1440x900 in compact light and comfortable dark. (Its header, the
 * title's `?` and no prose, is `manage-lists-design.spec.ts`'s; its rows,
 * padding and tooltips are `table-style.spec.ts`'s.)
 *
 * With EVERY column shown, at the default widths: no column's header label is
 * clipped (the audit found "Success % (7d)" cut), and every piece of text is on
 * the type ramp, the sort arrow included. The filter bar is one row of
 * `--control-h` controls, 8px apart on one centre line. A seeded, settled run
 * gives the grid a row with every column filled, and the name is sorted, so
 * the arrow is drawn.
 */

type Density = (typeof DENSITIES)[number];

/** Read as the shipped app reads it: a renamed key fails here (see `appearance.ts`). */
const HIDDEN_KEY = 'autonomy-studio.pipelines-grid-hidden';

const RUNS = [
  { density: 'compact', theme: 'light' },
  { density: 'comfortable', theme: 'dark' },
] as const;

function measure(page: Page) {
  return page.evaluate(() => {
    const content = document.querySelector('.content')!;
    const table = content.querySelector('table')!;
    const clipped = [...table.querySelectorAll<HTMLElement>('thead th')]
      // The ⋯ column's name is for assistive tech only, and the filler has none.
      .filter((th) => !th.querySelector('.visually-hidden') && (th.textContent ?? '').trim())
      .map((th) => th.querySelector<HTMLElement>('.sort-button') ?? th)
      .filter((label) => label.scrollWidth > label.clientWidth + 1)
      .map(
        (label) =>
          `${(label.textContent ?? '').trim()} (${label.scrollWidth}/${label.clientWidth}px)`,
      );
    const bar = content.querySelector('[role=group][aria-label="Filter pipelines"]')!;
    const controls = [...bar.querySelectorAll('button, input, select')]
      .filter((c) => c.getClientRects().length > 0)
      .map((c) => {
        const r = c.getBoundingClientRect();
        return {
          name:
            c.getAttribute('aria-label') ||
            (c as HTMLInputElement).labels?.[0]?.textContent?.trim() ||
            (c.textContent ?? '').trim().slice(0, 20) ||
            c.tagName,
          left: r.left,
          right: r.right,
          centre: r.top + r.height / 2,
          h: Math.round(r.height),
        };
      });
    const root = document.scrollingElement!;
    return {
      columns: table.querySelectorAll('thead th').length,
      arrows: table.querySelectorAll('thead .sort-button__arrow').length,
      clipped,
      controls,
      sideways: Math.max(
        root.scrollWidth - root.clientWidth,
        content.scrollWidth - content.clientWidth,
      ),
    };
  });
}

for (const { density, theme } of RUNS) {
  test(`#1594 OR40 S6e — the Pipelines grid and filter bar: no clipped header, on the ramp, one row of controls (${density} ${theme})`, async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await preferAppearance(page, theme, density as Density);
    await page.addInitScript((key) => localStorage.setItem(key, '[]'), HIDDEN_KEY);
    const { pipelineVersionId } = await seedVersion(page, `S6e pipeline ${density}`, {
      nodes: [{ id: 'w', type: 'wait', position: { x: 0, y: 0 }, config: { seconds: '${0}' } }],
    });
    await fireAndSettle(page, pipelineVersionId);

    await page.goto('/#/author/pipelines');
    await fluentRootReady(page);
    await expectAppearance(page, theme, density as Density);
    await expect(
      page.locator('.content table').getByRole('link', { name: `S6e pipeline ${density}` }),
    ).toBeVisible();

    const m = await measure(page);
    // Every column is drawn (13 and the ⋯), so the check is not over a subset.
    expect(m.columns).toBeGreaterThanOrEqual(14);
    expect(m.arrows).toBeGreaterThan(0);
    expect(m.clipped, 'clipped header labels').toEqual([]);
    expect(m.sideways).toBe(0);
    expect(m.controls.length).toBeGreaterThanOrEqual(7);
    for (const c of m.controls) expect(c.h, `${c.name} height`).toBe(CONTROL_H[density as Density]);
    expectInlineRow('filter bar', m.controls);
    expect(await offRampText(page, density as Density)).toEqual([]);

    await expectQuiet(page, problems);
  });
}
