import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { triggerMenuItem } from './support/canvas';
import {
  computedStyles as styles,
  DENSITIES,
  drawnHeights,
  expectAppearance,
  expectControlHeights,
  preferAppearance,
} from './support/appearance';
import { properties } from './support/panels';
import { nodeById, openSeededCanvas } from './support/seedDoc';
import { offRampText } from './support/typeRamp';

/**
 * #1594 OR40 S6m — the dock's remaining pieces on the design system, at
 * 1440x900 in compact light and comfortable dark: a row table's internals (a
 * Copy mapping), the `${}` reference list and the functions list opened from
 * one of its cells, the `?` help, and the editor's run drawer.
 *
 * Measured: all text on the type ramp with each list open; spacing on the 4px
 * scale at the values below; the `?` a circle at `--icon-size`; the row and
 * drawer acts at `--control-h`.
 */

type Density = (typeof DENSITIES)[number];

const RUNS = [
  { density: 'compact', theme: 'light' },
  { density: 'comfortable', theme: 'dark' },
] as const;

/** `--icon-size` per density, hard-coded as `CONTROL_H` is, so a drifting token fails here. */
const ICON: Record<Density, number> = { compact: 16, comfortable: 20 };

const DOCK = '.property-dock';

const mappingSeed = {
  nodes: [
    {
      id: 'c',
      type: 'copy',
      position: { x: 0, y: 0 },
      config: {
        mapping: [
          { source: 'id', sink: 'id', type: 'integer' },
          { source: 'name', sink: 'full_name', type: 'string' },
        ],
      },
    },
  ],
  params: [{ name: 'region', type: 'string' as const, required: false, default: 'eu' }],
};

