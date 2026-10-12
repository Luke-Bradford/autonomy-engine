import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { runFromEditor } from './support/canvas';
import {
  computedStyles as styles,
  DENSITIES,
  DESIGN_RUNS,
  drawnHeights,
  expectAppearance,
  expectControlHeights,
  ICON_SIZE,
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
    { id: 'w', type: 'wait', position: { x: 320, y: 0 }, config: { seconds: '${5}' } },
  ],
  params: [{ name: 'secs', type: 'number' as const, required: false, default: 3 }],
};

/** The open list's box: 4px under its toggle, 8px inside a 6px radius. */
async function expectListBox(page: Page, label: string): Promise<void> {
  const list = (
    await styles(
      page,
      ['.expression-picker-list'],
      ['margin-top', 'padding-top', 'padding-left', 'border-top-left-radius'],
    )
  )['.expression-picker-list'];
  expect(list?.['margin-top'], label).toBe('4px');
  expect(list?.['padding-top'], label).toBe('8px');
  expect(list?.['padding-left'], label).toBe('8px');
  expect(list?.['border-top-left-radius'], label).toBe('6px');
}

for (const { density, theme } of DESIGN_RUNS) {
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
    // A text box's one line is centred in its control: the caption's 16px
    // leading compact, the body's 20px comfortable, 5px above and below either way.
    const box = (await styles(page, ['.row-table td textarea'], ['line-height', 'padding-top']))[
      '.row-table td textarea'
    ];
    expect(box?.['line-height'], 'cell text box').toBe(d === 'compact' ? '16px' : '20px');
    expect(box?.['padding-top'], 'cell text box').toBe('5px');
    // A one-line text box is still a control tall.
    for (const { name, h } of await drawnHeights(
      page,
      '.row-table td :is(input:not([type=checkbox]), textarea)',
    )) {
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
          // The glyph's own box against the circle's: centred within a pixel.
          off: (() => {
            const range = document.createRange();
            range.selectNodeContents(el);
            const g = range.getBoundingClientRect();
            return Math.max(
              Math.abs(g.left + g.width / 2 - (r.left + r.width / 2)),
              Math.abs(g.top + g.height / 2 - (r.top + r.height / 2)),
            );
          })(),
        };
      });
    expect(help.w, '? width').toBe(ICON_SIZE[d]);
    expect(help.h, '? height').toBe(ICON_SIZE[d]);
    expect(help.radius, '? radius').toBeGreaterThanOrEqual(ICON_SIZE[d] / 2);
    expect(help.size, '? type').toBe('12px');
    expect(help.off, '? glyph centred').toBeLessThanOrEqual(1);

    // A cell's list: no reference fits a mapping column, so it is the box and
    // its two notes, measured where the cell's own rules apply.
    const source = table.getByRole('textbox', { name: 'Column mapping row 1 source' });
    await source.focus();
    const cellRefs = table.getByRole('button', {
      name: /^Insert reference into column mapping row 1 source$/i,
    });
    await cellRefs.click();
    await expect(cellRefs).toHaveAttribute('aria-expanded', 'true');
    await expectListBox(page, 'cell list');
    expect(await offRampText(page, d, DOCK), 'cell list open: ramp').toEqual([]);

    // A config field that takes the number parameter, so each list has rows.
    await nodeById(page, 'w').click();
    await properties(page).getByRole('tab', { name: 'Settings' }).click();
    const refs = properties(page).getByRole('button', { name: /^Insert reference into seconds$/i });
    await refs.click();
    await expect(refs).toHaveAttribute('aria-expanded', 'true');
    await expectListBox(page, 'references');
    const open = await styles(
      page,
      [
        '.expression-picker-list h3',
        '.expression-picker-list ul',
        '.expression-picker-list li button',
        '.expression-picker-type',
      ],
      ['margin-top', 'margin-bottom', 'padding-top', 'padding-left', 'row-gap', 'font-size'],
    );
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

    // The functions list: a function's text, then one button per example. Its
    // examples are offered for an empty field; inside `${5}` it would wrap.
    await properties(page).getByRole('textbox', { name: 'Wait time (seconds)' }).fill('');
    const fns = properties(page).getByRole('button', { name: /^Functions for seconds$/i });
    await fns.click();
    await expect(fns).toHaveAttribute('aria-expanded', 'true');
    await expectListBox(page, 'functions');
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

    await runFromEditor(page);
    const status = nodeById(page, 'pick').getByTestId('node-run-status');
    await expect(status).toContainText('success', { timeout: 20_000 });

    await nodeById(page, 'pick').click();
    const drawer = page.locator(`${DOCK} .node-detail-panel`);
    await expect(drawer.getByRole('heading', { name: 'Outputs' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open full run' })).toBeVisible();

    expect(await offRampText(page, d, DOCK), 'run drawer: ramp').toEqual([]);
    await expectControlHeights(page, `${DOCK} .node-detail-panel button`, d, 'drawer acts');
    const gaps = await styles(page, [`${DOCK} .node-detail-panel`], ['margin-top']);
    expect(gaps[`${DOCK} .node-detail-panel`]?.['margin-top'], 'drawer').toBe('12px');

    await expectQuiet(page, problems);
  });
}
