import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { nodeById, openSeededCanvas } from './support/seedDoc';
import { properties } from './support/panels';

/**
 * #1477 OR29 slice 3 — in the property dock, at compact density, a field's
 * label sits LEFT of its control once the tab is at least 576px wide, short
 * fields (choices, numbers, checkboxes) pack two or three to a row in their
 * schema order, and every control is sized by its type rather than stretched.
 * Measured at the operator's 1440×900.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const seed = {
  nodes: [{ id: 'l', type: 'llm_call', position: { x: 0, y: 0 }, config: { prompt: 'Hello' } }],
};

/** One read of a field's geometry: its label's box, its control's, its cell's and its grid's. */
function geometryOf(control: Locator) {
  return control.evaluate((el) => {
    const box = (e: Element | null) => {
      const r = e!.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
    };
    const input = el as HTMLInputElement | HTMLSelectElement;
    return {
      label: box(input.labels![0]!),
      control: box(el),
      cell: box(el.closest('.config-cell')),
      grid: box(el.closest('.config-editor')),
      tabWidth: el.closest('.panel-tab')!.getBoundingClientRect().width,
    };
  });
}

/**
 * Every visible select in the dock: its width, and the widest of its options'
 * text at the select's own font — what "sized to its longest option" means.
 */
function selectWidths(page: Page) {
  return properties(page).evaluate((panel) => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    return Array.from(panel.querySelectorAll('select'))
      .filter((s) => s.getClientRects().length > 0)
      .map((s) => {
        ctx.font = getComputedStyle(s).font;
        const longest = Math.max(...Array.from(s.options, (o) => ctx.measureText(o.text).width));
        return {
          name: s.labels?.[0]?.textContent ?? s.getAttribute('aria-label'),
          width: s.getBoundingClientRect().width,
          longest,
        };
      });
  });
}

const modelTab = (page: Page) => properties(page).getByRole('tabpanel', { name: 'Model' });

async function openLlm(page: Page, name: string): Promise<void> {
  await openSeededCanvas(page, name, seed);
  await nodeById(page, 'l').click();
  await expect(modelTab(page)).toBeVisible();
}

test('a wide dock puts labels left and packs short fields into a row, in order', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await openLlm(page, 'or29 grid wide');
  const tab = modelTab(page);
  const tokens = await geometryOf(tab.getByRole('textbox', { name: 'Max output tokens' }));
  const temperature = await geometryOf(tab.getByRole('textbox', { name: 'Temperature' }));
  const topP = await geometryOf(tab.getByRole('textbox', { name: 'Top P' }));
  const model = await geometryOf(tab.getByRole('textbox', { name: 'Model for this step' }));

  // At 1440 the bottom dock shares its width with Problems: two to a row.
  expect(tokens.tabWidth).toBeGreaterThanOrEqual(576);
  expect(tokens.tabWidth).toBeLessThan(900);
  // Two numbers on a row in schema order, the third starting the next.
  expect(Math.abs(temperature.control.top - tokens.control.top)).toBeLessThanOrEqual(1);
  expect(tokens.cell.right).toBeLessThan(temperature.cell.left);
  expect(topP.control.top).toBeGreaterThan(tokens.control.bottom);
  expect(Math.round(topP.cell.left)).toBe(Math.round(tokens.cell.left));
  // A free-text field spans the grid.
  expect(Math.round(model.cell.width)).toBe(Math.round(model.grid.width));
  // Label left of its control, on the same line.
  for (const field of [tokens, model]) {
    expect(field.label.right).toBeLessThanOrEqual(field.control.left);
    const labelMid = (field.label.top + field.label.bottom) / 2;
    const controlMid = (field.control.top + field.control.bottom) / 2;
    expect(Math.abs(labelMid - controlMid)).toBeLessThanOrEqual(3);
  }
  // Sized by type: a number is 120px, free text takes what is left of its row.
  expect(Math.round(tokens.control.width)).toBe(120);
  expect(model.control.width).toBeGreaterThan(350);

  // At 1920 the tab is wide enough for three to a row; never four.
  await page.setViewportSize({ width: 1920, height: 900 });
  const tabWidth = () => tab.evaluate((el) => el.getBoundingClientRect().width);
  await expect.poll(tabWidth).toBeGreaterThanOrEqual(900);
  const wide = await Promise.all(
    ['Max output tokens', 'Temperature', 'Top P'].map((name) =>
      geometryOf(tab.getByRole('textbox', { name })),
    ),
  );
  expect(wide[0]!.tabWidth).toBeGreaterThanOrEqual(900);
  for (const field of wide)
    expect(Math.round(field.control.top)).toBe(Math.round(wide[0]!.control.top));
  expect(wide[2]!.cell.right).toBeLessThanOrEqual(wide[2]!.grid.right + 1);
  expect(wide[2]!.cell.right).toBeGreaterThan(wide[2]!.grid.right - 2);
  await expectQuiet(page, problems);
});