for (const { density, theme } of RUNS) {
  const d = density as Density;

  test(`#1594 OR40 S6m — row tables, the expression lists and the ? on the scale (${density} ${theme})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await preferAppearance(page, theme, d);
    await openSeededCanvas(page, `S6m mapping ${density} ${Date.now()}`, mappingSeed);
    await expectAppearance(page, theme, d);

    await nodeById(page, 'c').click();
    await properties(page)
      .getByRole('tablist', { name: 'Activity properties' })
      .getByRole('tab', { name: 'Mapping' })
      .click();
    const table = properties(page).getByRole('table', { name: 'mapping' });
    await expect(table).toBeVisible();

    // The row table's internals: a cell is 4px either side, its control and the
    // note under it 4px apart, and the row's acts 4px apart at `--control-h`.
    const cells = await styles(
      page,
      [
        '.row-table td',
        '.row-table td > .labelled-control',
        '.row-table__actions button',
        '.row-table__actions button + button',
      ],
      ['padding-left', 'padding-right', 'row-gap', 'margin-left'],
    );
    expect(cells['.row-table td']?.['padding-left'], 'cell').toBe('4px');
    expect(cells['.row-table td']?.['padding-right'], 'cell').toBe('4px');
    expect(cells['.row-table td > .labelled-control']?.['row-gap'], 'cell field').toBe('4px');
    expect(cells['.row-table__actions button']?.['padding-left'], 'row act').toBe('4px');
    expect(cells['.row-table__actions button + button']?.['margin-left'], 'row acts').toBe('4px');
    await expectControlHeights(page, '.row-table__actions button', d, 'row acts');
    // A one-line text box is still a control tall.
    for (const { name, h } of await drawnHeights(page, '.row-table td :is(input, textarea)')) {
      expect(h, `cell control ${name}`).toBe(d === 'compact' ? 28 : 32);
    }

    // The `?`: a circle at `--icon-size`.
    const help = await page
      .locator(`${DOCK} summary:visible`)
      .first()
      .evaluate((el) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          w: Math.round(r.width),
          h: Math.round(r.height),
          radius: parseFloat(s.borderTopLeftRadius),
          size: s.fontSize,
        };
      });
    expect(help.w, '? width').toBe(ICON[d]);
    expect(help.h, '? height').toBe(ICON[d]);
    expect(help.radius, '? radius').toBeGreaterThanOrEqual(ICON[d] / 2);
    expect(help.size, '? type').toBe('12px');

    // The references list, opened from a cell.
    const source = table.getByRole('textbox', { name: 'Column mapping row 1 source' });
    await source.focus();
    const refs = table.getByRole('button', { name: /^Insert reference into Column mapping row 1 source/ });
    await refs.click();
    await expect(refs).toHaveAttribute('aria-expanded', 'true');
    const open = await styles(
      page,
      [
        '.expression-picker-list',
        '.expression-picker-list h3',
        '.expression-picker-list ul',
        '.expression-picker-list li button',
        '.expression-picker-type',
      ],
      [
        'margin-top',
        'margin-bottom',
        'padding-top',
        'padding-left',
        'border-top-left-radius',
        'row-gap',
        'font-size',
      ],
    );
    const list = open['.expression-picker-list'];
    expect(list?.['margin-top'], 'list').toBe('4px');
    expect(list?.['padding-top'], 'list').toBe('8px');
    expect(list?.['padding-left'], 'list').toBe('8px');
    expect(list?.['border-top-left-radius'], 'list').toBe('6px');
    expect(open['.expression-picker-list h3']?.['margin-top'], 'group heading').toBe('8px');
    expect(open['.expression-picker-list h3']?.['margin-bottom'], 'group heading').toBe('4px');
    expect(open['.expression-picker-list ul']?.['row-gap'], 'items').toBe('0px');
    expect(open['.expression-picker-list li button']?.['padding-top'], 'item').toBe('4px');
    expect(open['.expression-picker-list li button']?.['padding-left'], 'item').toBe('8px');
    expect(open['.expression-picker-list li button']?.['row-gap'], 'item').toBe('0px');
    expect(open['.expression-picker-type']?.['font-size'], 'item type').toBe('12px');
    expect(await offRampText(page, d, DOCK), 'references open: ramp').toEqual([]);
    await page.keyboard.press('Escape');
    await expect(refs).toHaveAttribute('aria-expanded', 'false');

    // The functions list: a function's text, then one button per example.
    await source.focus();
    const fns = table.getByRole('button', { name: /^Functions for Column mapping row 1 source/ });
    await fns.click();
    await expect(fns).toHaveAttribute('aria-expanded', 'true');
    const examples = await styles(
      page,
      ['li.expression-picker-example', 'li.expression-picker-example button'],
      ['padding-top', 'padding-left', 'row-gap', 'column-gap'],
    );
    expect(examples['li.expression-picker-example']?.['padding-top'], 'function').toBe('4px');
    expect(examples['li.expression-picker-example']?.['padding-left'], 'function').toBe('8px');
    expect(examples['li.expression-picker-example']?.['row-gap'], 'function').toBe('0px');
    expect(examples['li.expression-picker-example button']?.['column-gap'], 'example').toBe('8px');
    expect(await offRampText(page, d, DOCK), 'functions open: ramp').toEqual([]);

    await expectQuiet(page, problems);
  });

  test(`#1594 OR40 S6m — the editor's run drawer on the ramp and the scale (${density} ${theme})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await preferAppearance(page, theme, d);
    await openSeededCanvas(page, `S6m run drawer ${density} ${Date.now()}`, {
      params: [{ name: 'nums', type: 'json', required: false, default: [1, 2, 3] }],
      nodes: [
        {
          id: 'pick',
          type: 'filter',
          config: { items: '${params.nums}', predicate: '${greater(item, 1)}' },
          position: { x: 0, y: 0 },
        },
      ],
    });
    await expectAppearance(page, theme, d);

    await (await triggerMenuItem(page, /^Trigger now/)).click();
    await page
      .getByRole('dialog', { name: 'Run v1' })
      .getByRole('button', { name: 'Start run' })
      .click();
    const status = nodeById(page, 'pick').getByTestId('node-run-status');
    await expect(status).toContainText('success', { timeout: 20_000 });

    await nodeById(page, 'pick').click();
    const drawer = page.locator(`${DOCK} .node-detail-panel`);
    await expect(drawer.getByRole('heading', { name: 'Outputs' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open full run' })).toBeVisible();

    expect(await offRampText(page, d, DOCK), 'run drawer: ramp').toEqual([]);
    await expectControlHeights(page, `${DOCK} .node-detail-panel button:not(summary)`, d, 'drawer acts');
    const gaps = await styles(page, [`${DOCK} .node-detail-panel`], ['margin-top']);
    expect(gaps[`${DOCK} .node-detail-panel`]?.['margin-top'], 'drawer').toBe('12px');

    await expectQuiet(page, problems);
  });
}
