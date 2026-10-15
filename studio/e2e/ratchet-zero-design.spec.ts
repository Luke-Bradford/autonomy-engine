import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import {
  computedStyles as styles,
  DENSITIES,
  DESIGN_RUNS,
  expectAppearance,
  preferAppearance,
} from './support/appearance';
import { childGaps } from './support/gaps';
import { properties } from './support/panels';
import { newPipelineButton } from './support/pipelinesPage';
import { nodeById, openSeededCanvas } from './support/seedDoc';
import { seedConnection } from './support/seedResources';

/**
 * #1594 OR40 S6u — the design-token ratchet's last five literals, at 1440x900
 * in compact light and comfortable dark: a list row's actions, the primary
 * button's weight, the visually-hidden clip and the property dock's scroll
 * padding under its pinned header.
 */

type Density = (typeof DENSITIES)[number];

/** The dock's pinned header and tab strip, and the scroll padding that clears them. */
function pinnedHeader(page: Page) {
  return properties(page).evaluate((panel) => ({
    sticky: panel.querySelector<HTMLElement>('.panel-tabs-sticky')!.getBoundingClientRect().height,
    padding: parseFloat(getComputedStyle(panel).scrollPaddingTop),
  }));
}

/** The padding is the pinned region's measured height plus `--space-1` for a focus ring. */
async function expectPaddingClears(page: Page, where: string): Promise<number> {
  await expect
    .poll(async () => {
      const { sticky, padding } = await pinnedHeader(page);
      return Math.round(padding - sticky);
    }, where)
    .toBe(4);
  return (await pinnedHeader(page)).sticky;
}

for (const { density, theme } of DESIGN_RUNS) {
  const d = density as Density;

  test(`#1594 OR40 S6u — the ratchet's last literals on the tokens (${density} ${theme})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await preferAppearance(page, theme, d);

    // The primary button (the Pipelines toolbar's + New pipeline, there in any
    // state) is semibold, the ramp's strong weight.
    await page.goto('/#/author/pipelines');
    await expectAppearance(page, theme, d);
    const newPipeline = newPipelineButton(page);
    await expect(newPipeline).toHaveClass(/\bprimary\b/);
    await expect(newPipeline).toHaveCSS('font-weight', '600');

    // A list row: its one inline act and its ⋯ menu, 8px apart.
    await seedConnection(page, {
      name: `S6u files ${density} ${Date.now()}`,
      kind: 'fs',
      config: { roots: ['/tmp/e2e-s6u'], maxBytes: 1000 },
    });
    await page.goto('/#/manage/connections');
    await expect(page.locator('.row-actions').first()).toBeVisible();
    expect(await childGaps(page, '.row-actions'), 'row actions').toEqual(['→8']);

    // Present to assistive tech: a clipped 1px box, back by its own 1px so it
    // adds no overflow at its scroller's edge.
    const hidden = await styles(
      page,
      ['.visually-hidden'],
      ['margin-top', 'margin-left', 'width', 'height', 'clip-path', 'position'],
    );
    expect(hidden['.visually-hidden'], 'visually hidden').toEqual({
      'margin-top': '-1px',
      'margin-left': '-1px',
      width: '1px',
      height: '1px',
      'clip-path': 'inset(50%)',
      position: 'absolute',
    });

    // The dock's scroll padding is its pinned header and tab strip's MEASURED
    // height: in the bottom dock, and in the narrowest right-hand dock, where
    // the header wraps and the region is taller (comfortable: 122px, past the
    // fixed 7rem this replaced).
    // Short enough that the tab overflows: since #1694 OR42 F10 its text boxes
    // rest at one line, and in compact at full height the whole tab fits.
    await page.setViewportSize({ width: 1600, height: 700 });
    await openSeededCanvas(page, `S6u dock ${density} ${Date.now()}`, {
      nodes: [{ id: 'l', type: 'llm_call', position: { x: 0, y: 0 }, config: { prompt: 'Hi' } }],
    });
    await nodeById(page, 'l').click();
    const bottom = await expectPaddingClears(page, 'bottom dock');

    // At rest the pinned region sits at the panel's edge, over nothing.
    const rest = await properties(page).evaluate((panel) => {
      const top = panel.getBoundingClientRect().top + panel.clientTop;
      const pinned = panel.querySelector('.panel-tabs-sticky')!.getBoundingClientRect();
      const tab = panel.querySelector('[role="tabpanel"]:not([hidden])')!.getBoundingClientRect();
      return { edge: Math.round(pinned.top - top), below: Math.round(tab.top - pinned.bottom) };
    });
    expect(rest, 'at rest').toEqual({ edge: 0, below: 8 });

    // Scrolled to its end, a field under the pinned region is brought to the
    // panel's top edge, as focus brings one in from above: it lands below the
    // pinned region, with room for its focus ring. (`block: 'start'`, not
    // `focus()`, whose alignment Chrome picks for itself.)
    const hiddenField = await properties(page).evaluate((panel) => {
      panel.scrollTop = panel.scrollHeight;
      const pinned = panel.querySelector('.panel-tabs-sticky')!.getBoundingClientRect();
      const under = [
        ...panel.querySelectorAll<HTMLElement>(
          '[role="tabpanel"]:not([hidden]) :is(input, textarea)',
        ),
      ].filter((f) => {
        const r = f.getBoundingClientRect();
        return r.height > 0 && r.bottom > pinned.top && r.top < pinned.bottom;
      });
      under.at(-1)?.setAttribute('data-s6u', 'under');
      return { scrolled: panel.scrollTop, under: under.length };
    });
    expect(hiddenField.scrolled, 'the panel scrolls').toBeGreaterThan(0);
    expect(hiddenField.under, 'a field sits under the pinned region').toBeGreaterThan(0);
    const clearance = await properties(page).evaluate((panel) => {
      const field = panel.querySelector<HTMLElement>('[data-s6u="under"]')!;
      field.scrollIntoView({ block: 'start' });
      const pinned = panel.querySelector('.panel-tabs-sticky')!.getBoundingClientRect();
      return Math.round(field.getBoundingClientRect().top - pinned.bottom);
    });
    expect(clearance, 'below the pinned region by the ring allowance').toBe(4);

    await page.getByRole('button', { name: 'Dock to right' }).click();
    const divider = page.getByRole('separator', { name: 'Resize properties' });
    await divider.focus();
    await page.keyboard.press('Home');
    await expect(divider).toHaveAttribute('aria-valuenow', '320');
    const narrow = await expectPaddingClears(page, 'narrow right dock');
    expect(narrow, 'the header wraps in the narrow dock').toBeGreaterThan(bottom);
    await expectQuiet(page, problems);
  });
}
