import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import {
  computedStyles as styles,
  CONTROL_H,
  DENSITIES,
  DESIGN_RUNS,
  expectAppearance,
  PAD,
  pads,
  preferAppearance,
} from './support/appearance';
import { triggerForm } from './support/panels';
import { chooseRowAction } from './support/rowMenu';
import { IF_FOREACH_THEN_FAIL, seedVersion } from './support/seedDoc';
import { seedConnection, seedDataset } from './support/seedResources';
import { fluentRootReady } from './support/theme';
import { offRampText } from './support/typeRamp';

/**
 * #1594 OR40 S6q — the side drawers and the confirmation dialog on the design
 * system, at 1440x900 in compact light and comfortable dark: the drawer chrome
 * (its header row, body, sticky footer and the alert in it), the trigger form's
 * bordered groups (a run window and its days), the Trigger now drawer, and a
 * typed-name confirmation.
 *
 * Measured: all their text on the type ramp, and their spacing on the 4px
 * scale at the values below. The header is the page header's 40px row.
 */

type Density = (typeof DENSITIES)[number];

/** The drawer's header row: its height, and the Close button's centre against the title's. */
function headerRow(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector('.form-drawer-header')!;
    const mid = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    };
    return {
      height: Math.round(header.getBoundingClientRect().height),
      offCentre: Math.abs(mid(header.querySelector('h2')!) - mid(header.querySelector('button')!)),
    };
  });
}

/** The drawer chrome's computed values, shared by every drawer. */
async function expectDrawerChrome(page: Page, d: Density): Promise<void> {
  const chrome = await styles(
    page,
    ['.form-drawer', '.form-drawer-header', '.form-drawer-body', '.form-drawer-footer'],
    [...PAD, 'column-gap', 'border-top-left-radius', 'border-bottom-right-radius'],
  );
  expect(chrome['.form-drawer']).toMatchObject({ 'border-top-left-radius': '6px' });
  expect(chrome['.form-drawer-header']).toMatchObject({ ...pads(0, 16), 'column-gap': '8px' });
  expect(chrome['.form-drawer-body']).toMatchObject(pads(16, 16));
  expect(chrome['.form-drawer-footer']).toMatchObject({
    ...pads(8, 16),
    'border-bottom-right-radius': '6px',
  });
  // A resource form has no box of its own: the drawer is its panel.
  const form = await styles(
    page,
    ['.form-drawer > form'],
    ['padding-top', 'margin-top', 'border-top-width', 'max-width'],
  );
  expect(form['.form-drawer > form'] ?? {}).toMatchObject({
    'padding-top': '0px',
    'margin-top': '0px',
    'border-top-width': '0px',
    'max-width': 'none',
  });
  // The header is the page header's row, with its Close button centred on the title.
  const row = await headerRow(page);
  expect(row.height, 'drawer header: one 40px row').toBe(40);
  expect(row.offCentre, 'drawer header: Close centred on the title').toBeLessThanOrEqual(1);
  const close = await page.locator('.form-drawer-header button').boundingBox();
  expect(Math.round(close?.height ?? 0)).toBe(CONTROL_H[d]);
  expect(await offRampText(page, d, '.form-drawer'), 'drawer: ramp').toEqual([]);
}

