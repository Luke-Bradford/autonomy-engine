import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';

/**
 * #1594 OR40 S3c — one form layout: a form row's label sits LEFT of its
 * control, in a 150px column, 12px before the control, once the form is at
 * least 400px wide — in the property dock (`property-dock-grid.spec.ts`), a
 * drawer, and a page's form (Settings, the Manage import panel), in both
 * densities. Rows are 8px apart; a checkbox, a sibling hint and an error line
 * up with the control column, and a checkbox's words sit 8px beside its box.
 */
test.use({ viewport: { width: 1440, height: 900 } });

type Density = 'compact' | 'comfortable';
const LABEL_COLUMN = 150;
const LABEL_GAP = 12;

async function setDensity(page: Page, density: Density) {
  await page.goto('/#/settings');
  await fluentRootReady(page);
  await page.getByRole('combobox', { name: 'Density', exact: true }).selectOption(density);
  await expect(page.locator('html')).toHaveAttribute('data-density', density);
}

/** Each named control's label and control boxes, in ONE evaluate. */
function rows(scope: Locator, ids: string[]) {
  return scope.evaluate((root, wanted) => {
    const box = (e: Element) => {
      const r = e.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
    };
    return wanted.map((name) => {
      const label = [...root.querySelectorAll('label')].find(
        (l) => l.textContent?.trim() === name,
      )!;
      const control = (label as HTMLLabelElement).control!;
      // A label with a `?` sits in a head row; the row is the field's.
      const row = label.closest('.labelled-control') ?? label.parentElement!;
      // What starts the control column: the control, or the box holding it
      // (a kind picker's icon and select).
      const cell = [...row.children].find((c) => c.contains(control))!;
      // A label with a `?` is measured as the pair: their head row is the
      // label column's item.
      const head = label.closest('.labelled-control__head') ?? label;
      return { name, label: box(head), control: box(control), cell: box(cell), row: box(row) };
    });
  }, ids);
}

type Row = Awaited<ReturnType<typeof rows>>[number];

function expectLabelLeft(where: string, row: Row) {
  const label = `${where} '${row.name}'`;
  expect(row.label.right, `${label}: label left of its control`).toBeLessThanOrEqual(row.cell.left);
  expect(row.cell.left - row.label.left, `${label}: label column + 12px`).toBeCloseTo(
    LABEL_COLUMN + LABEL_GAP,
    0,
  );
  // On the control's line: a one-line label is centred on it, and a long one
  // starts there and wraps inside its column.
  expect(Math.abs(row.label.top - row.cell.top), `${label}: on the control's line`).toBeLessThan(1);
  if (row.label.bottom - row.label.top < row.control.bottom - row.control.top + 1) {
    const labelMid = (row.label.top + row.label.bottom) / 2;
    const controlMid = (row.control.top + row.control.bottom) / 2;
    expect(Math.abs(labelMid - controlMid), `${label}: centred`).toBeLessThanOrEqual(1);
  }
}

