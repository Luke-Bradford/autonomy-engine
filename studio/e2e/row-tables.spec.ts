import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { nodeById, openSeededCanvas } from './support/seedDoc';
import { properties } from './support/panels';
import { labelProblem } from '../packages/web/src/testing/sentenceCase';

/**
 * #1477 OR29 — authored rows are compact tables: params, variables, outputs and
 * every row list (a Copy mapping here). Measured at the operator's 1440×900 with
 * the default (compact) density: a header row names the columns once, each body
 * row is one 32px line of 28px controls, and the cells show no label of their own.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const seed = {
  nodes: [
    {
      id: 'c',
      type: 'copy',
      position: { x: 0, y: 0 },
      config: {
        mapping: [
          { source: 'id', sink: 'id', type: 'integer' },
          { source: 'name', sink: 'full_name', type: 'string' },
          { source: 'amount', sink: 'amount', type: 'number' },
        ],
      },
    },
  ],
  params: [
    { name: 'region', type: 'string' as const, required: false, default: 'eu' },
    { name: 'limit', type: 'number' as const, required: false, default: 10 },
    { name: 'dry', type: 'boolean' as const, required: false, default: false },
  ],
};

/** One read of a table: its headers, rows, controls and scroll — every assertion's input. */
function measure(table: Locator) {
  return table.evaluate((t) => {
    const rows = Array.from(t.querySelectorAll('tbody > tr:not(.row-table__notes)'));
    const box = (el: Element) => el.getBoundingClientRect();
    const scroller = t.parentElement!;
    const panel = t.closest<HTMLElement>('.property-panel')!;
    panel.scrollTop = 0;
    const visibleBottom = box(panel).top + panel.clientHeight;
    return {
      headers: Array.from(t.querySelectorAll('thead th'), (th) => th.textContent),
      rowHeights: rows.map((r) => Math.round(box(r).height)),
      controlHeights: rows.flatMap((r) =>
        Array.from(r.querySelectorAll('input:not([type=checkbox]), textarea, select'), (c) =>
          Math.round(box(c).height),
        ),
      ),
      // A cell's own label: still in the DOM as its control's name, never drawn.
      labelsDrawn: Array.from(t.querySelectorAll('tbody .labelled-control > label')).filter(
        (l) => box(l).width > 1 && box(l).height > 1,
      ).length,
      lastRowOverflow: Math.round(box(rows.at(-1)!).bottom - visibleBottom),
      scrolls: scroller.scrollWidth > scroller.clientWidth,
      narrowestCell: Math.min(
        ...Array.from(rows[0]!.querySelectorAll('td:not(.row-table__actions)'), (td) =>
          Math.round(box(td).width),
        ),
      ),
    };
  });
}

async function openMapping(page: Page): Promise<Locator> {
  await nodeById(page, 'c').click();
  const tabs = properties(page).getByRole('tablist', { name: 'Activity properties' });
  await tabs.getByRole('tab', { name: 'Mapping' }).click();
  return properties(page).getByRole('tabpanel', { name: 'Mapping' });
}

test('params are one compact table: headers once, a 32px row per param, nothing below the fold', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, 'or29 param table', seed);
  const table = properties(page).getByRole('table', { name: 'Parameters' });
  await expect(table.getByRole('textbox', { name: 'Parameter 3 name' })).toHaveValue('dry');

  const m = await measure(table);
  expect(m.headers).toEqual(['Name', 'Type', 'Required', 'Default', 'Description', 'Actions']);
  expect(m.rowHeights).toHaveLength(3);
  for (const h of m.rowHeights) expect(h).toBeLessThanOrEqual(32);
  for (const h of m.controlHeights) expect(h).toBe(28);
  expect(m.labelsDrawn).toBe(0);
  expect(m.lastRowOverflow).toBeLessThanOrEqual(0);
  expect(m.scrolls).toBe(false);
  await expectQuiet(page, problems);
});

test('a Copy mapping is one compact table, whole on its tab, with the row actions in reach', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, 'or29 mapping table', seed);
  const mapping = await openMapping(page);
  const table = mapping.getByRole('table', { name: 'mapping' });
  await expect(table.getByRole('textbox', { name: 'Column mapping row 3 source' })).toHaveValue(
    'amount',
  );

  const m = await measure(table);
  expect(m.headers.slice(0, 2)).toEqual(['Source', 'Sink']);
  expect(m.headers.at(-1)).toBe('Actions');
  // #1594 OR40 S4b-2 — every name in the table is words, not schema keys:
  // "Column mapping row 2 on error", "Move column mapping row 2 up".
  const names = await table.evaluate((t) => [
    ...Array.from(t.querySelectorAll('[aria-label]'), (el) => el.getAttribute('aria-label') ?? ''),
    // A cell's name is its visually hidden `<label>`.
    ...Array.from(t.querySelectorAll('tbody label'), (l) => l.textContent?.trim() ?? ''),
    ...Array.from(t.querySelectorAll('thead th'), (th) => th.textContent ?? ''),
  ]);
  expect(names).toContain('Column mapping row 2 on error');
  expect(names).toContain('Move column mapping row 2 up');
  expect(names.map((n) => [n, labelProblem(n)] as const).filter(([, p]) => p !== null)).toEqual([]);
  for (const h of m.rowHeights) expect(h).toBeLessThanOrEqual(32);
  for (const h of m.controlHeights) expect(h).toBe(28);
  expect(m.labelsDrawn).toBe(0);
  // The whole table — every row, and each row's Remove — without scrolling.
  expect(m.lastRowOverflow).toBeLessThanOrEqual(0);
  expect(m.scrolls).toBe(false);
  await expect(table.getByRole('button', { name: 'Remove column mapping row 3' })).toBeInViewport();

  // A cell's `${}` / `ƒx` are out of sight until the cell has focus; Tab from
  // the box reaches `${}` and shows it. Its list opens wider than the cell.
  const cell = table.getByRole('textbox', { name: 'Column mapping row 1 expression' });
  const toggles = cell.locator('xpath=..').locator('.expression-picker');
  const width = () => toggles.evaluate((el) => el.getBoundingClientRect().width);
  expect(await width()).toBeLessThanOrEqual(1);
  await cell.focus();
  expect(await width()).toBeGreaterThan(40);
  await page.keyboard.press('Tab');
  const refs = table.getByRole('button', {
    name: 'Insert reference into column mapping row 1 expression',
  });
  await expect(refs).toBeFocused();
  await refs.press('Enter');
  const list = mapping.locator('.expression-picker-list');
  await expect(list).toBeVisible();
  expect((await list.boundingBox())!.width).toBeGreaterThanOrEqual(280);
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expectQuiet(page, problems);
});

test('in the narrow right-hand dock a mapping scrolls sideways rather than crushing its cells', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, 'or29 mapping narrow', seed);
  await page.getByRole('button', { name: 'Dock to right' }).click();
  const mapping = await openMapping(page);
  const table = mapping.getByRole('table', { name: 'mapping' });
  await expect(table).toBeVisible();

  const m = await measure(table);
  expect(m.scrolls).toBe(true);
  expect(m.narrowestCell).toBeGreaterThanOrEqual(70);
  await expectQuiet(page, problems);
});
