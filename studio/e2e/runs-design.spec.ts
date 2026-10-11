import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import { CONTROL_H, DENSITIES, expectAppearance, preferAppearance } from './support/appearance';
import { expectInlineRow } from './support/inlineRow';
import { offRampText } from './support/typeRamp';
import { fireAndSettle, seedVersion } from './support/seedDoc';

/**
 * #1594 OR40 S6f — the Runs list on the design system, at 1440x900 in compact
 * light and comfortable dark, at the default columns and widths.
 *
 * The header: no prose under the title, which says what the list holds through
 * its `?` ("About Runs", the page's description, its note opening under the
 * header row), and every control in it `--control-h` tall. The grid: no
 * column's header label is clipped (the S6e audit found "Duration" cut, and
 * "Started GMT+1" in comfortable) with the default sort's arrow drawn on
 * Started. The filter bar is one row of `--control-h` controls, 8px apart on
 * one centre line, and every piece of text is on the type ramp. A seeded,
 * settled run gives the grid a row.
 */

type Density = (typeof DENSITIES)[number];

const RUNS = [
  { density: 'compact', theme: 'light' },
  { density: 'comfortable', theme: 'dark' },
] as const;

/** Every measurement in ONE evaluate. */
function measure(page: Page) {
  return page.evaluate(() => {
    const content = document.querySelector('.content')!;
    const header = content.querySelector('.page-header')!;
    const headRect = header.getBoundingClientRect();
    const box = (c: Element) => {
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
    };
    const shown = (c: Element) => c.getClientRects().length > 0;
    const h1 = header.querySelector('h1')!;
    const help = header.querySelector(':scope > details > summary');
    const note = header.querySelector<HTMLElement>(':scope > details[open] > [role=note]');
    const noteRect = note?.getBoundingClientRect();
    const table = content.querySelector('table.runs-grid')!;
    // A label is cut when it needs more than its cell's content box (as in
    // `pipelines-design.spec.ts`: the ▲ glyph spilling its own box is no cut).
    const clipped = [...table.querySelectorAll<HTMLElement>('thead th')]
      .filter((th) => !th.querySelector('.visually-hidden') && (th.textContent ?? '').trim())
      .map((th) => {
        const s = getComputedStyle(th);
        const room = th.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
        const label = th.querySelector<HTMLElement>('.sort-button');
        return {
          text: (th.textContent ?? '').trim(),
          need: label?.scrollWidth ?? th.scrollWidth,
          room: label ? room : th.clientWidth,
        };
      })
      .filter(({ need, room }) => need > room + 1)
      .map(({ text, need, room }) => `${text} (${need}/${Math.round(room)}px)`);
    const bar = content.querySelector('[role=group][aria-label="Filter runs"]')!;
    const root = document.scrollingElement!;
    return {
      prose: [...content.querySelectorAll('.page-hint')].filter(
        (el) => !el.closest('.section, form'),
      ).length,
      helpName: help?.getAttribute('aria-label') ?? null,
      title: [box(h1), ...(help ? [{ ...box(help), name: '?' }] : [])],
      headerControls: [
        ...header.querySelectorAll('.toolbar button, .toolbar input, .toolbar select'),
      ]
        .filter(shown)
        .map(box),
      note:
        noteRect === undefined
          ? null
          : {
              leftOffset: Math.round(noteRect.left - headRect.left),
              belowRow: Math.round(noteRect.top - headRect.bottom),
              inViewport: noteRect.left >= 0 && noteRect.right <= window.innerWidth,
            },
      columns: table.querySelectorAll('thead th').length,
      arrows: [...table.querySelectorAll('thead .sort-button__arrow')]
        .filter((a) => (a.textContent ?? '').trim())
        .map((a) => (a.closest('th')!.textContent ?? '').trim()),
      clipped,
      // A pill is the control-h frame; its own select or input sits borderless
      // inside it (`run-filter-pills.spec.ts`), so the pill is what is measured.
      filters: [
        ...bar.querySelectorAll(
          '.filter-pill, button:not(.filter-pill *), input:not(.filter-pill *), select:not(.filter-pill *)',
        ),
      ]
        .filter(shown)
        .map(box),
      sideways: Math.max(
        root.scrollWidth - root.clientWidth,
        content.scrollWidth - content.clientWidth,
      ),
    };
  });
}

for (const { density, theme } of RUNS) {
  test(`#1594 OR40 S6f — the Runs list: the title's ?, no clipped header, on the ramp, one row of filters (${density} ${theme})`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await preferAppearance(page, theme, density as Density);
    const name = `S6f pipeline ${density}`;
    const { pipelineVersionId } = await seedVersion(page, name, {
      nodes: [{ id: 'w', type: 'wait', position: { x: 0, y: 0 }, config: { seconds: '${0}' } }],
    });
    await fireAndSettle(page, pipelineVersionId);

    await page.goto('/#/monitor/runs');
    await fluentRootReady(page);
    await expectAppearance(page, theme, density as Density);
    const region = page.getByRole('region', { name: 'Runs', exact: true });
    await expect(region.getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();
    await expect(page.locator('table.runs-grid').getByText(name).first()).toBeVisible();

    const h = CONTROL_H[density as Density];
    const closed = await measure(page);
    expect(closed).toMatchObject({ prose: 0, helpName: 'About Runs', note: null, sideways: 0 });
    expectInlineRow('Runs title', closed.title);
    expect(closed.headerControls.length).toBeGreaterThanOrEqual(3);
    for (const c of closed.headerControls) expect(c.h, `header ${c.name} height`).toBe(h);
    // The default columns (all but Annotations, and the ⋯), sorted by Started.
    expect(closed.columns).toBeGreaterThanOrEqual(10);
    expect(closed.arrows).toEqual([expect.stringMatching(/^Started/)]);
    expect(closed.clipped, 'clipped header labels').toEqual([]);
    expect(closed.filters.length).toBeGreaterThanOrEqual(4);
    for (const c of closed.filters) expect(c.h, `filter ${c.name} height`).toBe(h);
    expectInlineRow('filter bar', closed.filters);
    expect(await offRampText(page, density as Density), '? closed').toEqual([]);

    // The note is the page's description, and it opens under the header row.
    const note = page.locator('.page-header [role=note]');
    const said = ((await note.textContent()) ?? '').trim();
    expect(said).not.toBe('');
    await expect(region).toHaveAccessibleDescription(said);
    await page.locator('.page-header > details > summary').click();
    await expect(note).toBeVisible();
    const open = await measure(page);
    expect(open.note).toEqual({ leftOffset: 0, belowRow: 4, inViewport: true });
    expect(open.sideways).toBe(0);
    expect(await offRampText(page, density as Density), '? open').toEqual([]);
    await page.keyboard.press('Escape');
    await expect(note).toBeHidden();

    await expectQuiet(page, problems);
  });
}