test('every select is as wide as its longest option, not the row', async ({ page }) => {
  const problems = collectPageProblems(page);
  await openLlm(page, 'or29 grid selects');
  const selects = await selectWidths(page);
  // Reasoning effort, at least. (The connection picker is a Fluent combobox
  // since OR29 slice 5c, so it is not a native select; this count was held at
  // two by the Container membership select until #1597 removed it.)
  expect(selects.map((s) => s.name)).toContainEqual(expect.stringMatching(/^Reasoning effort/));
  for (const select of selects) {
    expect(select.width, `${select.name}`).toBeLessThanOrEqual(Math.min(select.longest + 40, 320));
  }
  await expectQuiet(page, problems);
});

test('a narrow dock, or comfortable density, keeps the label over its control', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await openLlm(page, 'or29 grid narrow');
  await page.getByRole('button', { name: 'Dock to right' }).click();
  await expect
    .poll(() => modelTab(page).evaluate((el) => el.getBoundingClientRect().width))
    .toBeLessThan(576);
  const narrow = await geometryOf(
    modelTab(page).getByRole('textbox', { name: 'Max output tokens' }),
  );
  expect(narrow.tabWidth).toBeLessThan(576);
  expect(narrow.label.bottom).toBeLessThanOrEqual(narrow.control.top);
  await page.getByRole('button', { name: 'Dock to bottom' }).click();

  // Wide enough that the tab clears 576px with room to spare, so the label
  // staying over its control below is the density's doing and not the width's.
  // (#1594 OR40 S3 gave the editor the one 16px content frame, and at 1440 a
  // comfortable tab now measures 573px.)
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('combobox', { name: 'Density', exact: true }).selectOption('comfortable');
  await page.goBack();
  await nodeById(page, 'l').click();
  await expect(modelTab(page)).toBeVisible();
  const comfortable = await geometryOf(
    modelTab(page).getByRole('textbox', { name: 'Max output tokens' }),
  );
  expect(comfortable.tabWidth).toBeGreaterThanOrEqual(576);
  expect(comfortable.label.bottom).toBeLessThanOrEqual(comfortable.control.top);
  await expectQuiet(page, problems);
});

test('the General tab packs its two numbers onto one row, and its two flags onto the next', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await openLlm(page, 'or29 grid general');
  await properties(page).getByRole('tab', { name: 'General' }).click();
  const general = properties(page).getByRole('tabpanel', { name: 'General' });
  const retries = await geometryOf(general.getByRole('textbox', { name: 'Retries' }));
  const interval = await geometryOf(
    general.getByRole('textbox', { name: 'Retry interval (seconds)' }),
  );
  const secureIn = await geometryOf(general.getByRole('checkbox', { name: 'Secure input' }));
  const secureOut = await geometryOf(general.getByRole('checkbox', { name: 'Secure output' }));

  expect(retries.tabWidth).toBeGreaterThanOrEqual(576);
  expect(Math.abs(interval.control.top - retries.control.top)).toBeLessThanOrEqual(1);
  expect(retries.cell.right).toBeLessThan(interval.cell.left);
  expect(Math.abs(secureOut.control.top - secureIn.control.top)).toBeLessThanOrEqual(1);
  expect(secureIn.cell.right).toBeLessThan(secureOut.cell.left);
  expect(secureIn.control.top).toBeGreaterThan(retries.control.bottom);
  expect(Math.round(retries.control.width)).toBe(120);
  await expectQuiet(page, problems);
});

test('a ForEach container shows Items · Concurrency · Settings tabs, and packs Concurrency', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, 'or29 grid foreach', {
    nodes: [{ id: 'n_a', type: 'llm_call', position: { x: 40, y: 40 }, config: { prompt: 'Hi' } }],
    containers: [{ id: 'fe', kind: 'foreach', children: ['n_a'], items: '${createArray(1, 2)}' }],
  });
  await page.getByRole('button', { name: 'Configure ForEach 1' }).click();
  const panel = properties(page);
  // By accessible name: Fluent draws a tab's label twice (once hidden, for its width).
  await expect(panel.getByRole('tab')).toHaveCount(3);
  for (const [i, name] of ['Items', 'Concurrency', 'Settings'].entries())
    await expect(panel.getByRole('tab').nth(i)).toHaveAccessibleName(name);
  await expect(panel.getByRole('textbox', { name: /^Items/ })).toHaveValue('${createArray(1, 2)}');

  await panel.getByRole('tab', { name: 'Concurrency' }).click();
  const tab = panel.getByRole('tabpanel', { name: 'Concurrency' });
  const batch = await geometryOf(tab.getByRole('textbox', { name: /^Batch count/ }));
  const unordered = await geometryOf(
    tab.getByRole('checkbox', { name: 'Allow unordered variable writes' }),
  );
  expect(batch.tabWidth).toBeGreaterThanOrEqual(576);
  expect(batch.label.right).toBeLessThanOrEqual(batch.control.left);
  expect(batch.cell.right).toBeLessThan(unordered.cell.left);
  expect(Math.abs(unordered.cell.top - batch.cell.top)).toBeLessThanOrEqual(1);
  await expect(panel.getByRole('textbox', { name: /^Items/ })).toBeHidden();
  await expectQuiet(page, problems);
});