for (const density of ['compact', 'comfortable'] as const) {
  test(`#1594 OR40 S3c — one form layout: drawer, fieldset, Settings, import (${density})`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const problems = collectPageProblems(page);
    await setDensity(page, density);

    // Settings: the pickers are label-left; the theme switch lines up with
    // their controls.
    const appearance = page.getByRole('region', { name: 'Appearance' });
    const [densityRow, zoneRow] = await rows(appearance, ['Density', 'Display time zone']);
    expectLabelLeft('Settings', densityRow!);
    expectLabelLeft('Settings', zoneRow!);
    expect(zoneRow!.row.top - densityRow!.row.bottom, 'Settings: rows 8px apart').toBeCloseTo(8, 0);
    // A select is sized by its options, not stretched across the page.
    expect(densityRow!.control.width, 'Settings: Density select').toBeLessThan(200);
    const switchLeft = await appearance
      .getByRole('switch', { name: 'Dark mode' })
      .evaluate((el) => el.closest('.settings-row')!.getBoundingClientRect().left);
    expect(switchLeft, 'Settings: theme switch at the control column').toBeCloseTo(
      densityRow!.cell.left,
      0,
    );

    // A page's import panel: the export file row. (Before the drawer, whose
    // edited form would hold a navigation away at its prompt.)
    await page.goto('/#/manage/connections');
    await fluentRootReady(page);
    const [file] = await rows(
      page.getByRole('region', { name: 'Import' }).locator('.field-form'),
      ['Export file'],
    );
    expectLabelLeft('Connections import', file!);

    // A secret drawer: the value row (input and Show in the control column).
    await page.goto('/#/manage/secrets');
    await fluentRootReady(page);
    await page.getByRole('button', { name: 'New secret' }).click();
    const secret = page.locator('.form-drawer-body');
    const [value] = await rows(secret, ['Value']);
    expectLabelLeft('Secret drawer', value!);
    await page.keyboard.press('Escape');
    await expect(secret).toHaveCount(0);

    // A drawer: a new trigger's Name and Mode, its Enabled checkbox, and a
    // field inside the recurrence builder's fieldset.
    await page.goto('/#/manage/triggers');
    await fluentRootReady(page);
    await page.getByRole('button', { name: /New trigger/i }).click();
    const drawer = page.locator('.form-drawer-body');
    await drawer.getByRole('combobox', { name: 'Mode', exact: true }).selectOption('schedule');
    await expect(drawer.locator('.recurrence-editor')).toBeVisible();
    const [name] = await rows(drawer, ['Name']);
    expectLabelLeft('Trigger drawer', name!);
    const [mode] = await rows(drawer, ['Mode']);
    expectLabelLeft('Trigger drawer', mode!);
    const [zone] = await rows(drawer.locator('.recurrence-editor'), [
      'Time zone (IANA, blank = UTC)',
    ]);
    expectLabelLeft('Recurrence fieldset', zone!);
    // Box, 8px, words — the words wrap beside the box rather than under it.
    const enabled = await drawer.getByRole('checkbox', { name: /^Enabled/ }).evaluate((el) => {
      const label = el.closest('label')!;
      const words = [...label.childNodes].find(
        (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim(),
      )!;
      const range = document.createRange();
      range.selectNodeContents(words);
      const box = el.getBoundingClientRect();
      return {
        left: label.getBoundingClientRect().left,
        boxRight: box.right,
        wordsLeft: Math.min(...[...range.getClientRects()].map((r) => r.left)),
      };
    });
    expect(enabled.left, 'Enabled: at the control column').toBeCloseTo(name!.cell.left, 0);
    expect(enabled.wordsLeft - enabled.boxRight, 'Enabled: box, 8px, words').toBeCloseTo(8, 0);

    // A note on a field's STATE stays a line (#1594 OR40 S3c-2), and lines up
    // with the control: a tumbling trigger's locked Concurrency says why.
    await drawer.getByRole('combobox', { name: 'Mode', exact: true }).selectOption('tumbling');
    const [concurrency] = await rows(drawer, ['Concurrency']);
    const noteLeft = await drawer
      .getByText(/^A tumbling trigger must use Queue/)
      .evaluate((el) => el.getBoundingClientRect().left);
    expect(noteLeft, 'Trigger drawer: a sibling note at the control column').toBeCloseTo(
      concurrency!.cell.left,
      0,
    );

    await expectQuiet(page, problems);
  });
}

test('#1594 OR40 S3c — a form narrower than 400px keeps the label over its control', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  // Beside its list a drawer is 460px (a 418px body) from a 960px window up;
  // under 960 it stacks below the list at the content column's width, which
  // a 700px window takes under 400.
  await page.setViewportSize({ width: 700, height: 900 });
  await page.goto('/#/manage/secrets');
  await fluentRootReady(page);
  await page.getByRole('button', { name: 'New secret' }).click();
  const drawer = page.locator('.form-drawer-body');
  const width = await drawer.evaluate((el) => el.clientWidth - 40);
  expect(width, 'the drawer body is under the 400px threshold').toBeLessThan(400);
  const [name] = await rows(drawer, ['Name']);
  expect(name!.label.bottom, 'Name: label over its control').toBeLessThanOrEqual(name!.control.top);
  // The word and its required `*` on one line (20px), not stacked (two lines).
  expect(name!.label.bottom - name!.label.top, 'Name: one line').toBeLessThan(30);
  await expectQuiet(page, problems);
});