for (const { density, theme } of DESIGN_RUNS) {
  const d = density as Density;

  test(`#1594 OR40 S6q — the drawers and the confirmation dialog on the ramp and the scale (${density} ${theme})`, async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await preferAppearance(page, theme, d);

    // --- Manage → Triggers → New trigger: a run window with its days --------
    await page.goto('/#/manage/triggers');
    await page.getByRole('heading', { name: 'Triggers' }).waitFor();
    await fluentRootReady(page);
    await expectAppearance(page, theme, d);
    await page.getByRole('button', { name: /New trigger/i }).click();
    const form = triggerForm(page);
    await form.getByLabel(/^Mode/).selectOption('schedule');
    await form.getByRole('button', { name: 'Add window' }).click();
    const window1 = form.getByRole('group', { name: 'Window 1' });
    await window1.getByRole('checkbox', { name: /Only on selected days/ }).check();
    await expect(window1.getByRole('checkbox', { name: 'Mon' })).toBeVisible();

    await expectDrawerChrome(page, d);
    const groups = await styles(
      page,
      ['.drawer-layout-open > :first-child', '.run-window-row', '.run-window-row .recurrence-days'],
      [...PAD, 'margin-left', 'row-gap', 'column-gap', 'border-top-left-radius'],
    );
    // The list's column keeps a 4px ring margin, cancelled by its own margin.
    expect(groups['.drawer-layout-open > :first-child']).toMatchObject({
      ...pads(4, 4),
      'margin-left': '-4px',
    });
    // A run window is the one bordered group.
    expect(groups['.run-window-row']).toMatchObject({
      ...pads(8, 12),
      'row-gap': '8px',
      'border-top-left-radius': '6px',
    });
    expect(groups['.run-window-row .recurrence-days']).toMatchObject({
      'row-gap': '4px',
      'column-gap': '16px',
    });

    // A refused Create: the footer's alert, its lines on the scale.
    await form.getByRole('button', { name: /Create trigger/i }).click();
    await expect(form.getByRole('alert')).toBeVisible();
    const errors = await styles(
      page,
      ['.form-errors', '.form-errors p', '.form-errors ul'],
      ['margin-bottom', 'padding-left'],
    );
    expect(errors['.form-errors']).toMatchObject({ 'margin-bottom': '8px' });
    expect(errors['.form-errors p']).toMatchObject({ 'margin-bottom': '4px' });
    expect(errors['.form-errors ul']).toMatchObject({ 'padding-left': '16px' });
    expect(await offRampText(page, d, '.form-drawer'), 'drawer with its alert: ramp').toEqual([]);
    // Closed through the app, not left open under a navigation: an edited form
    // guards the route, and a hash change outside the router warns.
    await page.locator('.form-drawer-header').getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await expect(form).toHaveCount(0);

    // --- Pipelines → ⋯ → Trigger now… ---------------------------------------
    const name = `e2e_s6q_${density}`;
    await seedVersion(page, name, IF_FOREACH_THEN_FAIL);
    await page.goto('/#/author/pipelines');
    await page.getByRole('heading', { name: 'Pipelines' }).waitFor();
    await fluentRootReady(page);
    const row = page
      .getByRole('row')
      .filter({ has: page.getByRole('link', { name: `Open ${name}`, exact: true }) });
    await chooseRowAction(row, 'Trigger now…', name);
    const runDrawer = page.getByRole('dialog', { name: `Trigger now — ${name}` });
    await expect(runDrawer).toBeVisible();
    await expectDrawerChrome(page, d);
    await runDrawer.getByRole('button', { name: 'Close' }).click();
    await expect(runDrawer).toHaveCount(0);

    // --- A typed-name confirmation ------------------------------------------
    const conn = `e2e_s6q_conn_${density}`;
    const connectionId = await seedConnection(page, {
      name: conn,
      kind: 'sqlite',
      config: { file: '/tmp/e2e-s6q.db' },
    });
    await seedDataset(page, {
      name: `${conn}-orders`,
      kind: 'table',
      connectionId,
      config: { table: 'orders' },
      columns: [{ name: 'id', type: 'integer', nullable: false }],
    });
    await page.goto('/#/manage/connections');
    await page.getByRole('heading', { name: 'Connections' }).waitFor();
    await fluentRootReady(page);
    await chooseRowAction(page.getByRole('row', { name: new RegExp(conn) }), 'Delete');
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByRole('textbox')).toBeFocused();

    const confirm = await styles(
      page,
      ['.confirm-dialog-paragraph', '.confirm-dialog-typed'],
      ['margin-bottom', 'margin-top', 'row-gap'],
    );
    expect(confirm['.confirm-dialog-paragraph']).toMatchObject({ 'margin-bottom': '8px' });
    expect(confirm['.confirm-dialog-typed']).toMatchObject({
      'margin-top': '12px',
      'row-gap': '4px',
    });
    expect(await offRampText(page, d, '.confirm-dialog'), 'confirm dialog: ramp').toEqual([]);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);

    await expectQuiet(page, problems);
  });
}
