import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { nodeById, openSeededCanvas, rectOf } from './support/seedDoc';
import { dockPaste, properties } from './support/panels';

/**
 * #1477 OR29 slice 1 — the property dock is COMPACT by default (the UI
 * standard: 13px field text, 12px labels, 28px controls), comfortable is the
 * viewer's own setting, and the nothing-selected panel opens on its rows rather
 * than on a paragraph and a full-width Paste bar.
 *
 * Every number is read from the rendered page at 1440x900 — computed styles and
 * bounding boxes, not a screenshot.
 */

const seed = {
  nodes: [
    {
      id: 'a',
      type: 'http_request',
      position: { x: 0, y: 0 },
      config: { url: 'https://a.example.test' },
    },
  ],
  params: [{ name: 'topic', type: 'string' as const, required: true }],
};

/** One read of what the density rules decide, for a field and its label. */
function metrics(control: Locator) {
  return control.evaluate((el) => {
    const input = el as HTMLInputElement;
    const label = input.labels?.[0] ?? null;
    const heading = input.closest('.property-panel')?.querySelector('.form-section-title') ?? null;
    return {
      density: document.documentElement.dataset.density ?? null,
      fontSize: parseFloat(getComputedStyle(input).fontSize),
      height: input.getBoundingClientRect().height,
      labelFontSize: label === null ? null : parseFloat(getComputedStyle(label).fontSize),
      headingFontSize: heading === null ? null : parseFloat(getComputedStyle(heading).fontSize),
      headingTransform: heading === null ? null : getComputedStyle(heading).textTransform,
    };
  });
}

async function openNode(page: Page, name: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededCanvas(page, name, seed);
  await nodeById(page, 'a').click();
  return properties(page).getByRole('textbox', { name: 'Request URL', exact: true });
}

test.describe('#1477 OR29 — dock density', () => {
  test('is compact by default: 13px fields in 28px controls, 12px labels', async ({ page }) => {
    const problems = collectPageProblems(page);
    const url = await openNode(page, 'density compact');
    await expect(url).toBeVisible();

    const field = await metrics(url);
    expect(field.density).toBe('compact');
    expect(field.fontSize).toBe(13);
    expect(field.height).toBe(28);
    expect(field.labelFontSize).toBe(12);
    expect(field.headingFontSize).toBe(12);
    expect(field.headingTransform).toBe('uppercase');

    // Every single-line control in the panel shares the height, selects
    // included — not just the one field read above.
    const heights = await properties(page)
      .locator(
        'input:visible:not([type=checkbox], [type=radio], [type=range], [type=color], [type=file]), select:visible',
      )
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(1);
    expect(new Set(heights)).toEqual(new Set([28]));

    await expectQuiet(page, problems);
  });

  test('opens the pipeline panel on its rows: no prose, Paste in the header', async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSeededCanvas(page, 'density pipeline panel', seed);

    const panel = properties(page);
    const firstRow = panel.getByRole('textbox', { name: 'param 1 name' });
    await expect(firstRow).toHaveValue('topic');
    await expect(panel.getByText(/Select a node or an edge/)).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Paste' })).toHaveCount(0);
    await expect(dockPaste(page)).toBeVisible();

    // The ticket's bar: the first parameter row is at most 80px below the dock
    // header.
    const header = await rectOf(page, '.property-dock__header');
    // #1477 OR29 — the rows are a table now, and its header row is where the
    // row block starts (where the first row card used to): its first control
    // sits 19px under that, higher than a card's did under its "Name" label.
    const row = await panel.getByRole('table', { name: 'Params' }).boundingBox();
    expect(row).not.toBeNull();
    expect(row!.y - header.bottom).toBeLessThanOrEqual(80);

    // The section's help is one click away, not a paragraph on the page.
    const params = panel.getByRole('region', { name: 'Params', exact: true });
    await expect(params).toHaveAccessibleDescription(/typed inputs a run supplies/);
    await params.getByLabel('About Params').click();
    await expect(params.getByRole('note')).toBeVisible();

    await expectQuiet(page, problems);
  });

  test('comfortable, chosen in Settings, restores the roomier dock', async ({ page }) => {
    const problems = collectPageProblems(page);
    const url = await openNode(page, 'density comfortable');
    const compact = await metrics(url);

    await page.getByRole('link', { name: 'Settings' }).click();
    await page.getByRole('combobox', { name: 'Density', exact: true }).selectOption('comfortable');
    await page.goBack();
    await nodeById(page, 'a').click();

    const comfortable = await metrics(
      properties(page).getByRole('textbox', { name: 'Request URL', exact: true }),
    );
    expect(comfortable.density).toBe('comfortable');
    expect(comfortable.fontSize).toBeGreaterThan(compact.fontSize);
    expect(comfortable.height).toBeGreaterThan(compact.height);
    expect(comfortable.labelFontSize).toBeGreaterThan(compact.labelFontSize ?? 0);
    // None of the compact rules apply: the section titles are as they were.
    expect(comfortable.headingTransform).toBe('none');
    expect(comfortable.headingFontSize).toBeGreaterThan(compact.headingFontSize ?? 0);

    // Per viewer: it survives a reload.
    await page.reload();
    expect(await page.evaluate(() => document.documentElement.dataset.density)).toBe('comfortable');

    await expectQuiet(page, problems);
  });
});
