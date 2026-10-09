import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';

/**
 * #1594 OR40 S3c — one form layout: a form row's label sits LEFT of its
 * control, in a 150px column, 12px before the control, once the form is at
 * least 400px wide — in the property dock (`property-dock-grid.spec.ts`), a
 * drawer, and a page's form (Settings, the Manage import panel), in both
 * densities. Rows are 8px apart; a checkbox, a sibling hint and an error line
 * up with the control column, and a checkbox is never stretched.
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
      return { name, label: box(label), control: box(control), row: box(label.parentElement!) };
    });
  }, ids);
}

type Row = Awaited<ReturnType<typeof rows>>[number];

function expectLabelLeft(where: string, row: Row) {
  const label = `${where} '${row.name}'`;
  expect(row.label.right, `${label}: label left of its control`).toBeLessThanOrEqual(
    row.control.left,
  );
  expect(row.control.left - row.label.left, `${label}: label column + 12px`).toBeCloseTo(
    LABEL_COLUMN + LABEL_GAP,
    0,
  );
  const labelMid = (row.label.top + row.label.bottom) / 2;
  const controlMid = (row.control.top + row.control.bottom) / 2;
  expect(Math.abs(labelMid - controlMid), `${label}: one line`).toBeLessThanOrEqual(3);
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
      densityRow!.control.left,
      0,
    );

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
    const enabled = await drawer.getByRole('checkbox', { name: /^Enabled/ }).evaluate((el) => {
      const label = el.closest('label')!;
      const text = document.createRange();
      text.selectNodeContents(label);
      return {
        left: label.getBoundingClientRect().left,
        width: label.getBoundingClientRect().width,
        box: el.getBoundingClientRect().width,
        contentRight: Math.max(
          ...[...label.childNodes].map((n) => {
            const r = document.createRange();
            r.selectNodeContents(n);
            return n.nodeType === Node.TEXT_NODE
              ? r.getBoundingClientRect().right
              : (n as Element).getBoundingClientRect().right;
          }),
        ),
      };
    });
    expect(enabled.left, 'Enabled: at the control column').toBeCloseTo(name!.control.left, 0);
    expect(enabled.left + enabled.width, 'Enabled: never stretched').toBeLessThanOrEqual(
      enabled.contentRight + 1,
    );

    // A page's import panel: the export file row.
    await page.goto('/#/manage/connections');
    await fluentRootReady(page);
    const [file] = await rows(page.locator('section.field-form'), ['Export file']);
    expectLabelLeft('Connections import', file!);

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
  await expectQuiet(page, problems);
});
